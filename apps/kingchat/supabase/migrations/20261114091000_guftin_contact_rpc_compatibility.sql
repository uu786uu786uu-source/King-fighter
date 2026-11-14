-- New clients save contacts without creating empty chats. Keep the original
-- RPC behavior as a compatibility layer for older installed app versions.

create or replace function public.kc_save_contact_by_username(p_username text)
returns table(
  contact_id uuid,
  display_name text,
  username text,
  avatar_url text
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_contact uuid;
  v_name text;
  v_username text;
  v_avatar text;
begin
  if v_uid is null then
    raise exception 'Sign in required';
  end if;
  if lower(trim(coalesce(p_username, ''))) !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'Enter a valid Guftin username';
  end if;

  select p.id, p.display_name, p.username, p.avatar_url
    into v_contact, v_name, v_username, v_avatar
  from public.kc_profiles p
  where lower(p.username) = lower(trim(p_username))
    and p.id <> v_uid
  limit 1;

  if v_contact is null then
    raise exception 'No registered Guftin account found with this username';
  end if;

  insert into public.kc_contacts(owner_id, contact_id)
  values (v_uid, v_contact)
  on conflict do nothing;

  return query
  select v_contact, coalesce(v_name, 'Guftin member'), v_username, v_avatar;
end;
$function$;

revoke all on function public.kc_save_contact_by_username(text) from public, anon;
grant execute on function public.kc_save_contact_by_username(text) to authenticated;


-- Restore the original conversation-returning RPC for older APKs. New APKs
-- call kc_save_contact_by_username and kc_start_direct_conversation instead.
create or replace function public.kc_add_contact_by_username(p_username text)
returns table(
  conversation_id uuid,
  contact_id uuid,
  display_name text,
  username text,
  avatar_url text
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_contact uuid;
  v_name text;
  v_username text;
  v_avatar text;
  v_conversation uuid;
begin
  if v_uid is null then
    raise exception 'Sign in required';
  end if;
  if lower(trim(coalesce(p_username, ''))) !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'Enter a valid Guftin username';
  end if;

  select p.id, p.display_name, p.username, p.avatar_url
    into v_contact, v_name, v_username, v_avatar
  from public.kc_profiles p
  where lower(p.username) = lower(trim(p_username))
    and p.id <> v_uid
  limit 1;

  if v_contact is null then
    raise exception 'No King Chat account found with this username';
  end if;

  insert into public.kc_contacts(owner_id, contact_id)
  values (v_uid, v_contact)
  on conflict do nothing;

  select c.id
    into v_conversation
  from public.kc_conversations c
  join public.kc_conversation_members a
    on a.conversation_id = c.id and a.user_id = v_uid
  join public.kc_conversation_members b
    on b.conversation_id = c.id and b.user_id = v_contact
  where c.kind = 'direct'
    and (select count(*) from public.kc_conversation_members m where m.conversation_id = c.id) = 2
  limit 1;

  if v_conversation is null then
    insert into public.kc_conversations(kind, created_by)
    values ('direct', v_uid)
    returning id into v_conversation;
    insert into public.kc_conversation_members(conversation_id, user_id, role)
    values (v_conversation, v_uid, 'member'), (v_conversation, v_contact, 'member');
  else
    update public.kc_conversation_members
      set hidden_at = null
    where conversation_id = v_conversation
      and user_id = v_uid;
  end if;

  return query
  select v_conversation, v_contact, coalesce(v_name, 'King Chat user'), v_username, v_avatar;
end;
$function$;

revoke all on function public.kc_add_contact_by_username(text) from public, anon;
grant execute on function public.kc_add_contact_by_username(text) to authenticated;


-- Preserve the original phone-contact RPC for clients which still use it.
create or replace function private.kc_add_contact_and_start_chat(p_phone text)
returns table(conversation_id uuid, contact_id uuid, display_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_contact uuid;
  v_name text;
  v_conversation uuid;
  v_phone text;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;

  v_phone := regexp_replace(trim(p_phone), '[^0-9+]', '', 'g');
  if length(v_phone) < 8 or length(v_phone) > 16 then
    raise exception 'Enter a valid international phone number';
  end if;

  select p.id, p.display_name into v_contact, v_name
  from public.kc_profiles p
  where p.phone = v_phone and p.id <> auth.uid()
  limit 1;

  if v_contact is null then
    raise exception 'No King Chat account found for this phone number';
  end if;

  insert into public.kc_contacts(owner_id, contact_id)
  values(auth.uid(), v_contact) on conflict do nothing;

  select c.id into v_conversation
  from public.kc_conversations c
  join public.kc_conversation_members a
    on a.conversation_id = c.id and a.user_id = auth.uid()
  join public.kc_conversation_members b
    on b.conversation_id = c.id and b.user_id = v_contact
  where c.kind = 'direct'
    and (select count(*) from public.kc_conversation_members m where m.conversation_id = c.id) = 2
  limit 1;

  if v_conversation is null then
    insert into public.kc_conversations(kind, created_by)
    values('direct', auth.uid()) returning id into v_conversation;
    insert into public.kc_conversation_members(conversation_id, user_id, role)
    values (v_conversation, auth.uid(), 'member'), (v_conversation, v_contact, 'member');
  end if;

  return query
  select v_conversation, v_contact, coalesce(v_name, 'King Chat user');
end;
$function$;
