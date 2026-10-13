-- Models a user has starred in the model picker. Own rows only.
create table public.user_favorite_models (
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('openrouter', 'anthropic', 'openai')),
  model text not null check (char_length(model) between 1 and 200),
  created_at timestamptz not null default now(),
  primary key (user_id, provider, model)
);
alter table public.user_favorite_models enable row level security;

create policy favorites_select on public.user_favorite_models for select to authenticated
  using (user_id = (select auth.uid()));
create policy favorites_insert on public.user_favorite_models for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy favorites_delete on public.user_favorite_models for delete to authenticated
  using (user_id = (select auth.uid()));
