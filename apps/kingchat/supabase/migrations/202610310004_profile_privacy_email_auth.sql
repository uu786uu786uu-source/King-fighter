-- Keep private email addresses out of the public profile API.
alter table public.kc_profiles drop column if exists email;
revoke all on table public.kc_profiles from public, anon, authenticated;
grant select (id, username, display_name, avatar_url, about, is_online, last_seen_at, created_at)
  on table public.kc_profiles to authenticated;
grant update (about, is_online, last_seen_at)
  on table public.kc_profiles to authenticated;

create or replace function public.kc_sync_auth_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.kc_profiles(id, phone, display_name, username)
  values (
    new.id,
    new.phone,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name',''),
      nullif(new.raw_user_meta_data->>'full_name',''),
      nullif(new.raw_user_meta_data->>'name',''),
      nullif(split_part(coalesce(new.email,''),'@',1),''),
      'New member'
    ),
    nullif(lower(new.raw_user_meta_data->>'username'),'')
  )
  on conflict (id) do update set
    phone = excluded.phone,
    display_name = case when public.kc_profiles.display_name = 'New member' then excluded.display_name else public.kc_profiles.display_name end,
    username = coalesce(public.kc_profiles.username, excluded.username);
  return new;
end; $$;
drop trigger if exists kc_auth_profile_sync on auth.users;
create trigger kc_auth_profile_sync after insert or update of phone, email on auth.users
for each row execute function public.kc_sync_auth_profile();

create or replace function public.kc_finish_profile(p_username text, p_display_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_username text := lower(trim(p_username));
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if v_username !~ '^[a-z0-9_]{3,24}$' then raise exception 'Username must be 3-24 characters: letters, numbers, underscore'; end if;
  if length(trim(p_display_name)) < 2 or length(trim(p_display_name)) > 40 then raise exception 'Display name must be 2-40 characters'; end if;
  insert into public.kc_profiles(id,phone,username,display_name)
  values(auth.uid(), auth.jwt()->>'phone', v_username, trim(p_display_name))
  on conflict(id) do update set username=excluded.username, display_name=excluded.display_name, phone=excluded.phone;
end; $$;
revoke all on function public.kc_finish_profile(text,text) from public;
grant execute on function public.kc_finish_profile(text,text) to authenticated;
