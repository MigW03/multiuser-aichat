-- Tests for 0014: remote MCP servers. Runs after test_mvp.sql, whose users and t_* helpers are still there.
do $$
declare i int;
begin
  -- clients have no access of any kind (the server reads and writes with the service role)
  perform t_fails_as(uid('ana'), $q$select 1 from public.user_mcp_servers$q$, 'permission denied');
  perform t_fails_as(uid('ana'), format($q$insert into public.user_mcp_servers (user_id, name, url, auth_kind) values (%L, 'x', 'https://example.com/mcp', 'none')$q$, uid('ana')), 'permission denied');

  -- a good row of each kind
  insert into public.user_mcp_servers (user_id, name, url, auth_kind) values (uid('ana'), 'plain', 'https://example.com/mcp', 'none');
  insert into public.user_mcp_servers (user_id, name, url, auth_kind, header_name, secret_enc, secret_hint) values (uid('ana'), 'keyed', 'https://example.com/mcp', 'header', 'Authorization', 'ciphertext', '4f2a');
  insert into public.user_mcp_servers (user_id, name, url, auth_kind, oauth_enc) values (uid('ana'), 'signed', 'https://example.com/mcp', 'oauth', 'ciphertext');

  -- the rules the server also checks
  perform t_fails(format($q$insert into public.user_mcp_servers (user_id, name, url, auth_kind) values (%L, 'plain', 'https://example.com/mcp', 'none')$q$, uid('ana')), 'duplicate key');
  perform t_fails(format($q$insert into public.user_mcp_servers (user_id, name, url, auth_kind) values (%L, 'bad name', 'https://example.com/mcp', 'none')$q$, uid('ana')), 'check');
  perform t_fails(format($q$insert into public.user_mcp_servers (user_id, name, url, auth_kind) values (%L, 'a', 'http://example.com/mcp', 'none')$q$, uid('ana')), 'check');
  perform t_fails(format($q$insert into public.user_mcp_servers (user_id, name, url, auth_kind) values (%L, 'a', 'https://example.com/mcp', 'weird')$q$, uid('ana')), 'check');
  perform t_fails(format($q$insert into public.user_mcp_servers (user_id, name, url, auth_kind) values (%L, 'a', 'https://example.com/mcp', 'header')$q$, uid('ana')), 'check'); -- a header needs its name and value
  perform t_fails(format($q$insert into public.user_mcp_servers (user_id, name, url, auth_kind, header_name, secret_enc, secret_hint) values (%L, 'a', 'https://example.com/mcp', 'none', 'X', 'c', 'abcd')$q$, uid('ana')), 'check'); -- secrets only with their kind
  perform t_fails(format($q$insert into public.user_mcp_servers (user_id, name, url, auth_kind, oauth_enc) values (%L, 'a', 'https://example.com/mcp', 'none', 'c')$q$, uid('ana')), 'check');
  perform t_fails(format($q$insert into public.user_mcp_servers (user_id, name, url, auth_kind, header_name, secret_enc, secret_hint) values (%L, 'a', 'https://example.com/mcp', 'header', 'Bad Header', 'c', 'abcd')$q$, uid('ana')), 'check');

  -- a pending sign-in's state is unique
  update public.user_mcp_servers set oauth_state = repeat('s', 40), oauth_state_expires = now() + interval '10 minutes' where user_id = uid('ana') and name = 'signed';
  insert into public.user_mcp_servers (user_id, name, url, auth_kind, oauth_enc) values (uid('ben'), 'signed', 'https://example.com/mcp', 'oauth', 'c');
  perform t_fails(format($q$update public.user_mcp_servers set oauth_state = %L where user_id = %L$q$, repeat('s', 40), uid('ben')), 'duplicate key');

  -- at most 10 per person; another person is not affected
  for i in 4..10 loop
    insert into public.user_mcp_servers (user_id, name, url, auth_kind) values (uid('ana'), 's' || i, 'https://example.com/mcp', 'none');
  end loop;
  perform t_assert((select count(*) from public.user_mcp_servers where user_id = uid('ana')) = 10, 'ten rows');
  perform t_fails(format($q$insert into public.user_mcp_servers (user_id, name, url, auth_kind) values (%L, 'eleventh', 'https://example.com/mcp', 'none')$q$, uid('ana')), 'too_many_servers');
  insert into public.user_mcp_servers (user_id, name, url, auth_kind) values (uid('ben'), 'another', 'https://example.com/mcp', 'none');

  -- the cap function is not callable by clients
  perform t_fails_as(uid('ana'), 'select public.user_mcp_servers_cap()', 'permission denied');
end $$;
