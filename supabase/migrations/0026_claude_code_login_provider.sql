-- "Claude Code login": an AI provider that runs on the asker's own computer, with the `claude` program they signed in to
-- themselves (desktop app only). It stores no credential anywhere: there is no table for it. Only the provider id is new, so
-- it is allowed wherever a provider is stored (a person's last pick, a message's provider, favourite models).

alter table public.profiles drop constraint if exists profiles_ai_provider_check;
alter table public.profiles
  add constraint profiles_ai_provider_check check (ai_provider in ('openrouter', 'anthropic', 'openai', 'chatgpt', 'claudecode'));

alter table public.messages drop constraint if exists messages_provider_check;
alter table public.messages
  add constraint messages_provider_check check (provider in ('openrouter', 'anthropic', 'openai', 'chatgpt', 'claudecode'));

alter table public.user_favorite_models drop constraint if exists user_favorite_models_provider_check;
alter table public.user_favorite_models
  add constraint user_favorite_models_provider_check check (provider in ('openrouter', 'anthropic', 'openai', 'chatgpt', 'claudecode'));
