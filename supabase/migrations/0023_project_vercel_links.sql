-- The link between a Nido project and a Vercel project (the Vercel tab of the Files card), and the "All tools" switch of a
-- remote MCP server.
--
--   * Public facts only: the Vercel team's id and short name, the project's id and name. No tokens, no secrets. What a person
--     sees of the Vercel project comes through their OWN Vercel connection (their MCP servers), so the link alone gives
--     nobody any access to it.
--   * RLS is on with no policies and the client roles have no grants: only the server (service role) reads or writes this
--     table, like project_supabase_links (0022). The page gets the link from the server.
--   * One link per Nido project. Only the host and admins link, change and unlink, through the functions below (service
--     role only), which check the acting user's role.
--   * user_mcp_servers.all_tools: for a server Nido has a tool preset for (Vercel: 12 of 239), false = the AI gets only the
--     preset, true = every tool the server lists.

create table public.project_vercel_links (
  project_id uuid primary key references public.projects (id) on delete cascade,
  vercel_team_id text not null check (vercel_team_id ~ '^team_[A-Za-z0-9]{10,40}$'),
  vercel_team_slug text not null default '' check (vercel_team_slug ~ '^[a-z0-9_-]{0,63}$'),
  vercel_project_id text not null check (vercel_project_id ~ '^prj_[A-Za-z0-9]{10,40}$'),
  name text not null check (char_length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
  linked_by uuid references public.profiles (id) on delete set null,
  linked_at timestamptz not null default now()
);

alter table public.project_vercel_links enable row level security;
revoke all on public.project_vercel_links from anon, authenticated;

alter table public.user_mcp_servers add column all_tools boolean not null default false;

-- ================================================================== server-only functions (service role)

create function public.app_vercel_link_set(p_user uuid, p_project uuid, p_team text, p_team_slug text, p_vercel_project text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.project_role_of(p_user, p_project);
  v_name text := trim(coalesce(p_name, ''));
  v_slug text := lower(trim(coalesce(p_team_slug, '')));
begin
  if v_role is null then raise exception 'not_found'; end if;
  if v_role not in ('host', 'admin') then raise exception 'forbidden'; end if;
  if p_team is null or p_team !~ '^team_[A-Za-z0-9]{10,40}$' then raise exception 'invalid_scope'; end if;
  if p_vercel_project is null or p_vercel_project !~ '^prj_[A-Za-z0-9]{10,40}$' then raise exception 'invalid_scope'; end if;
  if v_slug !~ '^[a-z0-9_-]{0,63}$' then raise exception 'invalid_scope'; end if;
  if char_length(v_name) not between 1 and 120 or v_name ~ '[[:cntrl:]]' then raise exception 'invalid_name'; end if;
  insert into public.project_vercel_links (project_id, vercel_team_id, vercel_team_slug, vercel_project_id, name, linked_by, linked_at)
  values (p_project, p_team, v_slug, p_vercel_project, v_name, p_user, now())
  on conflict (project_id) do update
    set vercel_team_id = excluded.vercel_team_id, vercel_team_slug = excluded.vercel_team_slug, vercel_project_id = excluded.vercel_project_id,
        name = excluded.name, linked_by = excluded.linked_by, linked_at = excluded.linked_at;
end;
$$;

create function public.app_vercel_link_remove(p_user uuid, p_project uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.project_role_of(p_user, p_project);
begin
  if v_role is null then raise exception 'not_found'; end if;
  if v_role not in ('host', 'admin') then raise exception 'forbidden'; end if;
  delete from public.project_vercel_links where project_id = p_project;
end;
$$;

revoke execute on function public.app_vercel_link_set(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.app_vercel_link_remove(uuid, uuid) from public, anon, authenticated;
grant execute on function public.app_vercel_link_set(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.app_vercel_link_remove(uuid, uuid) to service_role;
