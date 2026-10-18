-- Tests for 0013: the shared folder row. Runs after test_mvp.sql, whose users and t_* helpers are still there.
create temp table ids (name text primary key, id uuid);
grant all on ids to public;
insert into ids select split_part(email, '@', 1), id from auth.users;

do $$
declare p uuid;
begin
  p := public.app_create_project(uid('ana'), 'Folder project');
  insert into ids values ('fp', p);
  insert into public.project_members (project_id, user_id, role) values (p, uid('ben'), 'member');

  -- before anything is linked
  perform t_fails(format($q$select public.app_folder_member_check(%L, %L)$q$, uid('ben'), p), 'not_linked');
  perform t_fails(format($q$select public.app_folder_host_check(%L, %L)$q$, uid('ana'), p), 'not_linked');

  -- only the host links a folder
  perform t_fails(format($q$select public.app_link_folder(%L, %L, 'src')$q$, uid('ben'), p), 'forbidden');
  perform t_fails(format($q$select public.app_link_folder(%L, %L, 'src')$q$, uid('cara'), p), 'not_found');
  perform t_fails(format($q$select public.app_link_folder(%L, %L, '   ')$q$, uid('ana'), p), 'invalid_name');
  perform t_fails(format($q$select public.app_link_folder(%L, %L, %L)$q$, uid('ana'), p, repeat('x', 81)), 'invalid_name');
  perform t_fails(format($q$select public.app_link_folder(%L, %L, %L)$q$, uid('ana'), p, E'bad\nname'), 'invalid_name');
  perform public.app_link_folder(uid('ana'), p, '  my-app ');
  perform t_assert((select name from public.project_folders where project_id = p) = 'my-app', 'name trimmed');
  perform t_assert((select not online from public.project_folders where project_id = p), 'starts offline');
  perform t_assert((select linked_by from public.project_folders where project_id = p) = uid('ana'), 'linked by the host');

  -- who may read the row (RLS) and who may change it
  perform t_assert(t_count_as(uid('ana'), 'select 1 from public.project_folders') = 1, 'host sees the folder');
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.project_folders') = 1, 'member sees the folder');
  perform t_assert(t_count_as(uid('cara'), 'select 1 from public.project_folders') = 0, 'outsider does not see the folder');
  perform t_fails_as(uid('ana'), format($q$update public.project_folders set name = 'x' where project_id = %L$q$, p), 'permission denied');
  perform t_fails_as(uid('ana'), format($q$delete from public.project_folders where project_id = %L$q$, p), 'permission denied');
  perform t_fails_as(uid('ana'), format($q$insert into public.project_folders (project_id, name, linked_by) values (%L, 'x', %L)$q$, p, uid('ana')), 'permission denied');
  perform t_fails_as(uid('ana'), format($q$select public.app_link_folder(%L, %L, 'x')$q$, uid('ana'), p), 'permission denied');
  perform t_fails_as(uid('ben'), format($q$select public.app_folder_set_online(%L, true)$q$, p), 'permission denied');

  -- access checks the server makes
  perform t_assert(public.app_folder_member_check(uid('ben'), p) = 'my-app', 'member may read');
  perform t_assert(public.app_folder_member_check(uid('ana'), p) = 'my-app', 'host may read');
  perform t_fails(format($q$select public.app_folder_member_check(%L, %L)$q$, uid('cara'), p), 'not_found');
  perform t_assert(public.app_folder_host_check(uid('ana'), p) = 'my-app', 'host may serve');
  perform t_fails(format($q$select public.app_folder_host_check(%L, %L)$q$, uid('ben'), p), 'forbidden');
  perform t_fails(format($q$select public.app_folder_host_check(%L, %L)$q$, uid('cara'), p), 'forbidden');

  -- online flag
  perform public.app_folder_set_online(p, true);
  perform t_assert((select online from public.project_folders where project_id = p), 'online');
  perform public.app_folders_all_offline();
  perform t_assert((select not online from public.project_folders where project_id = p), 'all offline after a restart');
  perform public.app_folder_set_online(p, true);

  -- linking again replaces the folder and resets the flag
  perform public.app_link_folder(uid('ana'), p, 'other');
  perform t_assert((select name from public.project_folders where project_id = p) = 'other', 'relinked');
  perform t_assert((select not online from public.project_folders where project_id = p), 'relink resets online');
  perform t_assert((select count(*) from public.project_folders where project_id = p) = 1, 'one folder per project');

  -- unlink
  perform t_fails(format($q$select public.app_unlink_folder(%L, %L)$q$, uid('ben'), p), 'forbidden');
  perform t_fails(format($q$select public.app_unlink_folder(%L, %L)$q$, uid('cara'), p), 'not_found');
  perform public.app_unlink_folder(uid('ana'), p);
  perform t_assert((select count(*) from public.project_folders where project_id = p) = 0, 'unlinked');

  -- the row goes with the project
  perform public.app_link_folder(uid('ana'), p, 'again');
  perform public.app_delete_project(uid('ana'), p);
  perform t_assert((select count(*) from public.project_folders where project_id = p) = 0, 'folder removed with the project');
end $$;
