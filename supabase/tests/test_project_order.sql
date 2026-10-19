-- Tests for 0016: per-person project order. Runs after test_mvp.sql, whose users and t_* helpers are still there.
create function t_project_ids_as(p_uid uuid) returns uuid[] language plpgsql as $$
declare r uuid[];
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  set local role authenticated;
  select coalesce(array_agg(id), '{}') into r from public.project_list();
  reset role;
  return r;
exception when others then reset role; raise;
end $$;

do $$
declare a uuid; b uuid; c uuid; d uuid; before_ben uuid[]; mine uuid[];
begin
  -- fresh people so the projects made by earlier tests do not matter
  insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values ('fay@example.com', '{"display_name":"Fay"}', now()), ('gus@example.com', '{"display_name":"Gus"}', now());
  insert into ids select split_part(email, '@', 1), id from auth.users where email in ('fay@example.com', 'gus@example.com');
  a := public.app_create_project(uid('fay'), 'A');
  b := public.app_create_project(uid('fay'), 'B');
  c := public.app_create_project(uid('fay'), 'C');
  -- no order saved yet: newest first
  perform t_assert(public.t_project_ids_as(uid('fay')) = array[c, b, a], 'default order is newest first');

  -- save an order
  perform public.app_reorder_projects(uid('fay'), array[a, c, b]);
  perform t_assert(public.t_project_ids_as(uid('fay')) = array[a, c, b], 'saved order is used');

  -- a new project (no order yet) goes to the top
  d := public.app_create_project(uid('fay'), 'D');
  perform t_assert(public.t_project_ids_as(uid('fay')) = array[d, a, c, b], 'new project lands first');

  -- another person has their own order and is untouched
  insert into public.project_members (project_id, user_id, role) values (a, uid('gus'), 'member'), (b, uid('gus'), 'member');
  before_ben := public.t_project_ids_as(uid('gus'));
  perform public.app_reorder_projects(uid('fay'), array[b, a, c, d]);
  perform t_assert(public.t_project_ids_as(uid('gus')) = before_ben, 'other person order unchanged');

  -- ids the caller is not in are ignored and do not leak or change anything
  perform public.app_reorder_projects(uid('gus'), array[c, b, a]);
  perform t_assert(public.t_project_ids_as(uid('gus')) = array[b, a], 'foreign project ignored');
  perform t_assert(public.t_project_ids_as(uid('fay')) = array[b, a, c, d], 'owner order not changed by an outsider call');

  -- bad input
  perform t_fails(format($q$select public.app_reorder_projects(%L, array[%L, %L]::uuid[])$q$, uid('fay'), a, a), 'invalid_scope');
  perform t_fails(format($q$select public.app_reorder_projects(%L, null)$q$, uid('fay')), 'invalid_scope');

  -- clients cannot call it or write the column directly
  perform t_fails_as(uid('fay'), format($q$select public.app_reorder_projects(%L, array[%L]::uuid[])$q$, uid('fay'), a), 'permission denied');
  perform t_fails_as(uid('fay'), format($q$update public.project_members set sort_order = 0 where project_id = %L$q$, a), 'permission denied');
end $$;
