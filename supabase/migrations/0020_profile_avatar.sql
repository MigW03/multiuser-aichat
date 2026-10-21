-- Profile photo from Google. Only the link is stored (the image stays on Google's servers), and only a link that looks like
-- one of Google's own profile pictures. Clients cannot write the column: it is filled from the sign-in data below.
create function public.is_google_avatar_url(u text) returns boolean
language sql immutable set search_path = '' as $$
  select u is not null
     and char_length(u) <= 500
     and u ~ '^https://lh3\.googleusercontent\.com/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$'
     and u not like '%default-user%'
$$;

alter table public.profiles add column avatar_url text;
alter table public.profiles add constraint avatar_url_google check (avatar_url is null or public.is_google_avatar_url(avatar_url));
-- profiles has no client update grant except the listed columns (0010), so avatar_url is server-side only.

-- Keep the photo equal to what Google last sent. Google signs in again on every log in, which updates identity_data.
create function public.sync_google_avatar() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v text := coalesce(new.identity_data ->> 'avatar_url', new.identity_data ->> 'picture');
begin
  if new.provider = 'google' then
    update public.profiles set avatar_url = case when public.is_google_avatar_url(v) then v else null end where id = new.user_id;
  end if;
  return new;
end;
$$;
revoke execute on function public.sync_google_avatar() from public, anon, authenticated;
create trigger on_auth_identity_google_avatar
  after insert or update of identity_data on auth.identities
  for each row execute function public.sync_google_avatar();

-- People who already signed in with Google.
update public.profiles p set avatar_url = i.v
  from (select user_id, coalesce(identity_data ->> 'avatar_url', identity_data ->> 'picture') as v
          from auth.identities where provider = 'google') i
 where i.user_id = p.id and public.is_google_avatar_url(i.v);

-- The join page's "Already in" list carries each person's photo too (same return type, so the grants stay).
create or replace function public.app_preview_invite(p_token text)
returns table (status text, scope text, name text, inviter_name text, role text, email text, members jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.invites;
  v_scope text;
  v_name text;
  v_members jsonb;
  v_taken int;
begin
  select * into v_inv from public.invites where token = p_token;
  if not found then
    return query select 'invalid'::text, null::text, null::text, null::text, null::text, null::text, '[]'::jsonb;
    return;
  end if;
  if v_inv.project_id is not null then
    v_scope := 'project';
    select p.name into v_name from public.projects p where p.id = v_inv.project_id;
    select coalesce(jsonb_agg(jsonb_build_object('name', pr.display_name, 'role', pm.role, 'avatar', pr.avatar_url) order by pm.joined_at), '[]'::jsonb)
      into v_members
      from public.project_members pm join public.profiles pr on pr.id = pm.user_id where pm.project_id = v_inv.project_id;
    select count(*) into v_taken from public.project_members where project_id = v_inv.project_id;
  else
    v_scope := 'chat';
    select c.title into v_name from public.chats c where c.id = v_inv.chat_id;
    select coalesce(jsonb_agg(jsonb_build_object('name', pr.display_name, 'role', 'member', 'avatar', pr.avatar_url) order by cm.joined_at), '[]'::jsonb)
      into v_members
      from public.chat_members cm join public.profiles pr on pr.id = cm.user_id where cm.chat_id = v_inv.chat_id;
    select count(*) into v_taken from public.chat_members where chat_id = v_inv.chat_id;
  end if;
  return query
    select case
             when v_inv.accepted_at is not null then 'used'
             when v_inv.revoked_at is not null or v_inv.expires_at <= now() then 'expired'
             when v_taken >= public.max_project_people() then 'full'
             else 'valid'
           end,
           v_scope, v_name, (select pr.display_name from public.profiles pr where pr.id = v_inv.invited_by),
           v_inv.role, v_inv.email, v_members;
end;
$$;
