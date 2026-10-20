-- Project notes: short shared notes that everyone in a project can read and edit. The AI can add one on request
-- ("take a note", or Save as note under an answer, which is a person's own note).
--
--   * Members READ through RLS (and get live changes through realtime).
--   * Only the server writes, through the app_note_* functions below (service role only), which check the acting
--     user's role. Any member can add and edit; only the note's author, the host and admins can delete.
--   * created_by is the person who wrote the note, or who asked the AI to (by_ai = true). It is null once that
--     person's account is gone.

create table public.project_notes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  body text not null default '' check (char_length(body) <= 8000),
  created_by uuid references public.profiles (id) on delete set null,
  by_ai boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);

create index project_notes_project_idx on public.project_notes (project_id, updated_at desc);

alter table public.project_notes enable row level security;
create policy project_notes_select on public.project_notes for select to authenticated using (public.is_project_member(project_id));
revoke all on public.project_notes from anon, authenticated;
grant select on public.project_notes to authenticated;

alter publication supabase_realtime add table public.project_notes;

-- ================================================================== server-only functions (service role)

-- Titles and text are plain text typed by people or written by the AI: no control characters in a title.
create function public.app_note_create(p_user uuid, p_project uuid, p_title text, p_body text, p_ai boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_title text := trim(coalesce(p_title, ''));
  v_body text := coalesce(p_body, '');
  v_id uuid;
begin
  if public.project_role_of(p_user, p_project) is null then raise exception 'not_found'; end if;
  if char_length(v_title) not between 1 and 120 or v_title ~ '[[:cntrl:]]' then raise exception 'invalid_name'; end if;
  if char_length(v_body) > 8000 then raise exception 'invalid_scope'; end if;
  if (select count(*) from public.project_notes where project_id = p_project) >= 200 then raise exception 'notes_full'; end if;
  insert into public.project_notes (project_id, title, body, created_by, by_ai, updated_by)
  values (p_project, v_title, v_body, p_user, coalesce(p_ai, false), p_user)
  returning id into v_id;
  return v_id;
end;
$$;

-- Any member can edit any note in their project.
create function public.app_note_update(p_user uuid, p_note uuid, p_title text, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_project uuid;
  v_title text := trim(coalesce(p_title, ''));
  v_body text := coalesce(p_body, '');
begin
  select project_id into v_project from public.project_notes where id = p_note;
  if v_project is null or public.project_role_of(p_user, v_project) is null then raise exception 'not_found'; end if;
  if char_length(v_title) not between 1 and 120 or v_title ~ '[[:cntrl:]]' then raise exception 'invalid_name'; end if;
  if char_length(v_body) > 8000 then raise exception 'invalid_scope'; end if;
  update public.project_notes set title = v_title, body = v_body, updated_at = now(), updated_by = p_user where id = p_note;
end;
$$;

-- The note's author, the host and admins. (An AI note belongs to whoever asked for it.)
create function public.app_note_delete(p_user uuid, p_note uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_project uuid;
  v_author uuid;
  v_role text;
begin
  select project_id, created_by into v_project, v_author from public.project_notes where id = p_note;
  if v_project is null then raise exception 'not_found'; end if;
  v_role := public.project_role_of(p_user, v_project);
  if v_role is null then raise exception 'not_found'; end if;
  if v_author is distinct from p_user and v_role not in ('host', 'admin') then raise exception 'forbidden'; end if;
  delete from public.project_notes where id = p_note;
end;
$$;

revoke execute on function public.app_note_create(uuid, uuid, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.app_note_update(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.app_note_delete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.app_note_create(uuid, uuid, text, text, boolean) to service_role;
grant execute on function public.app_note_update(uuid, uuid, text, text) to service_role;
grant execute on function public.app_note_delete(uuid, uuid) to service_role;
