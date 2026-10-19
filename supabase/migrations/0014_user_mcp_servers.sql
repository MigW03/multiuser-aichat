-- Remote MCP servers (connected tools), one row per server a person added. The chat server connects to them for the
-- person, so they work in the web and desktop apps alike.
--
-- Like user_api_keys: secrets (a header value, OAuth client and tokens) are encrypted by the server (AES-256-GCM) before
-- they are inserted. RLS is on with no policies and the client roles have no grants, so only the server (service role)
-- can read or write this table. The page only ever gets the safe view the server builds: name, address, status, the
-- last 4 characters of a header value, never a secret.

create table public.user_mcp_servers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9_-]{1,32}$'),
  url text not null check (char_length(url) between 9 and 2000 and url ~ '^https://'),
  auth_kind text not null check (auth_kind in ('none', 'header', 'oauth')),
  -- auth_kind = 'header': the header's name, the encrypted value and its last 4 characters
  header_name text check (header_name is null or header_name ~ '^[A-Za-z0-9-]{1,64}$'),
  secret_enc text check (secret_enc is null or char_length(secret_enc) <= 8000),
  secret_hint text check (secret_hint is null or char_length(secret_hint) <= 4),
  -- auth_kind = 'oauth': one encrypted JSON blob (client registration, tokens, PKCE verifier)
  oauth_enc text check (oauth_enc is null or char_length(oauth_enc) <= 20000),
  -- a sign-in that is waiting for the provider's redirect: random, single use, short lived
  oauth_state text check (oauth_state is null or char_length(oauth_state) between 20 and 200),
  oauth_state_expires timestamptz,
  enabled boolean not null default true,
  disabled_tools text[] not null default '{}' check (cardinality(disabled_tools) <= 500),
  created_at timestamptz not null default now(),
  unique (user_id, name),
  check (auth_kind <> 'header' or (header_name is not null and secret_enc is not null and secret_hint is not null)),
  check (auth_kind = 'header' or (header_name is null and secret_enc is null and secret_hint is null)),
  check (auth_kind = 'oauth' or (oauth_enc is null and oauth_state is null and oauth_state_expires is null))
);
create unique index user_mcp_servers_oauth_state on public.user_mcp_servers (oauth_state) where oauth_state is not null;

alter table public.user_mcp_servers enable row level security;
revoke all on public.user_mcp_servers from anon, authenticated;

-- At most 10 remote servers per person, even when two requests race.
create function public.user_mcp_servers_cap() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 14));
  if (select count(*) from public.user_mcp_servers where user_id = new.user_id) >= 10 then
    raise exception 'too_many_servers';
  end if;
  return new;
end;
$$;
revoke all on function public.user_mcp_servers_cap() from public, anon, authenticated;
create trigger user_mcp_servers_cap before insert on public.user_mcp_servers for each row execute function public.user_mcp_servers_cap();
