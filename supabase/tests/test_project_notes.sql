-- Tests for 0017: project notes. Runs after test_mvp.sql, whose users and t_* helpers are still there.
do $$
declare
  p uuid; p2 uuid; n1 uuid; n2 uuid; n_ai uuid;
begin
  -- ids may already exist from earlier test files; fall back to looking people up by email
  p := public.app_create_project(uid('ana'), 'Notes project');
  p2 := public.app_create_project(uid('cara'), 'Other project');
  insert into public.project_members (project_id, user_id, role) values (p, uid('ben'), 'member'), (p, uid('dan'), 'admin');

  -- any member adds; an outsider cannot
  n1 := public.app_note_create(uid('ben'), p, '  Budget cap  ', 'Keep launch spend under 4k.');
  perform t_assert((select title from public.project_notes where id = n1) = 'Budget cap', 'title trimmed');
  perform t_assert((select created_by = uid('ben') and not by_ai from public.project_notes where id = n1), 'author recorded');
  perform t_fails(format($q$select public.app_note_create(%L, %L, 'x', 'y')$q$, uid('cara'), p), 'not_found');

  -- the AI's note belongs to whoever asked
  n_ai := public.app_note_create(uid('ana'), p, 'Launch timeline', '9:00 embargo', true);
  perform t_assert((select by_ai and created_by = uid('ana') from public.project_notes where id = n_ai), 'AI note flagged, owned by the asker');

  -- bad input
  perform t_fails(format($q$select public.app_note_create(%L, %L, '   ', 'y')$q$, uid('ana'), p), 'invalid_name');
  perform t_fails(format($q$select public.app_note_create(%L, %L, %L, 'y')$q$, uid('ana'), p, repeat('a', 121)), 'invalid_name');
  perform t_fails(format($q$select public.app_note_create(%L, %L, %L, 'y')$q$, uid('ana'), p, E'two\nlines'), 'invalid_name');
  perform t_fails(format($q$select public.app_note_create(%L, %L, 'ok', %L)$q$, uid('ana'), p, repeat('a', 8001)), 'invalid_scope');

  -- any member edits any note
  perform public.app_note_update(uid('dan'), n1, 'Budget', 'Under 4k.');
  perform t_assert((select title = 'Budget' and body = 'Under 4k.' and updated_by = uid('dan') and created_by = uid('ben') from public.project_notes where id = n1), 'edit by another member keeps the author');
  perform t_fails(format($q$select public.app_note_update(%L, %L, 'x', 'y')$q$, uid('cara'), n1), 'not_found');
  perform t_fails(format($q$select public.app_note_update(%L, %L, '', 'y')$q$, uid('ben'), n1), 'invalid_name');

  -- RLS: members read, outsiders do not, nobody writes directly
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.project_notes') = 2, 'member reads the project notes');
  perform t_assert(t_count_as(uid('cara'), format('select 1 from public.project_notes where project_id = %L', p)) = 0, 'outsider reads nothing');
  perform t_fails_as(uid('ben'), format($q$update public.project_notes set title = 'hack' where id = %L$q$, n1), 'permission denied');
  perform t_fails_as(uid('ben'), format($q$delete from public.project_notes where id = %L$q$, n1), 'permission denied');
  perform t_fails_as(uid('ben'), format($q$insert into public.project_notes (project_id, title) values (%L, 'x')$q$, p), 'permission denied');
  perform t_fails_as(uid('ben'), format($q$select public.app_note_create(%L, %L, 'x', 'y')$q$, uid('ben'), p), 'permission denied');
  perform t_fails_as(uid('ben'), format($q$select public.app_note_delete(%L, %L)$q$, uid('ben'), n1), 'permission denied');

  -- delete: the author, the host and admins; not another member
  n2 := public.app_note_create(uid('dan'), p, 'Dan note', '');
  perform t_fails(format($q$select public.app_note_delete(%L, %L)$q$, uid('ben'), n2), 'forbidden');
  perform t_fails(format($q$select public.app_note_delete(%L, %L)$q$, uid('cara'), n2), 'not_found');
  perform public.app_note_delete(uid('ben'), n1);
  perform t_assert(not exists (select 1 from public.project_notes where id = n1), 'author deletes own note');
  perform public.app_note_delete(uid('ana'), n2);
  perform t_assert(not exists (select 1 from public.project_notes where id = n2), 'host deletes another member''s note');
  n2 := public.app_note_create(uid('ben'), p, 'Ben note', '');
  perform public.app_note_delete(uid('dan'), n2);
  perform t_assert(not exists (select 1 from public.project_notes where id = n2), 'admin deletes another member''s note');
  perform t_fails(format($q$select public.app_note_delete(%L, %L)$q$, uid('ana'), gen_random_uuid()), 'not_found');

  -- a project holds 200 notes
  insert into public.project_notes (project_id, title, created_by) select p2, 'n' || g, uid('cara') from generate_series(1, 200) g;
  perform t_fails(format($q$select public.app_note_create(%L, %L, 'one too many', '')$q$, uid('cara'), p2), 'notes_full');

  -- notes go with the project
  delete from public.projects where id = p2;
  perform t_assert(not exists (select 1 from public.project_notes where project_id = p2), 'notes deleted with the project');
end $$;
