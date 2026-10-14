-- Shareable invite links. Anyone with the link who is signed in can join, until it expires or is reset.
-- The table has no client access; everything goes through the RPCs below.
create table public.chat_invite_links (
  token text primary key,
  chat_id uuid not null references public.chats (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  revoked_at timestamptz
);
create index on public.chat_invite_links (chat_id);
alter table public.chat_invite_links enable row level security;
revoke all on public.chat_invite_links from anon, authenticated;

-- 244 random bits from two v4 UUIDs (gen_random_uuid uses a cryptographically secure source).
create function public.new_invite_token() returns text
language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

-- The chat's current link, or a new one if there is none with at least a day left.
create function public.get_chat_invite_link(p_chat_id uuid)
returns table (token text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_chat_member(p_chat_id) then raise exception 'not a member of this chat'; end if;
  return query
    select l.token, l.expires_at from public.chat_invite_links l
     where l.chat_id = p_chat_id and l.revoked_at is null and l.expires_at > now() + interval '1 day'
     order by l.created_at desc limit 1;
  if found then return; end if;
  return query
    insert into public.chat_invite_links (token, chat_id, created_by)
    values (public.new_invite_token(), p_chat_id, auth.uid())
    returning chat_invite_links.token, chat_invite_links.expires_at;
end;
$$;

-- Invalidates every existing link for the chat and returns a fresh one.
create function public.reset_chat_invite_link(p_chat_id uuid)
returns table (token text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_chat_member(p_chat_id) then raise exception 'not a member of this chat'; end if;
  update public.chat_invite_links set revoked_at = now() where chat_id = p_chat_id and revoked_at is null;
  return query
    insert into public.chat_invite_links (token, chat_id, created_by)
    values (public.new_invite_token(), p_chat_id, auth.uid())
    returning chat_invite_links.token, chat_invite_links.expires_at;
end;
$$;

-- What the invite page shows before joining. Only reveals the chat title and inviter's name to holders of the link.
create function public.preview_chat_invite(p_token text)
returns table (status text, chat_id uuid, chat_title text, inviter_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_link public.chat_invite_links;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_link from public.chat_invite_links where token = p_token;
  if not found then return query select 'invalid'::text, null::uuid, null::text, null::text; return; end if;

  return query
    select
      case
        when exists (select 1 from public.chat_members m where m.chat_id = v_link.chat_id and m.user_id = auth.uid()) then 'member'
        when v_link.revoked_at is not null or v_link.expires_at <= now() then 'expired'
        when (select count(*) from public.chat_members m where m.chat_id = v_link.chat_id) >= public.max_chat_members() then 'full'
        else 'valid'
      end,
      c.id, c.title, p.display_name
    from public.chats c
    join public.profiles p on p.id = v_link.created_by
    where c.id = v_link.chat_id;
end;
$$;

-- Joins the chat behind a valid link. Idempotent for existing members.
create function public.accept_chat_invite(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_link public.chat_invite_links;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_link from public.chat_invite_links where token = p_token;
  if not found then raise exception 'this invite link is not valid'; end if;
  if exists (select 1 from public.chat_members where chat_id = v_link.chat_id and user_id = auth.uid()) then
    return v_link.chat_id;
  end if;
  if v_link.revoked_at is not null or v_link.expires_at <= now() then raise exception 'this invite link has expired'; end if;

  -- Lock the chat so two people accepting at once can't push it past the member limit.
  perform 1 from public.chats where id = v_link.chat_id for update;
  if (select count(*) from public.chat_members where chat_id = v_link.chat_id) >= public.max_chat_members() then
    raise exception 'this chat is full';
  end if;
  insert into public.chat_members (chat_id, user_id) values (v_link.chat_id, auth.uid());
  return v_link.chat_id;
end;
$$;

revoke execute on function public.new_invite_token() from public, anon, authenticated;
revoke execute on function public.get_chat_invite_link(uuid) from public, anon;
revoke execute on function public.reset_chat_invite_link(uuid) from public, anon;
revoke execute on function public.preview_chat_invite(text) from public, anon;
revoke execute on function public.accept_chat_invite(text) from public, anon;
grant execute on function public.get_chat_invite_link(uuid) to authenticated;
grant execute on function public.reset_chat_invite_link(uuid) to authenticated;
grant execute on function public.preview_chat_invite(text) to authenticated;
grant execute on function public.accept_chat_invite(text) to authenticated;
