-- Username-based King Chat accounts, profile completion, and private username lookup.
alter table public.kc_profiles add column if not exists email text;
create unique index if not exists kc_profiles_username_lower_uq
  on public.kc_profiles (lower(username)) where username is not null;
alter table public.kc_profiles drop constraint if exists kc_profiles_username_format;
alter table public.kc_profiles add constraint kc_profiles_username_format
  check (username is null or username ~ '^[a-z0-9_]{3,24}$');

create or replace function public.kc_sync_auth_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.kc_profiles(id, phone, email, display_name, username)
  values (
    new.id,
    new.phone,
    new.email,
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
    email = excluded.email,
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
  insert into public.kc_profiles(id,email,phone,username,display_name)
  values(auth.uid(), auth.jwt()->>'email', auth.jwt()->>'phone', v_username, trim(p_display_name))
  on conflict(id) do update set username=excluded.username, display_name=excluded.display_name, email=excluded.email, phone=excluded.phone;
end; $$;
revoke all on function public.kc_finish_profile(text,text) from public;
grant execute on function public.kc_finish_profile(text,text) to authenticated;

create or replace function public.kc_add_contact_by_username(p_username text)
returns table(conversation_id uuid, contact_id uuid, display_name text, username text, avatar_url text)
language plpgsql security definer set search_path = public as $$
declare v_contact uuid; v_name text; v_username text; v_avatar text; v_conversation uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if length(trim(p_username)) < 3 or length(trim(p_username)) > 24 then raise exception 'Enter a valid username'; end if;
  select p.id,p.display_name,p.username,p.avatar_url into v_contact,v_name,v_username,v_avatar
  from public.kc_profiles p
  where lower(p.username)=lower(trim(p_username)) and p.id<>auth.uid()
  limit 1;
  if v_contact is null then raise exception 'No King Chat account found with this username'; end if;
  insert into public.kc_contacts(owner_id,contact_id) values(auth.uid(),v_contact) on conflict do nothing;
  select c.id into v_conversation from public.kc_conversations c
  join public.kc_conversation_members a on a.conversation_id=c.id and a.user_id=auth.uid()
  join public.kc_conversation_members b on b.conversation_id=c.id and b.user_id=v_contact
  where c.kind='direct' and (select count(*) from public.kc_conversation_members m where m.conversation_id=c.id)=2
  limit 1;
  if v_conversation is null then
    insert into public.kc_conversations(kind,created_by) values('direct',auth.uid()) returning id into v_conversation;
    insert into public.kc_conversation_members(conversation_id,user_id,role)
    values(v_conversation,auth.uid(),'member'),(v_conversation,v_contact,'member');
  end if;
  return query select v_conversation,v_contact,coalesce(v_name,'King Chat user'),v_username,v_avatar;
end; $$;
revoke all on function public.kc_add_contact_by_username(text) from public;
grant execute on function public.kc_add_contact_by_username(text) to authenticated;
