-- Multiuser AI chat: MVP schema

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------- chats
create table public.chats (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New chat',
  created_by uuid not null references public.profiles (id),
  -- Run lock: only one AI run per chat at a time. Expires so a crashed run can't block forever.
  run_lock_until timestamptz,
  created_at timestamptz not null default now()
);

create table public.chat_members (
  chat_id uuid not null references public.chats (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index on public.chat_members (user_id);

-- ---------------------------------------------------------------- messages
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  author_id uuid references public.profiles (id), -- null for the assistant
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  -- user: pending (queued) -> processing (in the current AI run) -> done | error
  -- assistant: streaming -> done | error
  status text not null check (status in ('pending', 'processing', 'streaming', 'done', 'error')),
  seq bigint generated always as identity,
  created_at timestamptz not null default now()
);
create index on public.messages (chat_id, seq);
create index on public.messages (chat_id, status);

-- ----------------------------------------------------------------- helpers
create function public.is_chat_member(p_chat_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.chat_members
    where chat_id = p_chat_id and user_id = auth.uid()
  );
$$;

-- MVP limit; raise later (target: 5).
create function public.max_chat_members() returns int
language sql immutable as $$ select 2 $$;

create function public.create_chat(p_title text default 'New chat') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.chats (title, created_by)
  values (coalesce(nullif(trim(p_title), ''), 'New chat'), auth.uid())
  returning id into v_id;
  insert into public.chat_members (chat_id, user_id) values (v_id, auth.uid());
  return v_id;
end;
$$;

-- Invite an existing user by email. Returns the invited user's display name.
create function public.invite_to_chat(p_chat_id uuid, p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_user public.profiles;
begin
  if not public.is_chat_member(p_chat_id) then raise exception 'not a member of this chat'; end if;
  select * into v_user from public.profiles where email = lower(trim(p_email));
  if not found then raise exception 'no account found for that email'; end if;
  if exists (select 1 from public.chat_members where chat_id = p_chat_id and user_id = v_user.id) then
    raise exception 'already in this chat';
  end if;
  if (select count(*) from public.chat_members where chat_id = p_chat_id) >= public.max_chat_members() then
    raise exception 'this chat is full';
  end if;
  insert into public.chat_members (chat_id, user_id) values (p_chat_id, v_user.id);
  return v_user.display_name;
end;
$$;

-- Atomically take the chat's run lock. Service role only (called from the server).
create function public.claim_chat_run(p_chat_id uuid, p_seconds int default 300) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_rows int;
begin
  update public.chats
     set run_lock_until = now() + make_interval(secs => p_seconds)
   where id = p_chat_id
     and (run_lock_until is null or run_lock_until < now());
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke execute on function public.claim_chat_run(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_chat_run(uuid, int) to service_role;

-- --------------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;

-- Profiles: you can see yourself and people you share a chat with.
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.chat_members a
      join public.chat_members b on a.chat_id = b.chat_id
      where a.user_id = auth.uid() and b.user_id = profiles.id
    )
  );
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy chats_select on public.chats for select to authenticated
  using (public.is_chat_member(id));

create policy chat_members_select on public.chat_members for select to authenticated
  using (public.is_chat_member(chat_id));

create policy messages_select on public.messages for select to authenticated
  using (public.is_chat_member(chat_id));
create policy messages_insert on public.messages for insert to authenticated
  with check (
    public.is_chat_member(chat_id)
    and author_id = auth.uid()
    and role = 'user'
    and status = 'pending'
  );
-- No client updates/deletes on chats, members or messages: only the server (service role) changes them.

-- ---------------------------------------------------------------- realtime
alter publication supabase_realtime add table public.messages;

-- Private broadcast channels named "chat:<chat_id>" (AI streaming snapshots + typing indicators).
create policy chat_broadcast_read on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and case when realtime.topic() like 'chat:%'
      then public.is_chat_member(split_part(realtime.topic(), ':', 2)::uuid)
      else false end
  );
create policy chat_broadcast_write on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and case when realtime.topic() like 'chat:%'
      then public.is_chat_member(split_part(realtime.topic(), ':', 2)::uuid)
      else false end
  );
