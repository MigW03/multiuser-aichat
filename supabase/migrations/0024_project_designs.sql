-- Project designs: design-mode documents that belong to a project, not to anyone's shared folder, so every member sees
-- and edits them even when nobody's computer is on.
--
--   * The HTML of each saved version is an object in Cloudflare R2 (bucket nido-files, under designs/<project>/<design>/).
--     These tables hold the list, who changed what, and which object is each version.
--   * Only the server reads and writes them (service role). Signed-in clients get no access at all: the server checks
--     membership first, and checks the HTML (no scripts or other active content, no secrets, size) before it stores it.
--   * Any member creates, saves and restores. The maker, the host and admins delete. A deleted design is kept for 30 days
--     (deleted_at), then its rows go and the server removes its objects.
--   * A save names the version it was made from; a design that changed since is not overwritten ('stale').

create table public.project_designs (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  slug text not null check (char_length(slug) between 1 and 60 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (char_length(name) between 1 and 60),
  version integer not null default 1 check (version >= 1),
  html_key text not null check (char_length(html_key) <= 200),
  bytes integer not null check (bytes between 0 and 2000000),
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One live design per name in a project; a deleted one frees its name.
create unique index project_designs_slug_idx on public.project_designs (project_id, slug) where deleted_at is null;
create index project_designs_project_idx on public.project_designs (project_id, updated_at desc);

create table public.project_design_versions (
  design_id uuid not null references public.project_designs (id) on delete cascade,
  version integer not null check (version >= 1),
  html_key text not null check (char_length(html_key) <= 200),
  bytes integer not null check (bytes between 0 and 2000000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (design_id, version)
);

alter table public.project_designs enable row level security;
alter table public.project_design_versions enable row level security;
revoke all on public.project_designs, public.project_design_versions from anon, authenticated;

-- ================================================================== server-only functions (service role)

-- The object of a version lives under designs/<project>/<design>/, and nowhere else.
create function public.app_design_key_ok(p_project uuid, p_design uuid, p_key text) returns boolean
language sql immutable set search_path = '' as $$
  select p_key ~ ('^designs/' || p_project::text || '/' || p_design::text || '/[0-9a-f-]{36}\.html$')
$$;

create function public.app_design_create(p_user uuid, p_project uuid, p_id uuid, p_slug text, p_name text, p_key text, p_bytes integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
begin
  if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  if char_length(v_name) not between 1 and 60 or v_name ~ '[[:cntrl:]]' then raise exception 'invalid_name'; end if;
  if p_slug is null or char_length(p_slug) not between 1 and 60 or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'invalid_name'; end if;
  if not public.app_design_key_ok(p_project, p_id, p_key) or p_bytes is null or p_bytes not between 0 and 2000000 then raise exception 'invalid_scope'; end if;
  if (select count(*) from public.project_designs where project_id = p_project and deleted_at is null) >= 200 then raise exception 'designs_full'; end if;
  if exists (select 1 from public.project_designs where project_id = p_project and slug = p_slug and deleted_at is null) then raise exception 'design_exists'; end if;
  insert into public.project_designs (id, project_id, slug, name, version, html_key, bytes, created_by, updated_by)
  values (p_id, p_project, p_slug, v_name, 1, p_key, p_bytes, p_user, p_user);
  insert into public.project_design_versions (design_id, version, html_key, bytes, created_by)
  values (p_id, 1, p_key, p_bytes, p_user);
exception
  when unique_violation then raise exception 'design_exists';
end;
$$;

-- Any member saves. Returns the new version and the objects of versions no longer kept (the server removes them).
create function public.app_design_save(p_user uuid, p_design uuid, p_base integer, p_key text, p_bytes integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_project uuid;
  v_version integer;
  v_pruned text[];
begin
  select project_id, version into v_project, v_version from public.project_designs where id = p_design and deleted_at is null for update;
  if v_project is null or public.project_role_of(p_user, v_project) is null then raise exception 'not_found'; end if;
  if not public.app_design_key_ok(v_project, p_design, p_key) or p_bytes is null or p_bytes not between 0 and 2000000 then raise exception 'invalid_scope'; end if;
  if p_base is distinct from v_version then raise exception 'stale'; end if;
  v_version := v_version + 1;
  update public.project_designs set version = v_version, html_key = p_key, bytes = p_bytes, updated_by = p_user, updated_at = now() where id = p_design;
  insert into public.project_design_versions (design_id, version, html_key, bytes, created_by) values (p_design, v_version, p_key, p_bytes, p_user);
  with gone as (
    delete from public.project_design_versions where design_id = p_design and version <= v_version - 50 returning html_key
  )
  select coalesce(array_agg(html_key), '{}') into v_pruned from gone;
  return jsonb_build_object('version', v_version, 'pruned', to_jsonb(v_pruned));
end;
$$;

-- The maker, the host and admins. Returns the designs deleted more than 30 days ago that are now gone for good, so the
-- server removes their objects.
create function public.app_design_delete(p_user uuid, p_design uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_project uuid;
  v_maker uuid;
  v_role text;
  v_purged uuid[];
begin
  select project_id, created_by into v_project, v_maker from public.project_designs where id = p_design and deleted_at is null;
  if v_project is null then raise exception 'not_found'; end if;
  v_role := public.project_role_of(p_user, v_project);
  if v_role is null then raise exception 'not_found'; end if;
  if v_maker is distinct from p_user and v_role not in ('host', 'admin') then raise exception 'forbidden'; end if;
  update public.project_designs set deleted_at = now() where id = p_design;
  with gone as (
    delete from public.project_designs where project_id = v_project and deleted_at < now() - interval '30 days' returning id
  )
  select coalesce(array_agg(id), '{}') into v_purged from gone;
  return jsonb_build_object('purged', to_jsonb(v_purged));
end;
$$;

revoke execute on function public.app_design_key_ok(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.app_design_create(uuid, uuid, uuid, text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.app_design_save(uuid, uuid, integer, text, integer) from public, anon, authenticated;
revoke execute on function public.app_design_delete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.app_design_key_ok(uuid, uuid, text) to service_role;
grant execute on function public.app_design_create(uuid, uuid, uuid, text, text, text, integer) to service_role;
grant execute on function public.app_design_save(uuid, uuid, integer, text, integer) to service_role;
grant execute on function public.app_design_delete(uuid, uuid) to service_role;
