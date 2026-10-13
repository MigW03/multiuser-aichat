-- Any member can rename a chat. Clients can't update chats directly (no UPDATE policy), so this goes through an RPC.
create function public.rename_chat(p_chat_id uuid, p_title text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_title text := trim(p_title);
begin
  if not public.is_chat_member(p_chat_id) then raise exception 'not a member of this chat'; end if;
  if v_title is null or v_title = '' then raise exception 'the title cannot be empty'; end if;
  if char_length(v_title) > 80 then raise exception 'the title is too long (80 characters max)'; end if;
  update public.chats set title = v_title where id = p_chat_id;
  return v_title;
end;
$$;

revoke execute on function public.rename_chat(uuid, text) from public, anon;
grant execute on function public.rename_chat(uuid, text) to authenticated;
