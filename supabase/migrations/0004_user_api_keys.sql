-- Per-user AI provider keys + model choice.

-- Keys are encrypted by the app (AES-256-GCM) before they are inserted. RLS is on with no policies and the
-- client roles have no grants, so only the server (service role) can read or write this table.
create table public.user_api_keys (
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('openrouter', 'anthropic', 'openai')),
  ciphertext text not null,
  key_hint text not null, -- last 4 characters, so the UI can show which key is saved
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
alter table public.user_api_keys enable row level security;
revoke all on public.user_api_keys from anon, authenticated;

-- The user's last-picked model. Users can already update their own profile row (profiles_update_self).
alter table public.profiles
  add column ai_provider text check (ai_provider in ('openrouter', 'anthropic', 'openai')),
  add column ai_model text check (char_length(ai_model) <= 200);

-- Which provider/model a message was sent with (user messages) or answered by (assistant messages).
alter table public.messages
  add column provider text check (provider in ('openrouter', 'anthropic', 'openai')),
  add column model text check (char_length(model) <= 200);
