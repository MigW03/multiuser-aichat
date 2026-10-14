-- AI runs from the desktop app. Each person's app answers that person's own messages with an API key
-- kept on their computer, so the database has to let a signed-in member claim a run and save its reply.
-- The existing server runner (claim_chat_run, service role) keeps working: both use chats.run_lock_until.

alter table public.chats add column run_by uuid references public.profiles (id) on delete set null;

-- A run whose lock expired without finishing (the app quit or crashed) left its messages mid-flight.
create function public.recover_stale_run(p_chat_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.chats where id = p_chat_id and run_lock_until is not null and run_lock_until > now()) then
    return;
  end if;
  update public.messages set status = 'error', content = case when content = '' then 'The reply was interrupted.' else content end
   where chat_id = p_chat_id and role = 'assistant' and status = 'streaming';
  update public.messages set status = 'pending'
   where chat_id = p_chat_id and role = 'user' and status = 'processing';
end;
$$;

-- Takes the chat's run lock for the caller and moves the caller's pending messages into the run.
-- Returns the new (empty, streaming) assistant message id, or null when there is nothing to do
-- or another run holds the lock (try again shortly).
create function public.start_ai_run(p_chat_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_rows int;
  v_last public.messages;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not public.is_chat_member(p_chat_id) then raise exception 'not a member of this chat'; end if;

  perform public.recover_stale_run(p_chat_id);

  update public.chats
     set run_lock_until = now() + interval '5 minutes', run_by = v_uid
   where id = p_chat_id and (run_lock_until is null or run_lock_until < now());
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return null; end if;

  select * into v_last from public.messages
   where chat_id = p_chat_id and author_id = v_uid and role = 'user' and status = 'pending'
   order by seq desc limit 1;
  if not found then
    update public.chats set run_lock_until = null, run_by = null where id = p_chat_id;
    return null;
  end if;

  update public.messages set status = 'processing'
   where chat_id = p_chat_id and author_id = v_uid and role = 'user' and status = 'pending';

  insert into public.messages (chat_id, role, status, content, provider, model)
  values (p_chat_id, 'assistant', 'streaming', '', v_last.provider, v_last.model)
  returning id into v_id;
  return v_id;
end;
$$;

-- Saves the reply and releases the lock. Only the member who started the run can finish it.
create function public.finish_ai_run(p_message_id uuid, p_content text, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_chat_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select m.chat_id into v_chat_id
    from public.messages m join public.chats c on c.id = m.chat_id
   where m.id = p_message_id and m.role = 'assistant' and m.status = 'streaming' and c.run_by = v_uid;
  if not found then raise exception 'this run is not yours or has already finished'; end if;

  update public.messages
     set content = left(coalesce(p_content, ''), 200000), status = case when p_ok then 'done' else 'error' end
   where id = p_message_id;
  update public.messages set status = case when p_ok then 'done' else 'error' end
   where chat_id = v_chat_id and author_id = v_uid and role = 'user' and status = 'processing';
  update public.chats set run_lock_until = null, run_by = null where id = v_chat_id;
end;
$$;

-- Keeps a long reply's lock alive.
create function public.extend_ai_run(p_chat_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.chats set run_lock_until = now() + interval '5 minutes'
   where id = p_chat_id and run_by = auth.uid() and run_lock_until > now();
$$;

revoke execute on function public.recover_stale_run(uuid) from public, anon, authenticated;
revoke execute on function public.start_ai_run(uuid) from public, anon;
revoke execute on function public.finish_ai_run(uuid, text, boolean) from public, anon;
revoke execute on function public.extend_ai_run(uuid) from public, anon;
grant execute on function public.start_ai_run(uuid) to authenticated;
grant execute on function public.finish_ai_run(uuid, text, boolean) to authenticated;
grant execute on function public.extend_ai_run(uuid) to authenticated;
