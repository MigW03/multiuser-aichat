-- Tests for 0010: access rules, invites, roles, caps, unread. Runs as the superuser; helpers act as a user.
create function t_assert(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAILED: %', p_msg; end if; end $$;

-- rows visible to a user through RLS (authenticated role) for any SELECT
create function t_count_as(p_uid uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  set local role authenticated;
  execute 'select count(*) from (' || p_sql || ') q' into n;
  reset role;
  return n;
exception when others then reset role; raise;
end $$;

-- the statement must fail (as that user) with a message containing p_expect
create function t_fails_as(p_uid uuid, p_sql text, p_expect text) returns void language plpgsql as $$
declare v_msg text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  set local role authenticated;
  begin
    execute p_sql;
    reset role;
    raise exception 'FAILED: expected error "%" from: %', p_expect, p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    reset role;
    if v_msg like 'FAILED:%' then raise exception '%', v_msg; end if;
    if position(p_expect in v_msg) = 0 then raise exception 'FAILED: wrong error for %: got "%", wanted "%"', p_sql, v_msg, p_expect; end if;
  end;
end $$;

-- the call (run as service role / superuser) must fail with p_expect
create function t_fails(p_sql text, p_expect text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
    raise exception 'FAILED: expected error "%" from: %', p_expect, p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'FAILED:%' then raise exception '%', v_msg; end if;
    if position(p_expect in v_msg) = 0 then raise exception 'FAILED: wrong error for %: got "%", wanted "%"', p_sql, v_msg, p_expect; end if;
  end;
end $$;

create temp table ids (name text primary key, id uuid);
grant all on ids to public;
insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values
  ('ana@example.com', '{"display_name":"Ana"}', now()),
  ('ben@example.com', '{"display_name":"Ben"}', now()),
  ('cara@example.com', '{"display_name":"Cara"}', now()),
  ('dan@example.com', '{"display_name":"Dan"}', now()),
  ('eve@example.com', '{"display_name":"Eve"}', null);
insert into ids select split_part(email, '@', 1), id from auth.users;
create function uid(p text) returns uuid language sql stable as $$ select id from ids where name = p $$;

-- ---------------------------------------------------------------- projects and roles
do $$
declare p uuid; inv record;
begin
  p := public.app_create_project(uid('ana'), '  Spring launch ');
  insert into ids values ('p1', p);
  perform t_assert((select name from public.projects where id = p) = 'Spring launch', 'project name trimmed');
  perform t_assert(public.project_role_of(uid('ana'), p) = 'host', 'creator is host');
  perform t_assert(t_count_as(uid('ana'), 'select 1 from public.projects') = 1, 'host sees project');
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.projects') = 0, 'outsider does not see project');
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.project_members') = 0, 'outsider does not see members');
  perform t_fails($q$select public.app_create_project(uid('ana'), '')$q$, 'invalid_name');
  perform t_fails_as(uid('ana'), $q$insert into public.projects (name, created_by) values ('x', uid('ana'))$q$, 'permission denied');
  perform t_fails_as(uid('ana'), $q$update public.project_members set role = 'host'$q$, 'permission denied');
  perform t_fails_as(uid('ana'), format($q$select public.app_create_project(%L, 'x')$q$, uid('ana')), 'permission denied');
  perform t_fails_as(uid('ana'), 'select * from public.invites', 'permission denied');

  -- invites
  perform t_fails(format($q$select * from public.app_create_invite(%L, %L, null, 'ben@example.com')$q$, uid('ben'), p), 'not_found');
  select * into inv from public.app_create_invite(uid('ana'), p, null, ' Ben@Example.com ', 'member');
  insert into ids values ('inv_ben', inv.invite_id);
  perform t_assert(length(inv.invite_token) >= 60, 'token is long');
  perform t_assert((select email from public.invites where id = inv.invite_id) = 'ben@example.com', 'email normalised');
  perform t_assert(inv.invite_expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour', 'expires in 7 days');
  perform t_fails(format($q$select * from public.app_create_invite(%L, %L, null, 'not-an-email')$q$, uid('ana'), p), 'invalid_email');
  perform t_fails(format($q$select * from public.app_create_invite(%L, %L, null, 'x@example.com', 'host')$q$, uid('ana'), p), 'invalid_role');
  perform t_fails(format($q$select * from public.app_create_invite(%L, null, null, 'x@example.com')$q$, uid('ana')), 'invalid_scope');

  -- wrong account / unconfirmed / right account
  perform t_fails(format($q$select * from public.app_accept_invite(%L, %L)$q$, uid('cara'), inv.invite_token), 'wrong_account');
  perform t_fails(format($q$select * from public.app_accept_invite(%L, 'nope')$q$, uid('ben')), 'invalid_invite');
  perform public.app_accept_invite(uid('ben'), inv.invite_token);
  perform t_assert(public.project_role_of(uid('ben'), p) = 'member', 'ben joined as member');
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.projects') = 1, 'member sees project');
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.project_members') = 2, 'member sees both members');
  perform public.app_accept_invite(uid('ben'), inv.invite_token); -- idempotent
  perform t_assert((select count(*) from public.project_members where project_id = p) = 2, 'no duplicate member');
  perform t_fails(format($q$select * from public.app_create_invite(%L, %L, null, 'ben@example.com')$q$, uid('ana'), p), 'already_member');

  -- members cannot invite or manage
  perform t_fails(format($q$select * from public.app_create_invite(%L, %L, null, 'cara@example.com')$q$, uid('ben'), p), 'forbidden');
  perform t_fails(format($q$select * from public.app_list_invites(%L, %L, null)$q$, uid('ben'), p), 'forbidden');
  perform t_fails(format($q$select public.app_set_member_role(%L, %L, %L, 'admin')$q$, uid('ben'), p, uid('ben')), 'forbidden');
  perform t_fails(format($q$select public.app_rename_project(%L, %L, 'x')$q$, uid('ben'), p), 'forbidden');
  perform t_fails(format($q$select public.app_delete_project(%L, %L)$q$, uid('ben'), p), 'forbidden');

  -- roles
  perform public.app_set_member_role(uid('ana'), p, uid('ben'), 'admin');
  perform t_assert(public.project_role_of(uid('ben'), p) = 'admin', 'ben is admin');
  perform t_fails(format($q$select public.app_set_member_role(%L, %L, %L, 'member')$q$, uid('ben'), p, uid('ana')), 'forbidden'); -- cannot touch host
  perform t_fails(format($q$select public.app_set_member_role(%L, %L, %L, 'member')$q$, uid('ben'), p, uid('ben')), 'forbidden'); -- or self
  perform t_fails(format($q$select public.app_set_member_role(%L, %L, %L, 'host')$q$, uid('ana'), p, uid('ben')), 'invalid_role');
  select * into inv from public.app_create_invite(uid('ben'), p, null, 'cara@example.com', 'member'); -- admin can invite
  insert into ids values ('inv_cara', inv.invite_id);
  perform public.app_accept_invite(uid('cara'), inv.invite_token);
  perform t_assert(public.project_role_of(uid('cara'), p) = 'member', 'cara joined');

  -- removal
  perform t_fails(format($q$select public.app_remove_member(%L, %L, %L)$q$, uid('cara'), p, uid('ben')), 'forbidden');
  perform t_fails(format($q$select public.app_remove_member(%L, %L, %L)$q$, uid('ben'), p, uid('ana')), 'host_cannot_leave');
  perform t_fails(format($q$select public.app_remove_member(%L, %L, %L)$q$, uid('ana'), p, uid('ana')), 'host_cannot_leave');
  perform t_fails(format($q$select public.app_remove_member(%L, %L, %L)$q$, uid('dan'), p, uid('cara')), 'not_found');
end $$;

-- ---------------------------------------------------------------- invite states and the 10 people cap
do $$
declare p uuid := (select id from ids where name = 'p1'); inv record; i int;
begin
  -- expired and revoked invites
  select * into inv from public.app_create_invite(uid('ana'), p, null, 'dan@example.com');
  update public.invites set expires_at = now() - interval '1 minute' where id = inv.invite_id;
  perform t_fails(format($q$select * from public.app_accept_invite(%L, %L)$q$, uid('dan'), inv.invite_token), 'invite_expired');
  perform t_assert((select status from public.app_preview_invite(inv.invite_token)) = 'expired', 'preview expired');
  select * into inv from public.app_create_invite(uid('ana'), p, null, 'dan@example.com');
  perform t_assert((select status from public.app_preview_invite(inv.invite_token)) = 'valid', 'preview valid');
  perform t_assert((select scope || ':' || name from public.app_preview_invite(inv.invite_token)) = 'project:Spring launch', 'preview names project');
  perform t_assert((select jsonb_array_length(members) from public.app_preview_invite(inv.invite_token)) = 3, 'preview lists members');
  perform public.app_revoke_invite(uid('ana'), inv.invite_id);
  perform t_fails(format($q$select * from public.app_accept_invite(%L, %L)$q$, uid('dan'), inv.invite_token), 'invite_expired');
  perform t_assert((select status from public.app_preview_invite('nope')) = 'invalid', 'preview invalid');
  perform t_fails(format($q$select public.app_revoke_invite(%L, %L)$q$, uid('cara'), inv.invite_id), 'forbidden');

  -- unconfirmed email can't redeem
  select * into inv from public.app_create_invite(uid('ana'), p, null, 'eve@example.com');
  perform t_fails(format($q$select * from public.app_accept_invite(%L, %L)$q$, uid('eve'), inv.invite_token), 'email_not_confirmed');
  perform public.app_revoke_invite(uid('ana'), inv.invite_id);

  -- 3 members now. Pending invites count toward the 10: 7 more fill the project.
  for i in 1..7 loop
    perform public.app_create_invite(uid('ana'), p, null, format('guest%s@example.com', i));
  end loop;
  perform t_fails(format($q$select * from public.app_create_invite(%L, %L, null, 'one-too-many@example.com')$q$, uid('ana'), p), 'project_full');
  -- revoking frees a spot
  perform public.app_revoke_invite(uid('ana'), (select id from public.invites where email = 'guest1@example.com'));
  select * into inv from public.app_create_invite(uid('ana'), p, null, 'dan@example.com');
  perform public.app_accept_invite(uid('dan'), inv.invite_token);
  perform t_assert((select count(*) from public.project_members where project_id = p) = 4, 'dan joined');
  -- re-inviting the same address replaces the old pending invite and doesn't double count
  perform public.app_create_invite(uid('ana'), p, null, 'guest2@example.com');
  perform t_assert((select count(*) from public.invites where email = 'guest2@example.com' and revoked_at is null) = 1, 'one live invite per address');
  perform t_assert((select count(*) from public.app_list_invites(uid('ana'), p, null)) = 6, 'six pending invites listed');
  -- clean up
  update public.invites set revoked_at = now() where email like 'guest%';
end $$;

-- ---------------------------------------------------------------- chats, messages and RLS
do $$
declare p uuid := (select id from ids where name = 'p1'); c uuid; hc uuid;
begin
  c := public.app_create_chat(uid('ben'), p, 'Launch plan');
  insert into ids values ('c1', c);
  perform t_assert(t_count_as(uid('cara'), 'select 1 from public.chats') = 1, 'all members see project chats');
  perform t_assert((select count(*) from public.chat_members where chat_id = c) = 0, 'project chats have no chat_members');
  perform t_fails(format($q$select public.app_create_chat(%L, %L, 'x')$q$, uid('eve'), p), 'not_found');
  insert into public.messages (chat_id, author_id, role, status, content) values (c, uid('ben'), 'user', 'done', 'hello team');
  perform t_assert(t_count_as(uid('cara'), 'select 1 from public.messages') = 1, 'member reads messages');
  perform t_assert(t_count_as(uid('eve'), 'select 1 from public.messages') = 0, 'outsider reads nothing');
  perform t_assert(t_count_as(uid('eve'), 'select 1 from public.chats') = 0, 'outsider sees no chats');
  perform t_fails_as(uid('cara'), format($q$insert into public.messages (chat_id, author_id, role, status, content) values (%L, %L, 'user', 'pending', 'x')$q$, c, uid('cara')), 'permission denied');
  perform t_fails_as(uid('cara'), format($q$update public.messages set content = 'x' where chat_id = %L$q$, c), 'permission denied');
  perform t_fails_as(uid('cara'), format($q$update public.chats set title = 'x' where id = %L$q$, c), 'permission denied');

  -- rename / delete
  perform t_assert(public.app_rename_chat(uid('cara'), c, 'Plan') = 'Plan', 'any member renames');
  perform t_fails(format($q$select public.app_rename_chat(%L, %L, 'x')$q$, uid('eve'), c), 'not_found');
  perform t_fails(format($q$select public.app_delete_chat(%L, %L)$q$, uid('cara'), c), 'forbidden');
  perform t_fails(format($q$select public.app_delete_chat(%L, %L)$q$, uid('eve'), c), 'not_found');

  -- a project chat can't be shared outside the project
  perform t_fails(format($q$select * from public.app_create_invite(%L, null, %L, 'eve@example.com')$q$, uid('ben'), c), 'not_found');

  -- home chats: private to the creator until someone is invited
  hc := public.app_create_chat(uid('ana'), null, 'Trip to Lisbon');
  insert into ids values ('hc', hc);
  insert into public.messages (chat_id, author_id, role, status, content) values (hc, uid('ana'), 'user', 'done', 'secret plan');
  perform t_assert(t_count_as(uid('ana'), format('select 1 from public.messages where chat_id = %L', hc)) = 1, 'owner reads home chat');
  perform t_assert(t_count_as(uid('ben'), format('select 1 from public.messages where chat_id = %L', hc)) = 0, 'project mate does not read home chat');
  perform t_fails(format($q$select * from public.app_create_invite(%L, null, %L, 'ben@example.com')$q$, uid('ben'), hc), 'not_found');
end $$;

do $$
declare hc uuid := (select id from ids where name = 'hc'); inv record; i int;
begin
  select * into inv from public.app_create_invite(uid('ana'), null, hc, 'ben@example.com');
  perform t_assert((select scope from public.app_preview_invite(inv.invite_token)) = 'chat', 'chat invite scope');
  perform t_fails(format($q$select * from public.app_accept_invite(%L, %L)$q$, uid('cara'), inv.invite_token), 'wrong_account');
  perform public.app_accept_invite(uid('ben'), inv.invite_token);
  perform t_assert(t_count_as(uid('ben'), format('select 1 from public.messages where chat_id = %L', hc)) = 1, 'invitee reads the chat');
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.projects') = 1, 'chat invite does not touch projects');
  perform t_assert(t_count_as(uid('cara'), format('select 1 from public.messages where chat_id = %L', hc)) = 0, 'others still locked out');
  perform t_assert(t_count_as(uid('ben'), format('select 1 from public.chat_members where chat_id = %L', hc)) = 2, 'invitee sees chat members');
  -- the invitee can invite on (any chat member), cap is 10 incl. pending
  for i in 1..8 loop perform public.app_create_invite(uid('ben'), null, hc, format('g%s@example.com', i)); end loop;
  perform t_fails(format($q$select * from public.app_create_invite(%L, null, %L, 'over@example.com')$q$, uid('ana'), hc), 'chat_full');
  perform t_fails(format($q$select * from public.app_list_invites(%L, null, %L)$q$, uid('cara'), hc), 'not_found');
  update public.invites set revoked_at = now() where email like 'g%@example.com';
  -- only the creator deletes a home chat
  perform t_fails(format($q$select public.app_delete_chat(%L, %L)$q$, uid('ben'), hc), 'forbidden');
end $$;

-- ---------------------------------------------------------------- unread and read markers
do $$
declare c uuid := (select id from ids where name = 'c1'); n int;
begin
  insert into public.messages (chat_id, author_id, role, status, content, kind) values
    (c, uid('ben'), 'user', 'done', 'second', 'message'),
    (c, uid('ben'), 'user', 'done', 'asks for summary', 'summary_request'),
    (c, null, 'assistant', 'done', 'AI reply', 'message');
  -- dan joined after the first message: only newer ones are unread for him
  perform set_config('request.jwt.claim.sub', uid('cara')::text, true);
  set local role authenticated;
  select unread_people into n from public.chat_list((select id from ids where name = 'p1')) where id = c;
  reset role;
  perform t_assert(n = 2, format('cara: 2 unread from people (got %s)', n));
  perform set_config('request.jwt.claim.sub', uid('cara')::text, true);
  set local role authenticated;
  perform public.mark_chat_read(c);
  select unread_people + unread_ai into n from public.chat_list((select id from ids where name = 'p1')) where id = c;
  reset role;
  perform t_assert(n = 0, 'read marker clears unread');
  perform t_fails_as(uid('eve'), format('select public.mark_chat_read(%L)', c), 'not a member');
end $$;

do $$
declare c uuid := (select id from ids where name = 'c1'); p uuid := (select id from ids where name = 'p1'); a int; b int;
begin
  perform set_config('request.jwt.claim.sub', uid('ben')::text, true);
  set local role authenticated;
  select unread_people, unread_ai into a, b from public.chat_list(p) where id = c;
  reset role;
  perform t_assert(a = 0 and b = 1, format('ben: 0 people / 1 ai unread (got %s/%s)', a, b));
  perform set_config('request.jwt.claim.sub', uid('ana')::text, true);
  set local role authenticated;
  select unread_people, unread_ai into a, b from public.project_list() where id = p;
  reset role;
  perform t_assert(a = 2 and b = 1, format('ana project badge 2/1 (got %s/%s)', a, b));
end $$;

-- ---------------------------------------------------------------- search, pins, profiles, realtime topics
do $$
declare c uuid := (select id from ids where name = 'c1'); p uuid := (select id from ids where name = 'p1');
begin
  insert into public.messages (chat_id, author_id, role, status, content) values (c, uid('ben'), 'user', 'done', '100% sure_thing');
  perform set_config('request.jwt.claim.sub', uid('cara')::text, true);
  set local role authenticated;
  perform t_assert((select count(*) from public.search_messages('hello', p)) = 1, 'search finds');
  perform t_assert((select count(*) from public.search_messages('100%', p)) = 1, 'percent is literal');
  perform t_assert((select count(*) from public.search_messages('%', p)) = 0, 'single char refused');
  perform t_assert((select count(*) from public.search_messages('o%', p)) = 0, 'percent not a wildcard');
  perform t_assert((select count(*) from public.search_messages('secret plan', null)) = 0, 'no access to others home chat');
  reset role;
  perform t_assert(t_count_as(uid('eve'), format('select 1 from public.search_messages(%L, %L)', 'hello', p)) = 0, 'outsider search empty');

  -- pins
  perform set_config('request.jwt.claim.sub', uid('cara')::text, true);
  set local role authenticated;
  insert into public.chat_pins (user_id, chat_id) values (uid('cara'), c);
  reset role;
  perform t_fails_as(uid('cara'), format($q$insert into public.chat_pins (user_id, chat_id) values (%L, %L)$q$, uid('ben'), c), 'row-level security');
  perform t_fails_as(uid('eve'), format($q$insert into public.chat_pins (user_id, chat_id) values (%L, %L)$q$, uid('eve'), c), 'row-level security');
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.chat_pins') = 0, 'pins are private');

end $$;

-- realtime topics: chat channels follow chat access, project channels follow membership
do $$
declare c uuid := (select id from ids where name = 'c1'); p uuid := (select id from ids where name = 'p1'); hc uuid := (select id from ids where name = 'hc');
begin
  perform set_config('request.jwt.claim.sub', uid('cara')::text, true);
  set local role authenticated;
  perform t_assert(public.can_use_realtime_topic('chat:' || c), 'member joins project chat channel');
  perform t_assert(public.can_use_realtime_topic('project:' || p), 'member joins project channel');
  perform t_assert(not public.can_use_realtime_topic('chat:' || hc), 'not a member of the home chat');
  perform t_assert(not public.can_use_realtime_topic('chat:not-a-uuid'), 'garbage topic refused without error');
  perform t_assert(not public.can_use_realtime_topic('other:' || c), 'unknown prefix refused');
  reset role;
  perform set_config('request.jwt.claim.sub', uid('eve')::text, true);
  set local role authenticated;
  perform t_assert(not public.can_use_realtime_topic('chat:' || c), 'outsider refused chat channel');
  perform t_assert(not public.can_use_realtime_topic('project:' || p), 'outsider refused project channel');
  reset role;
end $$;

-- removal keeps old messages readable with the author's name, and drops access
do $$
declare p uuid := (select id from ids where name = 'p1'); c uuid := (select id from ids where name = 'c1');
begin
  perform public.app_remove_member(uid('ana'), p, uid('ben'));
  perform t_assert(public.project_role_of(uid('ben'), p) is null, 'ben removed');
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.chats where project_id is not null') = 0, 'removed member loses the chats');
  perform t_assert(t_count_as(uid('ben'), format('select 1 from public.messages where chat_id = %L', c)) = 0, 'removed member loses the messages');
  perform t_assert(t_count_as(uid('cara'), format('select 1 from public.profiles where id = %L', uid('ben'))) = 1, 'old author name still visible');
  -- ben is still in the home chat he was invited to
  perform t_assert(t_count_as(uid('ben'), 'select 1 from public.chats where project_id is null') = 1, 'home chat untouched');
  -- leaving by yourself
  perform public.app_remove_member(uid('cara'), p, uid('cara'));
  perform t_assert(public.project_role_of(uid('cara'), p) is null, 'cara left');
  -- only the host deletes the project
  perform t_fails(format($q$select public.app_delete_project(%L, %L)$q$, uid('dan'), p), 'forbidden');
  perform public.app_delete_project(uid('ana'), p);
  perform t_assert((select count(*) from public.chats where project_id = p) = 0, 'chats removed with the project');
  perform t_assert((select count(*) from public.messages where chat_id = c) = 0, 'messages removed with the project');
end $$;

-- crash recovery
do $$
declare hc uuid := (select id from ids where name = 'hc'); n int;
begin
  insert into public.messages (chat_id, author_id, role, status, content) values (hc, uid('ana'), 'user', 'processing', 'stuck');
  insert into public.messages (chat_id, role, status, content) values (hc, 'assistant', 'streaming', '');
  select count(*) into n from public.app_recover_stale_runs();
  perform t_assert(n >= 1, 'chat with waiting message reported');
  perform t_assert((select status from public.messages where content = 'stuck') = 'pending', 'processing goes back to pending');
  perform t_assert((select count(*) from public.messages where chat_id = hc and role = 'assistant' and status = 'error') = 1, 'streaming reply marked error');
end $$;
