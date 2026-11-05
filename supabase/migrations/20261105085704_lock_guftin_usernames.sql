create or replace function public.kc_prevent_username_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.username is not null and new.username is distinct from old.username then
    raise exception 'Your Guftin username is permanent and cannot be changed.';
  end if;
  return new;
end;
$$;

drop trigger if exists kc_profiles_username_immutable on public.kc_profiles;
create trigger kc_profiles_username_immutable
before update of username on public.kc_profiles
for each row execute function public.kc_prevent_username_change();

create or replace function public.kc_finish_profile(p_username text, p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_username text := lower(trim(p_username));
  v_existing_username text;
begin
  if v_user_id is null then
    raise exception 'Sign in required';
  end if;
  if v_username !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'Username must be 3-24 characters: letters, numbers, underscore';
  end if;
  if length(trim(p_display_name)) < 2 or length(trim(p_display_name)) > 40 then
    raise exception 'Display name must be 2-40 characters';
  end if;

  select username into v_existing_username
  from public.kc_profiles
  where id = v_user_id
  for update;

  if v_existing_username is not null and v_existing_username <> v_username then
    raise exception 'Your Guftin username is permanent and cannot be changed.';
  end if;

  insert into public.kc_profiles(id, phone, username, display_name)
  values(v_user_id, auth.jwt()->>'phone', v_username, trim(p_display_name))
  on conflict(id) do update
    set username = coalesce(public.kc_profiles.username, excluded.username),
        display_name = excluded.display_name,
        phone = excluded.phone;
end;
$$;
