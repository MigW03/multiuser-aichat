-- The link between a Nido project and a Supabase project (the Supabase tab of the Files card).
--
--   * Public facts only: the Supabase project's reference, name and region. No keys, tokens or URLs with secrets.
--     What a person sees of the Supabase project comes through their OWN Supabase connection (their MCP servers), so
--     the link alone gives nobody any access to it.
--   * RLS is on with no policies and the client roles have no grants: only the server (service role) reads or writes
--     this table, like user_mcp_servers. The page gets the link from the server.
--   * One link per Nido project. Only the host and admins link, change and unlink, through the functions below
--     (service role only), which check the acting user's role.

create table public.project_supabase_links (
  project_id uuid primary key references public.projects (id) on delete cascade,
  supabase_ref text not null check (supabase_ref ~ '^[a-z]{20}$'),
  name text not null check (char_length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
  region text not null default '' check (char_length(region) <= 40 and region ~ '^[a-z0-9-]*$'),
  linked_by uuid references public.profiles (id) on delete set null,
  linked_at timestamptz not null default now()
);

alter table public.project_supabase_links enable row level security;
revoke all on public.project_supabase_links from anon, authenticated;

-- ================================================================== server-only functions (service role)

create function public.app_supabase_link_set(p_user uuid, p_project uuid, p_ref text, p_name text, p_region text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.project_role_of(p_user, p_project);
  v_name text := trim(coalesce(p_name, ''));
  v_region text := lower(trim(coalesce(p_region, '')));
begin
  if v_role is null then raise exception 'not_found'; end if;
  if v_role not in ('host', 'admin') then raise exception 'forbidden'; end if;
  if p_ref is null or p_ref !~ '^[a-z]{20}$' then raise exception 'invalid_scope'; end if;
  if char_length(v_name) not between 1 and 120 or v_name ~ '[[:cntrl:]]' then raise exception 'invalid_name'; end if;
  if char_length(v_region) > 40 or v_region !~ '^[a-z0-9-]*$' then raise exception 'invalid_scope'; end if;
  insert into public.project_supabase_links (project_id, supabase_ref, name, region, linked_by, linked_at)
  values (p_project, p_ref, v_name, v_region, p_user, now())
  on conflict (project_id) do update
    set supabase_ref = excluded.supabase_ref, name = excluded.name, region = excluded.region, linked_by = excluded.linked_by, linked_at = excluded.linked_at;
end;
$$;

create function public.app_supabase_link_remove(p_user uuid, p_project uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.project_role_of(p_user, p_project);
begin
  if v_role is null then raise exception 'not_found'; end if;
  if v_role not in ('host', 'admin') then raise exception 'forbidden'; end if;
  delete from public.project_supabase_links where project_id = p_project;
end;
$$;

revoke execute on function public.app_supabase_link_set(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.app_supabase_link_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.app_supabase_link_set(uuid, uuid, text, text, text) to service_role;
grant execute on function public.app_supabase_link_remove(uuid, uuid) to service_role;
