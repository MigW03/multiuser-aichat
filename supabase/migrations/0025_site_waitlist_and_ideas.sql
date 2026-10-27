-- Coming-soon website (site/): the waitlist and the "help us decide what to build next" ideas.
--
--   * Anyone on the site can add, nobody can read. The public (anon) role only gets the two functions below; the tables
--     themselves are closed to anon and signed-in users. Miguel reads them in the Supabase dashboard (service role).
--   * Joining twice answers the same as joining once, so the site never tells anyone whether an email is on the list.
--   * Light rate limits: per sender (a hash of the IP with a random secret salt, never the IP itself) and overall, so a
--     script can't flood the tables.

create table public.site_waitlist (
  id bigint generated always as identity primary key,
  email text not null unique check (char_length(email) between 3 and 254),
  sender text check (char_length(sender) = 64),
  created_at timestamptz not null default now()
);

create table public.site_ideas (
  id bigint generated always as identity primary key,
  body text check (char_length(body) between 1 and 500),
  chips text[] not null default '{}' check (cardinality(chips) <= 12),
  email text check (char_length(email) between 3 and 254),
  sender text check (char_length(sender) = 64),
  created_at timestamptz not null default now(),
  check (body is not null or cardinality(chips) > 0)
);

-- The salt for sender hashes: random, made once here, readable only by the database owner.
create table public.site_secret (
  id boolean primary key default true check (id),
  salt bytea not null default extensions.gen_random_bytes(32)
);
insert into public.site_secret default values;

create index site_waitlist_sender_idx on public.site_waitlist (sender, created_at);
create index site_waitlist_created_idx on public.site_waitlist (created_at);
create index site_ideas_sender_idx on public.site_ideas (sender, created_at);
create index site_ideas_created_idx on public.site_ideas (created_at);

alter table public.site_waitlist enable row level security;
alter table public.site_ideas enable row level security;
alter table public.site_secret enable row level security;
revoke all on public.site_waitlist, public.site_ideas, public.site_secret from anon, authenticated;

-- Who is sending, as a salted hash of the caller's IP from the request headers. Null when there is no IP to read.
-- Only called from inside the two security-definer functions below, so it reads site_secret as the owner.
create function public.site_sender() returns text
language plpgsql stable set search_path = '' as $$
declare
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
  v_ip text;
begin
  if v_headers is null then return null; end if;
  v_ip := trim(coalesce(v_headers ->> 'cf-connecting-ip', v_headers ->> 'x-real-ip',
                        split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)));
  if v_ip = '' then return null; end if;
  return encode(extensions.hmac(convert_to(v_ip, 'UTF8'), (select salt from public.site_secret), 'sha256'), 'hex');
end $$;

-- A plain shape check; the real test is whether mail arrives at launch.
create function public.site_email_ok(p_email text) returns boolean
language sql immutable set search_path = '' as $$
  select p_email is not null
     and char_length(p_email) between 3 and 254
     and p_email ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+\.[^@[:space:][:cntrl:]]+$'
$$;

create function public.join_waitlist(p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_sender text := public.site_sender();
begin
  if not public.site_email_ok(v_email) then raise exception 'invalid_email'; end if;
  if v_sender is not null and (select count(*) from public.site_waitlist
      where sender = v_sender and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'rate_limited';
  end if;
  if (select count(*) from public.site_waitlist where created_at > now() - interval '1 hour') >= 2000 then
    raise exception 'rate_limited';
  end if;
  insert into public.site_waitlist (email, sender) values (v_email, v_sender) on conflict (email) do nothing;
  return 'ok';
end $$;

create function public.submit_idea(p_body text, p_chips text[], p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_body text := nullif(trim(coalesce(p_body, '')), '');
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_chips text[];
  v_sender text := public.site_sender();
begin
  select coalesce(array_agg(distinct c), '{}') into v_chips
    from (select trim(x) as c from unnest(coalesce(p_chips, '{}')) as x) t
    where c <> '';
  if v_body is not null and (char_length(v_body) > 500 or v_body ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]') then
    raise exception 'invalid_idea';
  end if;
  if cardinality(v_chips) > 12 or exists (select 1 from unnest(v_chips) c where char_length(c) > 40 or c ~ '[[:cntrl:]]') then
    raise exception 'invalid_idea';
  end if;
  if v_body is null and cardinality(v_chips) = 0 then raise exception 'empty_idea'; end if;
  if v_email is not null and not public.site_email_ok(v_email) then raise exception 'invalid_email'; end if;
  if v_sender is not null and (select count(*) from public.site_ideas
      where sender = v_sender and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'rate_limited';
  end if;
  if (select count(*) from public.site_ideas where created_at > now() - interval '1 hour') >= 2000 then
    raise exception 'rate_limited';
  end if;
  insert into public.site_ideas (body, chips, email, sender) values (v_body, v_chips, v_email, v_sender);
  return 'ok';
end $$;

revoke execute on function public.site_sender() from public, anon, authenticated;
revoke execute on function public.site_email_ok(text) from public, anon, authenticated;
revoke execute on function public.join_waitlist(text) from public;
revoke execute on function public.submit_idea(text, text[], text) from public;
grant execute on function public.join_waitlist(text) to anon, authenticated;
grant execute on function public.submit_idea(text, text[], text) to anon, authenticated;
