-- Thinking levels now come from each model (off, on, minimal, low, medium, high, xhigh, max), not a fixed list of four.
alter table public.messages drop constraint if exists messages_reasoning_check;
alter table public.messages
  add constraint messages_reasoning_check check (reasoning in ('off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));

alter table public.profiles drop constraint if exists profiles_ai_reasoning_check;
alter table public.profiles
  add constraint profiles_ai_reasoning_check check (ai_reasoning in ('off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));
