-- MVP data model: projects with roles, email invites, project chats, shared "home" chats, unread tracking.
--
-- Access model
--   * A project chat (chats.project_id is set) is visible to every member of the project.
--   * A home chat (chats.project_id is null) is visible to its chat_members: the creator plus invited people.
--   * Clients only READ through RLS. Every write goes through the server, which calls the app_* functions
--     below with the service role (they take the acting user explicitly and check permissions themselves).
--   * Own-row preferences (pins, read marker, favorites, profile display name and model pick) stay client writable.

-- ------------------------------------------------ limits
create function public.max_project_people() returns int
language sql immutable set search_path = '' as $$ select 10 $$;

-- ------------------------------------------------ projects
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('host', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index on public.project_members (user_id);
create unique index project_one_host on public.project_members (project_id) where role = 'host';

-- ------------------------------------------------ chats
alter table public.chats add column project_id uuid references public.projects (id) on delete cascade;
create index on public.chats (project_id);
-- Everyone in a project sees its chats; chat_members only holds people of home chats.
alter table public.chat_members drop column if exists ai_provider, drop column if exists ai_model;

-- ------------------------------------------------ invites (one email, 7 days)
-- Either a project invite (project_id) or a home chat invite (chat_id). Server only: no client access.
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default public.new_invite_token(),
  project_id uuid references public.projects (id) on delete cascade,
  chat_id uuid references public.chats (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) <= 254),
  role text not null default 'member' check (role in ('admin', 'member')),
  invited_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  revoked_at timestamptz,
  check ((project_id is null) <> (chat_id is null))
);
create index on public.invites (project_id) where project_id is not null;
create index on public.invites (chat_id) where chat_id is not null;
alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;

-- ------------------------------------------------ messages
alter table public.messages
  add column kind text not null default 'message' check (kind in ('message', 'summary_request', 'summary')),
  add column reply_to uuid references public.messages (id) on delete set null,
  add column mentions uuid[] not null default '{}' check (cardinality(mentions) <= 10),
  -- Why no AI answer was started for this message: it @tagged a person, or its author has no key.
  add column skip_reason text check (skip_reason in ('mention', 'no_key')),
  -- On answers: who asked, and whose key paid for it.
  add column for_user_id uuid references public.profiles (id) on delete set null,
  add column key_user_id uuid references public.profiles (id) on delete set null,
  add column reasoning text check (reasoning in ('off', 'low', 'medium', 'high')),
  -- User messages answered together share a run id with the answer.
  add column run_id uuid,
  -- Summary requests: { "scope": "unread" | "day" | "all", "from_seq": number }
  add column meta jsonb not null default '{}'::jsonb check (pg_column_size(meta) < 1000);
create index on public.messages (author_id);
create index on public.messages (run_id) where run_id is not null;

alter table public.profiles
  add column ai_reasoning text check (ai_reasoning in ('off', 'low', 'medium', 'high'));
grant update (display_name, ai_provider, ai_model, ai_reasoning) on public.profiles to authenticated;

-- ------------------------------------------------ per-person state
create table public.chat_reads (
  user_id uuid not null references public.profiles (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  last_seq bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, chat_id)
);
alter table public.chat_reads enable row level security;
create policy chat_reads_select on public.chat_reads for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.chat_reads from anon, authenticated;

create table public.chat_pins (
  user_id uuid not null references public.profiles (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  pinned_at timestamptz not null default now(),
  primary key (user_id, chat_id)
);
alter table public.chat_pins enable row level security;
create policy chat_pins_select on public.chat_pins for select to authenticated using (user_id = (select auth.uid()));
create policy chat_pins_insert on public.chat_pins for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_chat_member(chat_id));
create policy chat_pins_delete on public.chat_pins for delete to authenticated using (user_id = (select auth.uid()));
revoke update on public.chat_pins from anon, authenticated;

