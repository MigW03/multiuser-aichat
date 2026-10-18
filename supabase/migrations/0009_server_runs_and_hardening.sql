-- AI runs move back to the server (service role), so the client-side run functions from 0008 go away.
-- Also fixes findings from the 2026-10-14 security audit.

-- ------------------------------------------------ remove client-side AI runs (audit M2, L1, M5)
drop function if exists public.start_ai_run(uuid);
drop function if exists public.finish_ai_run(uuid, text, boolean);
drop function if exists public.extend_ai_run(uuid);
drop function if exists public.recover_stale_run(uuid);
alter table public.chats drop column if exists run_by;

-- Only the server sends messages now (it checks the key, inserts as the sender and runs the AI).
drop policy if exists messages_insert on public.messages;

-- ------------------------------------------------ H1: profiles.email is no longer user-writable
revoke update on public.profiles from authenticated;
grant update (display_name, ai_provider, ai_model) on public.profiles to authenticated;

-- Keep profiles.email equal to the auth email, which only Supabase Auth changes (after verification when enabled).
create function public.sync_profile_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = lower(new.email) where id = new.id;
  return new;
end;
$$;
revoke execute on function public.sync_profile_email() from public, anon, authenticated;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.sync_profile_email();

-- Repair any profile whose email was changed through the old grant.
update public.profiles p set email = lower(u.email)
  from auth.users u
 where u.id = p.id and p.email is distinct from lower(u.email);

-- ------------------------------------------------ M1, L3: length limits
update public.profiles set display_name = left(display_name, 60) where char_length(display_name) > 60;
alter table public.profiles add constraint display_name_len check (char_length(display_name) between 1 and 60);
update public.chats set title = left(title, 80) where char_length(title) > 80;
alter table public.chats add constraint title_len check (char_length(title) between 1 and 80);
alter table public.messages add constraint content_len check (char_length(content) <= 200000);
alter table public.messages add constraint model_format check (model is null or model ~ '^[A-Za-z0-9._:/@-]{1,200}$');

-- ------------------------------------------------ M3: invite_to_chat
-- Locks the chat before counting members, and answers "no account" and "already in this chat" the same way
-- so it can't be used to check which emails have accounts.
create or replace function public.invite_to_chat(p_chat_id uuid, p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_user public.profiles;
begin
  if not public.is_chat_member(p_chat_id) then raise exception 'not a member of this chat'; end if;
  perform 1 from public.chats where id = p_chat_id for update;
  select * into v_user from public.profiles where email = lower(trim(p_email));
  if not found or exists (select 1 from public.chat_members where chat_id = p_chat_id and user_id = v_user.id) then
    raise exception 'could not add that person (check the email, or they may already be in this chat)';
  end if;
  if (select count(*) from public.chat_members where chat_id = p_chat_id) >= public.max_chat_members() then
    raise exception 'this chat is full';
  end if;
  insert into public.chat_members (chat_id, user_id) values (p_chat_id, v_user.id);
  return v_user.display_name;
end;
$$;
revoke execute on function public.invite_to_chat(uuid, text) from public, anon;
grant execute on function public.invite_to_chat(uuid, text) to authenticated;
