-- Pictures in messages. A message carries up to 4 pictures (messages.images, the ids), and the files live in a private
-- Storage bucket, one folder per chat.
--
--   * Clients never touch the bucket or chat_images. The server checks the person is in the chat, looks at the bytes
--     (type, size), stores the file with the service role, and hands out short-lived signed addresses to chat members.
--   * messages.images is read through the existing messages RLS like any other column, so members get it live.
--   * A picture is uploaded first (message_id null) and claimed by the message that sends it. Pictures that were never
--     sent are removed by the server after an hour.
--   * message_id has no foreign key on purpose: the server claims the picture with the id the client picked for the
--     message before the message row exists. Rows go away with their chat (the server removes the files first).

alter table public.messages
  add column images uuid[] not null default '{}'::uuid[] check (cardinality(images) <= 4);

create table public.chat_images (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats (id) on delete cascade,
  uploader_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid,
  path text not null unique check (char_length(path) <= 100),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  bytes integer not null check (bytes between 1 and 5242880),
  created_at timestamptz not null default now()
);

create index chat_images_chat_idx on public.chat_images (chat_id);
create index chat_images_message_idx on public.chat_images (message_id) where message_id is not null;
create index chat_images_waiting_idx on public.chat_images (uploader_id, created_at) where message_id is null;

-- Server only: RLS on and no policy, and no grant for the browser roles.
alter table public.chat_images enable row level security;
revoke all on public.chat_images from anon, authenticated;

-- The bucket is private and has no storage policies, so only the service role can read or write it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-images', 'chat-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;
