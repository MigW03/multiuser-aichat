-- Per-owner sharing: every person who serves files in a project (host, admins, and members with the host's or an
-- admin's approval) shares their own folders and files, and each item has its own owner and status.
--
-- This replaces the single `project_folders` row of 0013. The files themselves are still never uploaded: each owner's
-- desktop app serves its own items through the chat server. These tables only record what is shared, who shares it,
-- whether it was approved, and whether that owner's app is connected. Paths on anyone's computer are not stored.
--
--   * project_share_hosts: one row per (project, owner). `online` is set by the server while that owner's app is connected.
--   * project_shares: one row per shared item. `item_key` is the app's own random id for it (never a path), `name` is
--     what the project sees and is unique in the project, `status` is 'pending' until the host or an admin approves a
--     member's request.
--
-- Members read the rows through RLS (they drive the live dots and the request cards via realtime); only the server writes.

-- A name is one path segment: 1 to 80 characters, no slashes, not "." or "..", no control or direction-changing characters.
create function public.project_share_name_ok(p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select p_name is not null
    and char_length(p_name) between 1 and 80
    and p_name !~ '[[:cntrl:]/\\]'
    and p_name !~ E'[\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]'
    and p_name not in ('.', '..')
$$;
revoke execute on function public.project_share_name_ok(text) from public, anon, authenticated;

create table public.project_share_hosts (
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  online boolean not null default false,
  linked_at timestamptz not null default now(),
  primary key (project_id, owner_id)
);

create table public.project_shares (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  item_key text not null check (char_length(item_key) between 1 and 64),
  name text not null check (public.project_share_name_ok(name)),
  kind text not null check (kind in ('dir', 'file')),
  status text not null default 'active' check (status in ('pending', 'active')),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id) on delete set null,
  unique (project_id, owner_id, item_key)
);
create unique index project_shares_name on public.project_shares (project_id, lower(name));

alter table public.project_share_hosts enable row level security;
alter table public.project_shares enable row level security;

create policy project_share_hosts_select on public.project_share_hosts for select to authenticated using (public.is_project_member(project_id));
-- Approved items are visible to every member. A request is visible to the person who made it and to the people who decide on it.
create policy project_shares_select on public.project_shares for select to authenticated
  using (
    public.is_project_member(project_id)
    and (
      status = 'active'
      or owner_id = (select auth.uid())
      or exists (
        select 1 from public.project_members pm
        where pm.project_id = project_shares.project_id and pm.user_id = (select auth.uid()) and pm.role in ('host', 'admin')
      )
    )
  );

revoke all on public.project_share_hosts, public.project_shares from anon, authenticated;
grant select on public.project_share_hosts, public.project_shares to authenticated;
alter publication supabase_realtime add table public.project_share_hosts, public.project_shares;

-- What 0013 had: one folder per project, shared by the host. Its owner becomes a (currently offline) owner row. The
-- items are not known here (only a summary name was kept), so the owner's app reports them when it next connects.
insert into public.project_share_hosts (project_id, owner_id, online, linked_at)
  select project_id, linked_by, false, linked_at from public.project_folders;

drop function public.app_link_folder(uuid, uuid, text);
drop function public.app_unlink_folder(uuid, uuid);
drop function public.app_folder_member_check(uuid, uuid);
drop function public.app_folder_host_check(uuid, uuid);
drop function public.app_folder_set_online(uuid, boolean);
drop function public.app_folders_all_offline();
drop table public.project_folders;

-- A person who leaves (or is removed from) a project stops sharing in it.
create function public.project_share_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.project_shares where project_id = old.project_id and owner_id = old.user_id;
  delete from public.project_share_hosts where project_id = old.project_id and owner_id = old.user_id;
  return old;
end;
$$;
create trigger project_members_share_cleanup after delete on public.project_members
  for each row execute function public.project_share_cleanup();
revoke execute on function public.project_share_cleanup() from public, anon, authenticated;

-- ------------------------------------------------ functions the server calls (service role only)

-- An app asks to connect for its owner. Any member may; what they may serve is decided in app_share_sync. Returns their role.
create function public.app_share_connect(p_user uuid, p_project uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.project_role_of(p_user, p_project);
begin
  if v_role is null then raise exception 'not_found'; end if;
  insert into public.project_share_hosts (project_id, owner_id) values (p_project, p_user) on conflict do nothing;
  return v_role;
end;
$$;

-- The owner's app reports every item it has (a random id for each, a suggested name, folder or file). The project's
-- list for that owner becomes exactly that: new items are added (approved at once for the host and admins, pending
-- for members), items no longer reported are removed, names that are already taken in the project get " (2)" and so on.
-- Returns what the project now calls each item and where its approval stands.
create function public.app_share_sync(p_user uuid, p_project uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.project_role_of(p_user, p_project);
  v_item jsonb;
  v_key text;
  v_kind text;
  v_base text;
  v_name text;
  v_n int;
  v_keys text[];
  v_status text;
  v_max constant int := 20;
  v_max_requests constant int := 5;
begin
  if v_role is null then raise exception 'not_found'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > v_max then raise exception 'invalid_items'; end if;
  insert into public.project_share_hosts (project_id, owner_id) values (p_project, p_user) on conflict do nothing;

  -- Items no longer reported go first, so swapping one for another never trips the limit.
  v_keys := coalesce(array(select e ->> 'key' from jsonb_array_elements(p_items) e), '{}');
  delete from public.project_shares where project_id = p_project and owner_id = p_user and not (item_key = any (v_keys));

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_key := v_item ->> 'key';
    v_kind := v_item ->> 'kind';
    v_base := left(trim(coalesce(v_item ->> 'name', '')), 80);
    if v_key is null or char_length(v_key) not between 1 and 64 or v_kind not in ('dir', 'file') or not public.project_share_name_ok(v_base) then
      raise exception 'invalid_items';
    end if;
    if exists (select 1 from public.project_shares where project_id = p_project and owner_id = p_user and item_key = v_key) then
      update public.project_shares set kind = v_kind where project_id = p_project and owner_id = p_user and item_key = v_key and kind <> v_kind;
      continue;
    end if;
    -- At most 20 approved items in a project, and a member can only have a few requests waiting, so requests can't crowd out real items.
    v_status := case when v_role in ('host', 'admin') then 'active' else 'pending' end;
    if v_status = 'active' and (select count(*) from public.project_shares where project_id = p_project and status = 'active') >= v_max then raise exception 'too_many'; end if;
    if v_status = 'pending' and (select count(*) from public.project_shares where project_id = p_project and owner_id = p_user and status = 'pending') >= v_max_requests then raise exception 'too_many_requests'; end if;
    v_name := v_base;
    v_n := 2;
    while exists (select 1 from public.project_shares where project_id = p_project and lower(name) = lower(v_name)) loop
      v_name := left(v_base, 80 - char_length(format(' (%s)', v_n))) || format(' (%s)', v_n);
      v_n := v_n + 1;
    end loop;
    insert into public.project_shares (project_id, owner_id, item_key, name, kind, status)
      values (p_project, p_user, v_key, v_name, v_kind, v_status);
  end loop;

  return coalesce((select jsonb_agg(jsonb_build_object('key', item_key, 'name', name, 'status', status) order by created_at, id)
                   from public.project_shares where project_id = p_project and owner_id = p_user), '[]'::jsonb);
end;
$$;

-- The host or an admin answers a member's request. Approving makes the item readable by the project; declining removes it.
-- Returns the owner, so the server can tell their app.
create function public.app_share_decide(p_user uuid, p_project uuid, p_share uuid, p_approve boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.project_role_of(p_user, p_project);
  v_owner uuid;
begin
  if v_role is null then raise exception 'not_found'; end if;
  if v_role not in ('host', 'admin') then raise exception 'forbidden'; end if;
  select owner_id into v_owner from public.project_shares where id = p_share and project_id = p_project and status = 'pending';
  if v_owner is null then raise exception 'not_found'; end if;
  if p_approve and (select count(*) from public.project_shares where project_id = p_project and status = 'active') >= 20 then raise exception 'too_many'; end if;
  if p_approve then
    update public.project_shares set status = 'active', decided_by = p_user where id = p_share;
  else
    delete from public.project_shares where id = p_share;
  end if;
  return v_owner;
end;
$$;

-- Stops sharing one item: its owner may, and so may the host and admins. Returns the owner.
create function public.app_share_remove(p_user uuid, p_project uuid, p_share uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.project_role_of(p_user, p_project);
  v_owner uuid;
begin
  if v_role is null then raise exception 'not_found'; end if;
  select owner_id into v_owner from public.project_shares where id = p_share and project_id = p_project;
  if v_owner is null then raise exception 'not_found'; end if;
  if v_owner <> p_user and v_role not in ('host', 'admin') then raise exception 'forbidden'; end if;
  delete from public.project_shares where id = p_share;
  return v_owner;
end;
$$;

-- The permission check for every read: the caller belongs to the project and at least one item is approved.
-- Returns how many approved items there are.
create function public.app_share_member_check(p_user uuid, p_project uuid) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  select count(*) into v_count from public.project_shares where project_id = p_project and status = 'active';
  if v_count = 0 then raise exception 'not_linked'; end if;
  return v_count;
end;
$$;

-- The server marks an owner online while their app is connected, offline otherwise.
create function public.app_share_set_online(p_project uuid, p_owner uuid, p_online boolean) returns void
language sql security definer set search_path = '' as $$
  update public.project_share_hosts set online = p_online where project_id = p_project and owner_id = p_owner and online is distinct from p_online
$$;

-- After a server restart no app is connected yet.
create function public.app_shares_all_offline() returns void
language sql security definer set search_path = '' as $$
  update public.project_share_hosts set online = false where online
$$;

revoke execute on function
  public.app_share_connect(uuid, uuid), public.app_share_sync(uuid, uuid, jsonb), public.app_share_decide(uuid, uuid, uuid, boolean),
  public.app_share_remove(uuid, uuid, uuid), public.app_share_member_check(uuid, uuid), public.app_share_set_online(uuid, uuid, boolean),
  public.app_shares_all_offline()
  from public, anon, authenticated;
grant execute on function
  public.app_share_connect(uuid, uuid), public.app_share_sync(uuid, uuid, jsonb), public.app_share_decide(uuid, uuid, uuid, boolean),
  public.app_share_remove(uuid, uuid, uuid), public.app_share_member_check(uuid, uuid), public.app_share_set_online(uuid, uuid, boolean),
  public.app_shares_all_offline()
  to service_role;
