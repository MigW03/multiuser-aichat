-- Who may call what. Anything new that anon or authenticated can execute must be added here on purpose.
do $$
declare
  r record;
  v_unexpected text := '';
  v_allowed text[] := array[
    -- helpers used inside RLS policies and realtime policies
    'is_chat_member', 'is_project_member', 'can_use_realtime_topic',
    -- client reads
    'chat_list', 'project_list', 'mark_chat_read', 'search_messages',
    -- a constant (10)
    'max_project_people'
  ];
begin
  -- anon: nothing in public
  -- (t_* and uid are helpers that test_mvp.sql creates for itself)
  for r in
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
       and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
       and p.proname !~ '^t_' and p.proname <> 'uid' and p.proname <> 'max_project_people'
  loop
    v_unexpected := v_unexpected || ' anon:' || r.proname;
  end loop;

  -- authenticated: only the allowed list; never app_*
  for r in
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
       and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
       and p.proname !~ '^t_' and p.proname <> 'uid'
  loop
    if r.proname <> all (v_allowed) then v_unexpected := v_unexpected || ' authenticated:' || r.proname; end if;
  end loop;

  -- every app_* function belongs to the service role alone
  for r in
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'app\_%'
       and not has_function_privilege('service_role', p.oid, 'execute')
  loop
    v_unexpected := v_unexpected || ' service_role-missing:' || r.proname;
  end loop;

  if v_unexpected <> '' then raise exception 'unexpected function privileges:%', v_unexpected; end if;

  -- tables: no write access for clients on anything but pins, favourites (unused leftover) and the profile columns
  for r in
    select c.relname, p.privilege_type from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('insert'), ('update'), ('delete')) as p(privilege_type)
     where n.nspname = 'public' and c.relkind = 'r'
       and (has_table_privilege('anon', c.oid, p.privilege_type) or has_table_privilege('authenticated', c.oid, p.privilege_type))
       and c.relname not in ('chat_pins', 'profiles', 'user_favorite_models') -- own rows only, by RLS
  loop
    v_unexpected := v_unexpected || ' ' || r.relname || ':' || r.privilege_type;
  end loop;
  if v_unexpected <> '' then raise exception 'clients can write tables directly:%', v_unexpected; end if;

  -- every table has row level security on
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  loop
    v_unexpected := v_unexpected || ' ' || r.relname;
  end loop;
  if v_unexpected <> '' then raise exception 'tables without RLS:%', v_unexpected; end if;

  -- the invites table and the key table are not readable by clients at all
  if has_table_privilege('authenticated', 'public.invites', 'select') then raise exception 'invites readable by clients'; end if;
  if has_table_privilege('authenticated', 'public.user_api_keys', 'select') then raise exception 'user_api_keys readable by clients'; end if;
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v')
       and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
            or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))
  loop
    v_unexpected := v_unexpected || ' ' || r.relname;
  end loop;
  if v_unexpected <> '' then raise exception 'anon has table privileges:%', v_unexpected; end if;
end $$;
