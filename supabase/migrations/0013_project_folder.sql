-- A project's shared folder: one folder on the host's computer that members (and the AI in project chats) can read.
--
-- The folder itself is never uploaded. The host's desktop app serves it through the chat server, which relays
-- requests and checks permissions. This table only records that a folder is shared, what to call it, and whether
-- the host's app is connected right now. The path on the host's computer is not stored here or anywhere else on
-- the server.
--
--   * Members READ the row through RLS (it also drives the live "online / offline" badge via realtime).
--   * Only the server writes, through the app_folder_* functions below (service role only).

create table public.project_folders (
  project_id uuid primary key references public.projects (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  linked_by uuid not null references public.profiles (id),
  linked_at timestamptz not null default now(),
  -- true while the host's desktop app is connected to the server. Set by the server only.
  online boolean not null default false
);

alter table public.project_folders enable row level security;
create policy project_folders_select on public.project_folders for select to authenticated using (public.is_project_member(project_id));
revoke all on public.project_folders from anon, authenticated;
grant select on public.project_folders to authenticated;

alter publication supabase_realtime add table public.project_folders;

-- ================================================================== server-only functions (service role)

-- The host shares (or re-points) the project's folder. One folder per project; only the host.
create function public.app_link_folder(p_user uuid, p_project uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
begin
  if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  if public.project_role_of(p_user, p_project) <> 'host' then raise exception 'forbidden'; end if;
  if char_length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then raise exception 'invalid_name'; end if;
  insert into public.project_folders (project_id, name, linked_by) values (p_project, v_name, p_user)
  on conflict (project_id) do update set name = excluded.name, linked_by = excluded.linked_by, linked_at = now(), online = false;
end;
$$;

create function public.app_unlink_folder(p_user uuid, p_project uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  if public.project_role_of(p_user, p_project) <> 'host' then raise exception 'forbidden'; end if;
  delete from public.project_folders where project_id = p_project;
end;
$$;

-- Any member of the project may read the folder (through the server). Returns its name.
create function public.app_folder_member_check(p_user uuid, p_project uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_name text;
begin
  if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  select name into v_name from public.project_folders where project_id = p_project;
  if v_name is null then raise exception 'not_linked'; end if;
  return v_name;
end;
$$;

-- Only the host's app may serve the folder. Returns its name.
create function public.app_folder_host_check(p_user uuid, p_project uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_name text;
begin
  if public.project_role_of(p_user, p_project) is distinct from 'host' then raise exception 'forbidden'; end if;
  select name into v_name from public.project_folders where project_id = p_project;
  if v_name is null then raise exception 'not_linked'; end if;
  return v_name;
end;
$$;

-- The server marks the folder online while the host's app is connected, offline otherwise.
create function public.app_folder_set_online(p_project uuid, p_online boolean) returns void
language sql security definer set search_path = '' as $$
  update public.project_folders set online = p_online where project_id = p_project and online is distinct from p_online
$$;

-- After a server restart no host app is connected yet.
create function public.app_folders_all_offline() returns void
language sql security definer set search_path = '' as $$
  update public.project_folders set online = false where online
$$;

revoke execute on function
  public.app_link_folder(uuid, uuid, text), public.app_unlink_folder(uuid, uuid), public.app_folder_member_check(uuid, uuid),
  public.app_folder_host_check(uuid, uuid), public.app_folder_set_online(uuid, boolean), public.app_folders_all_offline()
  from public, anon, authenticated;
grant execute on function
  public.app_link_folder(uuid, uuid, text), public.app_unlink_folder(uuid, uuid), public.app_folder_member_check(uuid, uuid),
  public.app_folder_host_check(uuid, uuid), public.app_folder_set_online(uuid, boolean), public.app_folders_all_offline()
  to service_role;
