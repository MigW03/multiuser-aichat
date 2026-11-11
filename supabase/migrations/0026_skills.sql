-- Skills: saved instructions the AI follows for a task, and plugins (bundles of skills installed from a file).
-- Text only: nothing here is ever run.
--
--   * A skill or plugin belongs to ONE person (owner_id, "my skills") or to ONE project (project_id, shared with its
--     members), never both.
--   * Nobody reads or writes these tables from the browser: RLS is on with no policy and no grants. The chat server reads
--     them with the service role, and every write goes through the app_skill_* / app_plugin_* functions below (service
--     role only), which check the acting user's role.
--   * Any member can add, edit and switch the skills of a project. A skill or plugin is deleted by whoever added it,
--     the host and admins. A plugin's skills can be switched but not edited (update the plugin instead).
--   * A plugin skill is named `plugin:skill`; a single skill has no colon, so the two never clash.

create table public.skill_plugins (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  version text not null default '' check (char_length(version) <= 40),
  author text not null default '' check (char_length(author) <= 80),
  description text not null default '' check (char_length(description) <= 300),
  enabled boolean not null default true,
  installed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((owner_id is null) <> (project_id is null))
);
create unique index skill_plugins_owner_name on public.skill_plugins (owner_id, name) where owner_id is not null;
create unique index skill_plugins_project_name on public.skill_plugins (project_id, name) where project_id is not null;

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  plugin_id uuid references public.skill_plugins (id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?(:[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?)?$'),
  description text not null check (char_length(description) between 1 and 300),
  body text not null check (char_length(body) between 1 and 8000),
  auto_use boolean not null default true,
  enabled boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((owner_id is null) <> (project_id is null)),
  -- a plugin skill has the colon, a single skill does not
  check ((plugin_id is null) = (position(':' in name) = 0))
);
create unique index skills_owner_name on public.skills (owner_id, name) where owner_id is not null;
create unique index skills_project_name on public.skills (project_id, name) where project_id is not null;
create unique index skills_plugin_name on public.skills (plugin_id, name) where plugin_id is not null;

alter table public.skill_plugins enable row level security;
alter table public.skills enable row level security;
revoke all on public.skill_plugins, public.skills from anon, authenticated;

-- ================================================================== server-only functions (service role)

-- Can this user act in this place? p_project null = their own skills.
create function public.app_skill_scope_role(p_user uuid, p_project uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_project is null then return 'owner'; end if;
  return public.project_role_of(p_user, p_project);
end;
$$;

create function public.app_skill_count(p_user uuid, p_project uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.skills
  where case when p_project is null then owner_id = p_user else project_id = p_project end
$$;

-- Add a single skill (p_id null) or change one (not a plugin's).
create function public.app_skill_save(p_user uuid, p_project uuid, p_id uuid, p_name text, p_description text, p_body text, p_auto_use boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := coalesce(p_name, '');
  v_desc text := trim(coalesce(p_description, ''));
  v_body text := coalesce(p_body, '');
  v_id uuid;
begin
  if public.app_skill_scope_role(p_user, p_project) is null then raise exception 'not_found'; end if;
  if v_name !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' then raise exception 'invalid_name'; end if;
  if char_length(v_desc) not between 1 and 300 or v_desc ~ '[[:cntrl:]]' then raise exception 'invalid_scope'; end if;
  if char_length(trim(v_body)) = 0 or char_length(v_body) > 8000 then raise exception 'invalid_scope'; end if;
  if p_id is null then
    if public.app_skill_count(p_user, p_project) >= 60 then raise exception 'skills_full'; end if;
    begin
      insert into public.skills (owner_id, project_id, name, description, body, auto_use, created_by)
      values (case when p_project is null then p_user end, p_project, v_name, v_desc, v_body, coalesce(p_auto_use, true), p_user)
      returning id into v_id;
    exception when unique_violation then raise exception 'name_taken';
    end;
    return v_id;
  end if;
  begin
    update public.skills set name = v_name, description = v_desc, body = v_body, auto_use = coalesce(p_auto_use, auto_use), updated_at = now()
    where id = p_id and plugin_id is null and case when p_project is null then owner_id = p_user else project_id = p_project end
    returning id into v_id;
  exception when unique_violation then raise exception 'name_taken';
  end;
  if v_id is null then raise exception 'not_found'; end if;
  return v_id;
end;
$$;

-- Switch a skill on or off, or its "AI may use it on its own". Works on a plugin's skills too.
create function public.app_skill_set(p_user uuid, p_project uuid, p_id uuid, p_enabled boolean, p_auto_use boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if public.app_skill_scope_role(p_user, p_project) is null then raise exception 'not_found'; end if;
  update public.skills set enabled = coalesce(p_enabled, enabled), auto_use = coalesce(p_auto_use, auto_use)
  where id = p_id and case when p_project is null then owner_id = p_user else project_id = p_project end
  returning id into v_id;
  if v_id is null then raise exception 'not_found'; end if;
end;
$$;

-- Delete a single skill: whoever added it, the host and admins (a plugin's skills go with the plugin).
create function public.app_skill_delete(p_user uuid, p_project uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.app_skill_scope_role(p_user, p_project);
  v_author uuid;
  v_found boolean;
begin
  if v_role is null then raise exception 'not_found'; end if;
  select created_by, true into v_author, v_found from public.skills
  where id = p_id and plugin_id is null and case when p_project is null then owner_id = p_user else project_id = p_project end;
  if v_found is null then raise exception 'not_found'; end if;
  if p_project is not null and v_author is distinct from p_user and v_role not in ('host', 'admin') then raise exception 'forbidden'; end if;
  delete from public.skills where id = p_id;
end;
$$;

-- Install a plugin, or update it when one with the same name is already there. p_plugin:
-- { name, version, author, description, skills: [{ name, description, body }] } with bare skill names.
-- An update keeps each skill's own switches, adds new skills (AI use off), changes the text of the rest and removes the
-- ones the new file no longer has.
create function public.app_plugin_install(p_user uuid, p_project uuid, p_plugin jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := coalesce(p_plugin->>'name', '');
  v_id uuid;
  v_skill jsonb;
  v_bare text;
  v_desc text;
  v_body text;
  v_names text[] := '{}';
  v_existing integer;
  v_new integer;
begin
  if public.app_skill_scope_role(p_user, p_project) is null then raise exception 'not_found'; end if;
  if v_name !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' then raise exception 'invalid_name'; end if;
  if jsonb_typeof(p_plugin->'skills') is distinct from 'array' or jsonb_array_length(p_plugin->'skills') not between 1 and 20 then raise exception 'invalid_scope'; end if;

  select id into v_id from public.skill_plugins
  where name = v_name and case when p_project is null then owner_id = p_user else project_id = p_project end;

  if v_id is null then
    if (select count(*) from public.skill_plugins where case when p_project is null then owner_id = p_user else project_id = p_project end) >= 10 then raise exception 'plugins_full'; end if;
    insert into public.skill_plugins (owner_id, project_id, name, version, author, description, installed_by)
    values (case when p_project is null then p_user end, p_project, v_name, left(coalesce(p_plugin->>'version', ''), 40), left(coalesce(p_plugin->>'author', ''), 80), left(coalesce(p_plugin->>'description', ''), 300), p_user)
    returning id into v_id;
  else
    update public.skill_plugins set version = left(coalesce(p_plugin->>'version', ''), 40), author = left(coalesce(p_plugin->>'author', ''), 80),
      description = left(coalesce(p_plugin->>'description', ''), 300), updated_at = now()
    where id = v_id;
  end if;

  for v_skill in select * from jsonb_array_elements(p_plugin->'skills') loop
    v_bare := coalesce(v_skill->>'name', '');
    v_desc := trim(coalesce(v_skill->>'description', ''));
    v_body := coalesce(v_skill->>'body', '');
    if v_bare !~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$' then raise exception 'invalid_name'; end if;
    if char_length(v_desc) not between 1 and 300 or v_desc ~ '[[:cntrl:]]' then raise exception 'invalid_scope'; end if;
    if char_length(trim(v_body)) = 0 or char_length(v_body) > 8000 then raise exception 'invalid_scope'; end if;
    if v_bare = any (v_names) then raise exception 'invalid_scope'; end if;
    v_names := v_names || v_bare;
    insert into public.skills (owner_id, project_id, plugin_id, name, description, body, auto_use, created_by)
    values (case when p_project is null then p_user end, p_project, v_id, v_name || ':' || v_bare, v_desc, v_body, false, p_user)
    on conflict (plugin_id, name) where plugin_id is not null do update set description = excluded.description, body = excluded.body, updated_at = now();
  end loop;
  delete from public.skills where plugin_id = v_id and substring(name from position(':' in name) + 1) <> all (v_names);

  if public.app_skill_count(p_user, p_project) > 60 then raise exception 'skills_full'; end if;
  return v_id;
end;
$$;
create function public.app_plugin_set(p_user uuid, p_project uuid, p_id uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if public.app_skill_scope_role(p_user, p_project) is null then raise exception 'not_found'; end if;
  update public.skill_plugins set enabled = p_enabled, updated_at = now()
  where id = p_id and case when p_project is null then owner_id = p_user else project_id = p_project end
  returning id into v_id;
  if v_id is null then raise exception 'not_found'; end if;
end;
$$;

-- Uninstall: whoever installed it, the host and admins. Its skills go with it.
create function public.app_plugin_delete(p_user uuid, p_project uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.app_skill_scope_role(p_user, p_project);
  v_by uuid;
  v_found boolean;
begin
  if v_role is null then raise exception 'not_found'; end if;
  select installed_by, true into v_by, v_found from public.skill_plugins
  where id = p_id and case when p_project is null then owner_id = p_user else project_id = p_project end;
  if v_found is null then raise exception 'not_found'; end if;
  if p_project is not null and v_by is distinct from p_user and v_role not in ('host', 'admin') then raise exception 'forbidden'; end if;
  delete from public.skill_plugins where id = p_id;
end;
$$;

revoke execute on function public.app_skill_scope_role(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.app_skill_count(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.app_skill_save(uuid, uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.app_skill_set(uuid, uuid, uuid, boolean, boolean) from public, anon, authenticated;
revoke execute on function public.app_skill_delete(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.app_plugin_install(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.app_plugin_set(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.app_plugin_delete(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.app_skill_scope_role(uuid, uuid) to service_role;
grant execute on function public.app_skill_count(uuid, uuid) to service_role;
grant execute on function public.app_skill_save(uuid, uuid, uuid, text, text, text, boolean) to service_role;
grant execute on function public.app_skill_set(uuid, uuid, uuid, boolean, boolean) to service_role;
grant execute on function public.app_skill_delete(uuid, uuid, uuid) to service_role;
grant execute on function public.app_plugin_install(uuid, uuid, jsonb) to service_role;
grant execute on function public.app_plugin_set(uuid, uuid, uuid, boolean) to service_role;
grant execute on function public.app_plugin_delete(uuid, uuid, uuid) to service_role;
