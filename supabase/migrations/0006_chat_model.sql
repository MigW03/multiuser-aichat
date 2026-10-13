-- A member's chosen model is remembered per chat (and as their latest pick for new chats).
alter table public.chat_members
  add column ai_provider text check (ai_provider in ('openrouter', 'anthropic', 'openai')),
  add column ai_model text check (char_length(ai_model) <= 200);

-- Members can't update chat_members directly (that would let them edit chat_id/user_id), so this RPC
-- changes only the caller's own row.
create function public.set_chat_model(p_chat_id uuid, p_provider text, p_model text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_model text := trim(p_model);
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_provider not in ('openrouter', 'anthropic', 'openai') then raise exception 'unknown provider'; end if;
  if v_model is null or char_length(v_model) not between 1 and 200 then raise exception 'invalid model'; end if;

  update public.chat_members set ai_provider = p_provider, ai_model = v_model
   where chat_id = p_chat_id and user_id = auth.uid();
  if not found then raise exception 'not a member of this chat'; end if;

  update public.profiles set ai_provider = p_provider, ai_model = v_model where id = auth.uid();
end;
$$;

revoke execute on function public.set_chat_model(uuid, text, text) from public, anon;
grant execute on function public.set_chat_model(uuid, text, text) to authenticated;
