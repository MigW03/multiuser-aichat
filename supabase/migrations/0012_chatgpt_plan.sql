-- "ChatGPT plan" provider: a user connects their own ChatGPT subscription instead of pasting an API key.
-- The sign-in tokens live in their own table, next to user_api_keys, with the same lockdown.

-- Tokens are encrypted by the app (AES-256-GCM) before they are inserted. RLS is on with no policies and the
-- client roles have no grants, so only the server (service role) can read or write this table.
create table public.user_chatgpt_auth (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  ciphertext text not null,           -- encrypted JSON: access token, refresh token
  expires_at timestamptz not null,    -- when the access token stops working
  hint text not null check (char_length(hint) <= 80),  -- masked account label shown in Settings, never a secret
  -- Refresh tokens rotate, so two servers refreshing at once would burn the login. One of them claims this
  -- lease first (a single UPDATE) and the others wait for its result.
  refreshing_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.user_chatgpt_auth enable row level security;
revoke all on public.user_chatgpt_auth from anon, authenticated;

-- The new provider id is allowed wherever a provider is stored.
alter table public.profiles drop constraint if exists profiles_ai_provider_check;
alter table public.profiles
  add constraint profiles_ai_provider_check check (ai_provider in ('openrouter', 'anthropic', 'openai', 'chatgpt'));

alter table public.messages drop constraint if exists messages_provider_check;
alter table public.messages
  add constraint messages_provider_check check (provider in ('openrouter', 'anthropic', 'openai', 'chatgpt'));

alter table public.user_favorite_models drop constraint if exists user_favorite_models_provider_check;
alter table public.user_favorite_models
  add constraint user_favorite_models_provider_check check (provider in ('openrouter', 'anthropic', 'openai', 'chatgpt'));