-- ------------------------------------------------ access helpers
create function public.user_can_access_chat(p_user uuid, p_chat uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.chats c
     where c.id = p_chat
       and case
             when c.project_id is not null
               then exists (select 1 from public.project_members pm where pm.project_id = c.project_id and pm.user_id = p_user)
             else exists (select 1 from public.chat_members cm where cm.chat_id = c.id and cm.user_id = p_user)
           end
  );
$$;

create function public.project_role_of(p_user uuid, p_project uuid) returns text
language sql stable security definer set search_path = '' as $$
  select pm.role from public.project_members pm where pm.project_id = p_project and pm.user_id = p_user
$$;

-- Used by RLS policies and realtime policies (always about the signed-in user).
create or replace function public.is_chat_member(p_chat_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.user_can_access_chat((select auth.uid()), p_chat_id)
$$;

create function public.is_project_member(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.project_role_of((select auth.uid()), p_project_id) is not null
$$;

revoke execute on function public.user_can_access_chat(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.project_role_of(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.is_project_member(uuid) from public, anon;
grant execute on function public.user_can_access_chat(uuid, uuid) to service_role;
grant execute on function public.project_role_of(uuid, uuid) to service_role;
grant execute on function public.is_project_member(uuid) to authenticated;

-- ------------------------------------------------ RLS: read only
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
create policy projects_select on public.projects for select to authenticated using (public.is_project_member(id));
create policy project_members_select on public.project_members for select to authenticated using (public.is_project_member(project_id));
revoke insert, update, delete on public.projects, public.project_members from anon, authenticated;
revoke all on public.projects, public.project_members from anon;
-- Defence in depth: these have no write policies either; only the server writes them.
revoke insert, update, delete on public.chats, public.chat_members, public.messages from anon, authenticated;

-- Profiles: yourself, people who share a project or chat with you, and authors of messages you can read
-- (a removed member's old messages keep their name).
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.project_members a
      join public.project_members b on a.project_id = b.project_id
      where a.user_id = (select auth.uid()) and b.user_id = profiles.id
    )
    or exists (
      select 1 from public.chat_members a
      join public.chat_members b on a.chat_id = b.chat_id
      where a.user_id = (select auth.uid()) and b.user_id = profiles.id
    )
    or exists (
      select 1 from public.messages m
      where m.author_id = profiles.id and public.is_chat_member(m.chat_id)
    )
  );

-- ------------------------------------------------ realtime
alter publication supabase_realtime add table public.chats, public.projects, public.project_members, public.chat_members;

drop policy chat_broadcast_read on realtime.messages;
drop policy chat_broadcast_write on realtime.messages;
-- Channels: "chat:<chat id>" (stream snapshots, typing) and "project:<project id>" (presence).
create function public.can_use_realtime_topic(p_topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_topic ~ '^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.is_chat_member(split_part(p_topic, ':', 2)::uuid)
    when p_topic ~ '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.is_project_member(split_part(p_topic, ':', 2)::uuid)
    else false
  end
$$;
revoke execute on function public.can_use_realtime_topic(text) from public, anon;
grant execute on function public.can_use_realtime_topic(text) to authenticated;

create policy realtime_topic_read on realtime.messages for select to authenticated
  using (realtime.messages.extension in ('broadcast', 'presence') and public.can_use_realtime_topic(realtime.topic()));
create policy realtime_topic_write on realtime.messages for insert to authenticated
  with check (realtime.messages.extension in ('broadcast', 'presence') and public.can_use_realtime_topic(realtime.topic()));

-- ------------------------------------------------ retire the prototype's client-side RPCs and link invites
drop function if exists public.create_chat(text);
drop function if exists public.invite_to_chat(uuid, text);
drop function if exists public.rename_chat(uuid, text);
drop function if exists public.set_chat_model(uuid, text, text);
drop function if exists public.get_chat_invite_link(uuid);
drop function if exists public.reset_chat_invite_link(uuid);
drop function if exists public.preview_chat_invite(text);
drop function if exists public.accept_chat_invite(text);
drop table if exists public.chat_invite_links;
drop function if exists public.max_chat_members();

-- ------------------------------------------------ read helpers for the client (security invoker: RLS applies)
-- Unread messages per chat for the signed-in user. Without a read marker, everything before they joined counts as read.
create view public.chat_unread with (security_invoker = true) as
select c.id as chat_id,
       (count(m.id) filter (where m.role = 'user' and m.kind = 'message' and m.author_id is distinct from (select auth.uid())))::int as people,
       (count(m.id) filter (where m.role = 'assistant' and m.status = 'done'))::int as ai
  from public.chats c
  left join public.messages m
    on m.chat_id = c.id
   and m.seq > coalesce(
         (select r.last_seq from public.chat_reads r where r.chat_id = c.id and r.user_id = (select auth.uid())),
         (select coalesce(max(m2.seq), 0) from public.messages m2
           where m2.chat_id = c.id
             and m2.created_at <= coalesce(
                   (select pm.joined_at from public.project_members pm where pm.project_id = c.project_id and pm.user_id = (select auth.uid())),
                   (select cm.joined_at from public.chat_members cm where cm.chat_id = c.id and cm.user_id = (select auth.uid())))))
 group by c.id;

create function public.chat_list(p_project uuid default null)
returns table (
  id uuid, title text, project_id uuid, created_by uuid, created_at timestamptz,
  last_message_at timestamptz, preview text, preview_role text, preview_author uuid,
  member_count int, pinned boolean, unread_people int, unread_ai int
)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.title, c.project_id, c.created_by, c.created_at,
         coalesce(lm.created_at, c.created_at),
         left(lm.content, 160), lm.role, lm.author_id,
         (select count(*)::int from public.chat_members cm where cm.chat_id = c.id),
         exists (select 1 from public.chat_pins p where p.chat_id = c.id and p.user_id = (select auth.uid())),
         coalesce(u.people, 0), coalesce(u.ai, 0)
    from public.chats c
    left join lateral (
      select m.created_at, m.content, m.role, m.author_id
        from public.messages m
       where m.chat_id = c.id and m.status in ('done', 'streaming', 'pending', 'processing') and m.kind <> 'summary_request'
       order by m.seq desc limit 1
    ) lm on true
    left join public.chat_unread u on u.chat_id = c.id
   where c.project_id is not distinct from p_project
$$;

create function public.project_list()
returns table (
  id uuid, name text, created_by uuid, created_at timestamptz, my_role text, member_count int, unread_people int, unread_ai int
)
language sql stable security invoker set search_path = '' as $$
  select p.id, p.name, p.created_by, p.created_at, pm.role,
         (select count(*)::int from public.project_members x where x.project_id = p.id),
         coalesce(sum(u.people), 0)::int, coalesce(sum(u.ai), 0)::int
    from public.projects p
    join public.project_members pm on pm.project_id = p.id and pm.user_id = (select auth.uid())
    left join public.chats c on c.project_id = p.id
    left join public.chat_unread u on u.chat_id = c.id
   group by p.id, pm.role
$$;

-- Marks everything in the chat as read for the signed-in user. Opening a chat calls this.
create function public.mark_chat_read(p_chat_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_chat_member(p_chat_id) then raise exception 'not a member of this chat'; end if;
  insert into public.chat_reads (user_id, chat_id, last_seq)
  values (auth.uid(), p_chat_id, coalesce((select max(seq) from public.messages where chat_id = p_chat_id), 0))
  on conflict (user_id, chat_id) do update
    set last_seq = greatest(public.chat_reads.last_seq, excluded.last_seq), updated_at = now();
end;
$$;

-- Plain text search over the chats the caller can read (RLS filters the rest). % _ \ in the query are literal.
create function public.search_messages(p_query text, p_project uuid default null)
returns table (chat_id uuid, message_id uuid, snippet text, created_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.chat_id, m.id, left(m.content, 200), m.created_at
    from public.messages m
    join public.chats c on c.id = m.chat_id
   where c.project_id is not distinct from p_project
     and m.kind in ('message', 'summary')
     and m.status = 'done'
     and char_length(trim(p_query)) between 2 and 100
     and m.content ilike '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
   order by m.seq desc
   limit 30
$$;

revoke execute on function public.chat_list(uuid), public.project_list(), public.mark_chat_read(uuid), public.search_messages(text, uuid) from public, anon;
grant execute on function public.chat_list(uuid), public.project_list(), public.mark_chat_read(uuid), public.search_messages(text, uuid) to authenticated;
grant select on public.chat_unread to authenticated;
revoke all on public.chat_unread from anon;

-- ================================================================== server-only functions (service role)
-- Each takes the acting user and raises a short code the server maps to a message:
-- forbidden, not_found, invalid_*, project_full, chat_full, already_member, host_cannot_leave, wrong_account, ...

create function public.app_create_project(p_user uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_id uuid;
begin
  if char_length(v_name) not between 1 and 60 then raise exception 'invalid_name'; end if;
  insert into public.projects (name, created_by) values (v_name, p_user) returning id into v_id;
  insert into public.project_members (project_id, user_id, role) values (v_id, p_user, 'host');
  return v_id;
end;
$$;

create function public.app_rename_project(p_user uuid, p_project uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
begin
  if char_length(v_name) not between 1 and 60 then raise exception 'invalid_name'; end if;
  if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  if public.project_role_of(p_user, p_project) not in ('host', 'admin') then raise exception 'forbidden'; end if;
  update public.projects set name = v_name where id = p_project;
end;
$$;

create function public.app_delete_project(p_user uuid, p_project uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  if public.project_role_of(p_user, p_project) <> 'host' then raise exception 'forbidden'; end if;
  delete from public.projects where id = p_project;
end;
$$;

create function public.app_create_chat(p_user uuid, p_project uuid, p_title text default 'New chat') returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_title text := coalesce(nullif(trim(coalesce(p_title, '')), ''), 'New chat');
  v_id uuid;
begin
  if char_length(v_title) > 80 then raise exception 'invalid_name'; end if;
  if p_project is not null and public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  insert into public.chats (title, created_by, project_id) values (v_title, p_user, p_project) returning id into v_id;
  if p_project is null then
    insert into public.chat_members (chat_id, user_id) values (v_id, p_user);
  end if;
  return v_id;
end;
$$;

create function public.app_rename_chat(p_user uuid, p_chat uuid, p_title text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_title text := trim(coalesce(p_title, ''));
begin
  if char_length(v_title) not between 1 and 80 then raise exception 'invalid_name'; end if;
  if not public.user_can_access_chat(p_user, p_chat) then raise exception 'not_found'; end if;
  update public.chats set title = v_title where id = p_chat;
  return v_title;
end;
$$;

-- Project chats: their creator or an admin/host. Home chats: their creator.
create function public.app_delete_chat(p_user uuid, p_chat uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_chat public.chats;
begin
  if not public.user_can_access_chat(p_user, p_chat) then raise exception 'not_found'; end if;
  select * into v_chat from public.chats where id = p_chat;
  if v_chat.created_by <> p_user
     and (v_chat.project_id is null or public.project_role_of(p_user, v_chat.project_id) not in ('host', 'admin')) then
    raise exception 'forbidden';
  end if;
  delete from public.chats where id = p_chat;
end;
$$;

-- Creates an invite for a project (p_project) or a home chat (p_chat). Pending invites count toward the cap.
create function public.app_create_invite(p_user uuid, p_project uuid, p_chat uuid, p_email text, p_role text default 'member')
returns table (invite_id uuid, invite_token text, invite_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_role text := coalesce(nullif(p_role, ''), 'member');
  v_inv public.invites;
  v_taken int;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_email) > 254 then raise exception 'invalid_email'; end if;
  if (p_project is null) = (p_chat is null) then raise exception 'invalid_scope'; end if;

  if p_project is not null then
    perform 1 from public.projects where id = p_project for update;
    if not found or public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
    if public.project_role_of(p_user, p_project) not in ('host', 'admin') then raise exception 'forbidden'; end if;
    if v_role not in ('admin', 'member') then raise exception 'invalid_role'; end if;
    if exists (
      select 1 from public.project_members pm join public.profiles pr on pr.id = pm.user_id
       where pm.project_id = p_project and pr.email = v_email
    ) then raise exception 'already_member'; end if;
    -- a new invite replaces an older pending one for the same address
    update public.invites i set revoked_at = now()
     where i.project_id = p_project and i.email = v_email and i.accepted_at is null and i.revoked_at is null;
    select (select count(*) from public.project_members where project_id = p_project)
         + (select count(*) from public.invites i
             where i.project_id = p_project and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
      into v_taken;
    if v_taken >= public.max_project_people() then raise exception 'project_full'; end if;
  else
    perform 1 from public.chats where id = p_chat and project_id is null for update;
    if not found or not public.user_can_access_chat(p_user, p_chat) then raise exception 'not_found'; end if;
    v_role := 'member';
    if exists (
      select 1 from public.chat_members cm join public.profiles pr on pr.id = cm.user_id
       where cm.chat_id = p_chat and pr.email = v_email
    ) then raise exception 'already_member'; end if;
    update public.invites i set revoked_at = now()
     where i.chat_id = p_chat and i.email = v_email and i.accepted_at is null and i.revoked_at is null;
    select (select count(*) from public.chat_members where chat_id = p_chat)
         + (select count(*) from public.invites i
             where i.chat_id = p_chat and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
      into v_taken;
    if v_taken >= public.max_project_people() then raise exception 'chat_full'; end if;
  end if;

  insert into public.invites (project_id, chat_id, email, role, invited_by)
  values (p_project, p_chat, v_email, v_role, p_user)
  returning * into v_inv;
  return query select v_inv.id, v_inv.token, v_inv.expires_at;
end;
$$;

-- Pending invites of a project (admins and host) or a home chat (any chat member).
create function public.app_list_invites(p_user uuid, p_project uuid, p_chat uuid)
returns table (invite_id uuid, email text, role text, token text, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if (p_project is null) = (p_chat is null) then raise exception 'invalid_scope'; end if;
  if p_project is not null then
    if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
    if public.project_role_of(p_user, p_project) not in ('host', 'admin') then raise exception 'forbidden'; end if;
  elsif not public.user_can_access_chat(p_user, p_chat) or exists (select 1 from public.chats where id = p_chat and project_id is not null) then
    raise exception 'not_found';
  end if;
  return query
    select i.id, i.email, i.role, i.token, i.created_at, i.expires_at
      from public.invites i
     where i.project_id is not distinct from p_project and i.chat_id is not distinct from p_chat
       and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
     order by i.created_at;
end;
$$;

create function public.app_revoke_invite(p_user uuid, p_invite uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.invites;
begin
  select * into v_inv from public.invites where id = p_invite;
  if not found then raise exception 'not_found'; end if;
  if v_inv.project_id is not null then
    if public.project_role_of(p_user, v_inv.project_id) is null then raise exception 'not_found'; end if;
    if public.project_role_of(p_user, v_inv.project_id) not in ('host', 'admin') then raise exception 'forbidden'; end if;
  elsif not public.user_can_access_chat(p_user, v_inv.chat_id) then
    raise exception 'not_found';
  end if;
  update public.invites set revoked_at = now() where id = p_invite and accepted_at is null and revoked_at is null;
end;
$$;

-- What the join page shows. Anyone holding the (unguessable) token may see it.
create function public.app_preview_invite(p_token text)
returns table (status text, scope text, name text, inviter_name text, role text, email text, members jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.invites;
  v_scope text;
  v_name text;
  v_members jsonb;
  v_taken int;
begin
  select * into v_inv from public.invites where token = p_token;
  if not found then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, '[]'::jsonb;
    return;
  end if;
  if v_inv.project_id is not null then
    v_scope := 'project';
    select p.name into v_name from public.projects p where p.id = v_inv.project_id;
    select coalesce(jsonb_agg(jsonb_build_object('name', pr.display_name, 'role', pm.role) order by pm.joined_at), '[]'::jsonb)
      into v_members
      from public.project_members pm join public.profiles pr on pr.id = pm.user_id where pm.project_id = v_inv.project_id;
    select count(*) into v_taken from public.project_members where project_id = v_inv.project_id;
  else
    v_scope := 'chat';
    select c.title into v_name from public.chats c where c.id = v_inv.chat_id;
    select coalesce(jsonb_agg(jsonb_build_object('name', pr.display_name, 'role', 'member') order by cm.joined_at), '[]'::jsonb)
      into v_members
      from public.chat_members cm join public.profiles pr on pr.id = cm.user_id where cm.chat_id = v_inv.chat_id;
    select count(*) into v_taken from public.chat_members where chat_id = v_inv.chat_id;
  end if;
  return query
    select case
             when v_inv.accepted_at is not null then 'used'
             when v_inv.revoked_at is not null or v_inv.expires_at <= now() then 'expired'
             when v_taken >= public.max_project_people() then 'full'
             else 'valid'
           end,
           v_scope, v_name, (select pr.display_name from public.profiles pr where pr.id = v_inv.invited_by),
           v_inv.role, v_inv.email, v_members;
end;
$$;

-- Joins the project or chat behind the invite. The account's confirmed email must match the invite.
create function public.app_accept_invite(p_user uuid, p_token text)
returns table (out_project_id uuid, out_chat_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.invites;
  v_email text;
  v_confirmed timestamptz;
  v_members int;
begin
  select * into v_inv from public.invites where token = p_token for update;
  if not found then raise exception 'invalid_invite'; end if;

  select pr.email, u.email_confirmed_at into v_email, v_confirmed
    from public.profiles pr join auth.users u on u.id = pr.id where pr.id = p_user;
  if not found then raise exception 'forbidden'; end if;

  -- Idempotent for people who are already in.
  if v_inv.project_id is not null and public.project_role_of(p_user, v_inv.project_id) is not null then
    return query select v_inv.project_id, v_inv.chat_id; return;
  end if;
  if v_inv.chat_id is not null and public.user_can_access_chat(p_user, v_inv.chat_id) then
    return query select v_inv.project_id, v_inv.chat_id; return;
  end if;

  if v_inv.revoked_at is not null or v_inv.expires_at <= now() then raise exception 'invite_expired'; end if;
  if v_inv.accepted_at is not null then raise exception 'invite_used'; end if;
  if v_email is distinct from v_inv.email then raise exception 'wrong_account'; end if;
  if v_confirmed is null then raise exception 'email_not_confirmed'; end if;

  if v_inv.project_id is not null then
    perform 1 from public.projects where id = v_inv.project_id for update;
    select count(*) into v_members from public.project_members where project_id = v_inv.project_id;
    if v_members >= public.max_project_people() then raise exception 'project_full'; end if;
    insert into public.project_members (project_id, user_id, role) values (v_inv.project_id, p_user, v_inv.role);
  else
    perform 1 from public.chats where id = v_inv.chat_id for update;
    select count(*) into v_members from public.chat_members where chat_id = v_inv.chat_id;
    if v_members >= public.max_project_people() then raise exception 'chat_full'; end if;
    insert into public.chat_members (chat_id, user_id) values (v_inv.chat_id, p_user);
  end if;
  update public.invites set accepted_at = now() where id = v_inv.id;
  return query select v_inv.project_id, v_inv.chat_id;
end;
$$;

-- Admins and the host change roles; nobody changes the host or their own role.
create function public.app_set_member_role(p_user uuid, p_project uuid, p_target uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_role not in ('admin', 'member') then raise exception 'invalid_role'; end if;
  if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  if public.project_role_of(p_user, p_project) not in ('host', 'admin') then raise exception 'forbidden'; end if;
  if public.project_role_of(p_target, p_project) is null then raise exception 'not_found'; end if;
  if public.project_role_of(p_target, p_project) = 'host' or p_target = p_user then raise exception 'forbidden'; end if;
  update public.project_members set role = p_role where project_id = p_project and user_id = p_target;
end;
$$;

-- Removes a member (or lets someone leave). The host cannot be removed; their messages stay in the chats.
create function public.app_remove_member(p_user uuid, p_project uuid, p_target uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  if public.project_role_of(p_target, p_project) is null then raise exception 'not_found'; end if;
  if public.project_role_of(p_target, p_project) = 'host' then raise exception 'host_cannot_leave'; end if;
  if p_user <> p_target and public.project_role_of(p_user, p_project) not in ('host', 'admin') then raise exception 'forbidden'; end if;
  delete from public.project_members where project_id = p_project and user_id = p_target;
  delete from public.chat_reads where user_id = p_target and chat_id in (select id from public.chats where project_id = p_project);
  delete from public.chat_pins where user_id = p_target and chat_id in (select id from public.chats where project_id = p_project);
end;
$$;

-- After a crash: finish what was in flight and report which chats still have waiting messages.
create function public.app_recover_stale_runs() returns setof uuid
language plpgsql security definer set search_path = '' as $$
begin
  update public.messages m set status = 'error', content = case when m.content = '' then 'The reply was interrupted.' else m.content end
   where m.role = 'assistant' and m.status = 'streaming'
     and exists (select 1 from public.chats c where c.id = m.chat_id and (c.run_lock_until is null or c.run_lock_until < now()));
  update public.messages m set status = 'pending', run_id = null
   where m.role = 'user' and m.status = 'processing'
     and exists (select 1 from public.chats c where c.id = m.chat_id and (c.run_lock_until is null or c.run_lock_until < now()));
  return query select distinct m.chat_id from public.messages m where m.role = 'user' and m.status = 'pending';
end;
$$;

-- Everyone the AI should be able to name in a chat: its current people plus authors of its messages.
create function public.app_chat_people(p_chat_id uuid) returns table (id uuid, display_name text)
language sql stable security definer set search_path = '' as $$
  select distinct pr.id, pr.display_name
    from public.profiles pr
   where pr.id in (
           select pm.user_id from public.project_members pm join public.chats c on c.project_id = pm.project_id where c.id = p_chat_id
           union select cm.user_id from public.chat_members cm where cm.chat_id = p_chat_id
           union select m.author_id from public.messages m where m.chat_id = p_chat_id and m.author_id is not null)
$$;


revoke execute on function
  public.app_create_project(uuid, text), public.app_rename_project(uuid, uuid, text), public.app_delete_project(uuid, uuid),
  public.app_create_chat(uuid, uuid, text), public.app_rename_chat(uuid, uuid, text), public.app_delete_chat(uuid, uuid),
  public.app_create_invite(uuid, uuid, uuid, text, text), public.app_list_invites(uuid, uuid, uuid), public.app_revoke_invite(uuid, uuid),
  public.app_preview_invite(text), public.app_accept_invite(uuid, text),
  public.app_set_member_role(uuid, uuid, uuid, text), public.app_remove_member(uuid, uuid, uuid), public.app_recover_stale_runs(), public.app_chat_people(uuid)
  from public, anon, authenticated;
grant execute on function
  public.app_create_project(uuid, text), public.app_rename_project(uuid, uuid, text), public.app_delete_project(uuid, uuid),
  public.app_create_chat(uuid, uuid, text), public.app_rename_chat(uuid, uuid, text), public.app_delete_chat(uuid, uuid),
  public.app_create_invite(uuid, uuid, uuid, text, text), public.app_list_invites(uuid, uuid, uuid), public.app_revoke_invite(uuid, uuid),
  public.app_preview_invite(text), public.app_accept_invite(uuid, text),
  public.app_set_member_role(uuid, uuid, uuid, text), public.app_remove_member(uuid, uuid, uuid), public.app_recover_stale_runs(), public.app_chat_people(uuid)
  to service_role;

-- ================================================================== anon gets nothing
-- Signed-out visitors only talk to the server (invite previews go through it). Supabase grants anon access to new
-- tables by default; RLS already hides the rows, this removes the privilege as well.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
