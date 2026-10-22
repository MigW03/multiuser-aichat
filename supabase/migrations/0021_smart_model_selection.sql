-- Smart model selection: each person decides whether "Auto" may pick the model that answers them, and keeps their own
-- set of OpenRouter models for it. It is a personal setting (Settings > AI key), the same in every chat and project.
-- Only the chat server reads or writes this table (service role): RLS is on with no policies and no client grants,
-- like user_api_keys.
create table public.user_smart_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  enabled boolean not null default false,
  models text[] not null default '{}' check (cardinality(models) <= 12),
  updated_at timestamptz not null default now()
);
alter table public.user_smart_settings enable row level security;
revoke all on public.user_smart_settings from anon, authenticated;
