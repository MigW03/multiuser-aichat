-- Google sign-in: a new person's name comes from their Google profile (full_name or name) when the sign-up form did not
-- give one. Cut to 60 characters, the limit on profiles.display_name, so a long Google name cannot make sign-up fail.
-- Email sign-up still sends display_name and works as before; with nothing at all the email's first part is used.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(new.email),
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
        split_part(new.email, '@', 1)
      ),
      60
    )
  );
  return new;
end;
$$;
