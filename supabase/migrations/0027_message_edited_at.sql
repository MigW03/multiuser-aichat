-- Edit your own message. Only the time of the last edit is kept (no history).
--
--   * Clients still cannot write to messages (0010 revoked insert/update/delete). The server changes a message's words through
--     PATCH /api/messages/:id, which checks that the caller wrote the message, and sets edited_at with the service role.
--   * edited_at is read through the existing messages RLS and reaches members live through the existing realtime publication.

alter table public.messages add column edited_at timestamptz;
