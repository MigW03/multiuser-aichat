-- Chat memory: model-neutral message parts, token usage, and rolling summary checkpoints.
-- See docs/coding-context-plan.md, phase 0.

-- The chat's agreed context window in tokens. Null means the app default (see src/lib/ai/context/tokens.ts)
-- until window proposals and approvals exist.
alter table public.chats add column context_window integer check (context_window > 0);

-- parts: [{type: 'text' | 'reasoning', text, producedBy?: {provider, model}}]; tool parts come later.
-- content stays as the plain-text rendering the UI shows.
-- usage: provider-reported tokens for an assistant reply, the anchor for size estimates.
alter table public.messages
  add column parts jsonb,
  add column usage jsonb;

-- Rolling summaries. The newest completed row is the chat's active checkpoint: messages with
-- seq <= covers_through_seq reach the model only through its summary.
create table public.chat_checkpoints (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  covers_through_seq bigint not null,
  summary text not null,
  status text not null check (status in ('completed', 'failed')),
  created_by uuid references public.profiles (id) on delete set null, -- whose run (and key) produced it
  provider text,
  model text,
  usage jsonb,
  created_at timestamptz not null default now()
);
create index on public.chat_checkpoints (chat_id, created_at desc);

alter table public.chat_checkpoints enable row level security;
create policy chat_checkpoints_select on public.chat_checkpoints for select to authenticated
  using (public.is_chat_member(chat_id));
-- No client writes: only the server, inside the chat's run lock, creates checkpoints.

alter publication supabase_realtime add table public.chat_checkpoints;

-- Only the server writes parts and usage. A client-written user message is plain content, so what the
-- model reads can't differ from what the other members see.
drop policy messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (
    public.is_chat_member(chat_id)
    and author_id = auth.uid()
    and role = 'user'
    and status = 'pending'
    and parts is null
    and usage is null
  );
