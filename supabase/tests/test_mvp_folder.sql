-- Tests for 0015: per-owner sharing. Runs after test_mvp.sql, whose users and t_* helpers are still there.
create temp table ids (name text primary key, id uuid);
grant all on ids to public;
insert into ids select split_part(email, '@', 1), id from auth.users;

do $$
declare
  p uuid;
  r jsonb;
  v_share uuid;
  v_ben_share uuid;
  v_i text;
begin
  p := public.app_create_project(uid('ana'), 'Share project');
  insert into ids values ('sp', p);
  insert into public.project_members (project_id, user_id, role) values (p, uid('ben'), 'member'), (p, uid('dan'), 'admin');

  -- nothing is shared yet
  perform t_fails(format($q$select public.app_share_member_check(%L, %L)$q$, uid('ben'), p), 'not_linked');
  perform t_fails(format($q$select public.app_share_member_check(%L, %L)$q$, uid('cara'), p), 'not_found');
  perform t_fails(format($q$select public.app_share_connect(%L, %L)$q$, uid('cara'), p), 'not_found');
  perform t_fails(format($q$select public.app_share_sync(%L, %L, '[]')$q$, uid('cara'), p), 'not_found');

  -- the host's items are approved at once
  perform t_assert(public.app_share_connect(uid('ana'), p) = 'host', 'host connects');
  r := public.app_share_sync(uid('ana'), p, '[{"key":"k1","name":"my-app","kind":"dir"},{"key":"k2","name":"notes.md","kind":"file"}]');
  perform t_assert(jsonb_array_length(r) = 2 and r -> 0 ->> 'status' = 'active' and r -> 0 ->> 'name' = 'my-app', 'host items active');
  perform t_assert(public.app_share_member_check(uid('ben'), p) = 2, 'a member may read approved items');
  perform t_assert((select not online from public.project_share_hosts where project_id = p and owner_id = uid('ana')), 'starts offline');

  -- bad input changes nothing
  perform t_fails(format($q$select public.app_share_sync(%L, %L, '{}')$q$, uid('ana'), p), 'invalid_items');
  perform t_fails(format($q$select public.app_share_sync(%L, %L, '[{"key":"x","name":"  ","kind":"dir"}]')$q$, uid('ana'), p), 'invalid_items');
  perform t_fails(format($q$select public.app_share_sync(%L, %L, '[{"key":"x","name":"a","kind":"socket"}]')$q$, uid('ana'), p), 'invalid_items');
  perform t_fails(format($q$select public.app_share_sync(%L, %L, %L)$q$, uid('ana'), p, jsonb_build_array(jsonb_build_object('key', 'x', 'name', E'bad\nname', 'kind', 'dir'))), 'invalid_items');
  for v_i in select unnest(array['a/b', 'a\\b', '..', '.', E'x\u202ey', E'z\u200bz']) loop
    perform t_fails(format($q$select public.app_share_sync(%L, %L, %L)$q$, uid('ana'), p, jsonb_build_array(jsonb_build_object('key', 'x', 'name', v_i, 'kind', 'dir'))), 'invalid_items');
  end loop;
  perform t_assert((select count(*) from public.project_shares where project_id = p) = 2, 'bad input changed nothing');

  -- a member's items wait for approval, and a taken name gets a suffix
  perform t_assert(public.app_share_connect(uid('ben'), p) = 'member', 'member connects');
  r := public.app_share_sync(uid('ben'), p, '[{"key":"b1","name":"MY-APP","kind":"dir"}]');
  perform t_assert(r -> 0 ->> 'status' = 'pending' and r -> 0 ->> 'name' = 'MY-APP (2)', 'member item pending with a unique name');
  v_ben_share := (select id from public.project_shares where project_id = p and owner_id = uid('ben'));
  v_share := (select id from public.project_shares where project_id = p and owner_id = uid('ana') and item_key = 'k1');
  perform t_assert(public.app_share_member_check(uid('ben'), p) = 2, 'a pending item is not readable');

  -- who sees what (RLS): approved items to every member, a request only to its owner and to the people who decide
  perform t_assert(t_count_as(uid('cara'), 'select 1 from public.project_shares') = 0, 'outsider sees no items');
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.project_shares') = 3, 'owner sees approved items and own request');
  perform t_assert(t_count_as(uid('dan'), 'select 1 from public.project_shares') = 3, 'admin sees the request');
  perform public.app_share_sync(uid('dan'), p, '[{"key":"d1","name":"docs","kind":"dir"}]');
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.project_shares') = 4, 'member sees the approved item of an admin');
  perform t_assert(t_count_as(uid('ana'), 'select 1 from public.project_share_hosts') = 3, 'members see which owners exist');
  perform t_fails_as(uid('ana'), format($q$update public.project_shares set status = 'active' where id = %L$q$, v_ben_share), 'permission denied');
  perform t_fails_as(uid('ben'), format($q$update public.project_shares set status = 'active' where id = %L$q$, v_ben_share), 'permission denied');
  perform t_fails_as(uid('ana'), format($q$delete from public.project_shares where id = %L$q$, v_share), 'permission denied');
  perform t_fails_as(uid('ana'), format($q$insert into public.project_shares (project_id, owner_id, item_key, name, kind) values (%L, %L, 'z', 'z', 'dir')$q$, p, uid('ana')), 'permission denied');
  perform t_fails_as(uid('ana'), format($q$select public.app_share_sync(%L, %L, '[]')$q$, uid('ana'), p), 'permission denied');
  perform t_fails_as(uid('ben'), format($q$select public.app_share_set_online(%L, %L, true)$q$, p, uid('ben')), 'permission denied');

  -- approving and declining: only the host and admins, only for requests
  perform t_fails(format($q$select public.app_share_decide(%L, %L, %L, true)$q$, uid('ben'), p, v_ben_share), 'forbidden');
  perform t_fails(format($q$select public.app_share_decide(%L, %L, %L, true)$q$, uid('cara'), p, v_ben_share), 'not_found');
  perform t_fails(format($q$select public.app_share_decide(%L, %L, %L, true)$q$, uid('ana'), p, v_share), 'not_found'); -- already approved
  perform t_fails(format($q$select public.app_share_decide(%L, %L, gen_random_uuid(), true)$q$, uid('ana'), p), 'not_found');
  perform t_assert(public.app_share_decide(uid('dan'), p, v_ben_share, true) = uid('ben'), 'admin approves; the owner is returned');
  perform t_assert((select status from public.project_shares where id = v_ben_share) = 'active', 'approved');
  perform t_assert(public.app_share_member_check(uid('ben'), p) = 4, 'the approved item is readable');

  -- a declined request is removed; asking again later is a fresh request
  r := public.app_share_sync(uid('ben'), p, '[{"key":"b1","name":"MY-APP","kind":"dir"},{"key":"b2","name":"secret-plans","kind":"dir"}]');
  perform t_assert(r -> 1 ->> 'status' = 'pending', 'second request pending');
  perform public.app_share_decide(uid('ana'), p, (select id from public.project_shares where item_key = 'b2' and project_id = p), false);
  perform t_assert((select count(*) from public.project_shares where item_key = 'b2' and project_id = p) = 0, 'declined request removed');

  -- removing an item: its owner, the host, admins; not another member
  perform t_fails(format($q$select public.app_share_remove(%L, %L, %L)$q$, uid('ben'), p, v_share), 'forbidden');
  perform t_fails(format($q$select public.app_share_remove(%L, %L, %L)$q$, uid('cara'), p, v_share), 'not_found');
  perform t_assert(public.app_share_remove(uid('ana'), p, v_ben_share) = uid('ben'), 'host removes a member item');
  perform t_assert(public.app_share_remove(uid('ana'), p, v_share) = uid('ana'), 'owner removes own item');
  perform t_fails(format($q$select public.app_share_remove(%L, %L, %L)$q$, uid('ana'), p, v_share), 'not_found');

  -- a sync reports everything the app has: what it no longer reports goes, a new name never steals an old one
  r := public.app_share_sync(uid('ana'), p, '[{"key":"k2","name":"notes.md","kind":"file"},{"key":"k3","name":"docs","kind":"dir"}]');
  perform t_assert(jsonb_array_length(r) = 2 and (select count(*) from public.project_shares where owner_id = uid('ana') and project_id = p) = 2, 'sync replaces the owner list');
  perform t_assert((select name from public.project_shares where project_id = p and item_key = 'k3') = 'docs (2)', 'a name taken by another owner is suffixed');
  perform t_assert((select name from public.project_shares where project_id = p and item_key = 'd1') = 'docs', 'the first owner keeps the name');

  -- a member's waiting requests are capped so they can't crowd out real items; approving never goes past the project limit
  r := public.app_share_sync(uid('ben'), p, (select jsonb_agg(jsonb_build_object('key', 'q' || i, 'name', 'req' || i, 'kind', 'dir')) from generate_series(1, 5) i));
  perform t_assert((select count(*) from public.project_shares where project_id = p and owner_id = uid('ben') and status = 'pending') = 5, 'five requests waiting');
  perform t_fails(format($q$select public.app_share_sync(%L, %L, %L)$q$, uid('ben'), p, (select jsonb_agg(jsonb_build_object('key', 'q' || i, 'name', 'req' || i, 'kind', 'dir')) from generate_series(1, 6) i)), 'too_many_requests');
  perform public.app_share_sync(uid('ben'), p, '[]');

  -- the limit is per project, and swapping an item at the limit works
  r := public.app_share_sync(uid('ana'), p, (select jsonb_agg(jsonb_build_object('key', 'x' || i, 'name', 'item' || i, 'kind', 'dir')) from generate_series(1, 19) i));
  perform t_assert((select count(*) from public.project_shares where project_id = p) = 20, 'at the limit');
  perform t_fails(format($q$select public.app_share_sync(%L, %L, %L)$q$, uid('dan'), p, '[{"key":"d1","name":"docs","kind":"dir"},{"key":"d2","name":"more","kind":"dir"}]'), 'too_many');
  -- a request can be made while the project is full, but not approved
  perform public.app_share_sync(uid('ben'), p, '[{"key":"late","name":"late-one","kind":"dir"}]');
  perform t_fails(format($q$select public.app_share_decide(%L, %L, %L, true)$q$, uid('ana'), p, (select id from public.project_shares where project_id = p and item_key = 'late')), 'too_many');
  perform public.app_share_sync(uid('ben'), p, '[]');
  perform public.app_share_sync(uid('ana'), p, (select jsonb_agg(jsonb_build_object('key', 'y' || i, 'name', 'thing' || i, 'kind', 'dir')) from generate_series(1, 19) i));
  perform t_assert((select count(*) from public.project_shares where project_id = p) = 20, 'swapping at the limit works');
  perform public.app_share_sync(uid('ana'), p, '[]');

  -- online flag per owner
  perform public.app_share_set_online(p, uid('ana'), true);
  perform t_assert((select online from public.project_share_hosts where project_id = p and owner_id = uid('ana')), 'online');
  perform t_assert((select not online from public.project_share_hosts where project_id = p and owner_id = uid('ben')), 'other owners are unaffected');
  perform public.app_shares_all_offline();
  perform t_assert((select count(*) from public.project_share_hosts where online) = 0, 'all offline after a restart');

  -- someone who leaves the project stops sharing in it
  perform t_assert((select count(*) from public.project_shares where project_id = p and owner_id = uid('dan')) = 1, 'admin item present');
  delete from public.project_members where project_id = p and user_id = uid('dan');
  perform t_assert((select count(*) from public.project_shares where project_id = p and owner_id = uid('dan')) = 0, 'items go with the member');
  perform t_assert((select count(*) from public.project_share_hosts where project_id = p and owner_id = uid('dan')) = 0, 'owner row goes with the member');

  -- everything goes with the project
  perform public.app_share_sync(uid('ana'), p, '[{"key":"z","name":"again","kind":"dir"}]');
  perform public.app_delete_project(uid('ana'), p);
  perform t_assert((select count(*) from public.project_shares where project_id = p) = 0, 'items removed with the project');
  perform t_assert((select count(*) from public.project_share_hosts where project_id = p) = 0, 'owners removed with the project');
end $$;
