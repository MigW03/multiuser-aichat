-- Smart model selection: each person decides, per project, whether "Auto" may pick the model that answers them,
-- and keeps their own set of OpenRouter models for it. Only the chat server reads or writes either (service role).

-- The switch lives on the person's own membership row, so it is theirs alone and goes when they leave the project.
-- Members can already read project_members; the server is the only writer (writes are revoked for client roles).
alter table public.project_members add column smart_selection boolean not null default false;

-- The person's Smart set: OpenRouter model ids. RLS is on with no policies and no client grants, like user_api_keys.
create table public.user_smart_set (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  models text[] not null default '{}' check (cardinality(models) <= 12),
  updated_at timestamptz not null default now()
);
alter table public.user_smart_set enable row level security;
revoke all on public.user_smart_set from anon, authenticated;
