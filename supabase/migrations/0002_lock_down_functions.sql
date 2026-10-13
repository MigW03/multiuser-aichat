-- Only signed-in users may call the RPCs; the trigger function is never called directly.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

revoke execute on function public.create_chat(text) from public, anon;
grant execute on function public.create_chat(text) to authenticated;

revoke execute on function public.invite_to_chat(uuid, text) from public, anon;
grant execute on function public.invite_to_chat(uuid, text) to authenticated;

-- Used by RLS policies, which only apply to authenticated users.
revoke execute on function public.is_chat_member(uuid) from public, anon;
grant execute on function public.is_chat_member(uuid) to authenticated;

create or replace function public.max_chat_members() returns int
language sql immutable set search_path = '' as $$ select 2 $$;
