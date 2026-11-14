-- Guftin: create direct conversations only after the user actually messages or calls.
-- Adding a username/phone contact records a contact, not an empty inbox conversation.

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

  -- Deliberately return NULL for conversation_id. The app creates a direct
  -- conversation through kc_start_direct_conversation only on first send/call.
  return query
  select null::uuid, v_contact, coalesce(v_name, 'Guftin member'), v_username, v_avatar;
end;
$function$;

revoke all on function public.kc_add_contact_by_username(text) from public, anon;
grant execute on function public.kc_add_contact_by_username(text) to authenticated;


create or replace function public.kc_start_direct_conversation(p_contact_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_conversation uuid;
  v_low text;
  v_high text;
begin
  if v_uid is null then
    raise exception 'Sign in required';
  end if;

  if p_contact_id is null or p_contact_id = v_uid then
    raise exception 'Choose another registered Guftin member';
  end if;

  if not exists (
    select 1 from public.kc_profiles p where p.id = p_contact_id
  ) then
    raise exception 'This Guftin account is not available';
  end if;

  if not exists (
    select 1 from public.kc_contacts c
    where c.owner_id = v_uid and c.contact_id = p_contact_id
  ) then
    raise exception 'Add this member as a contact before starting a conversation';
  end if;

  v_low := least(v_uid::text, p_contact_id::text);
  v_high := greatest(v_uid::text, p_contact_id::text);
  perform pg_advisory_xact_lock(hashtextextended(v_low || ':' || v_high, 0));

  select c.id
    into v_conversation
  from public.kc_conversations c
  join public.kc_conversation_members mine
    on mine.conversation_id = c.id and mine.user_id = v_uid
  join public.kc_conversation_members peer
    on peer.conversation_id = c.id and peer.user_id = p_contact_id
  where c.kind = 'direct'
    and not exists (
      select 1
      from public.kc_conversation_members extra
      where extra.conversation_id = c.id
        and extra.user_id not in (v_uid, p_contact_id)
    )
  order by c.created_at
  limit 1;

  if v_conversation is null then
    insert into public.kc_conversations(kind, created_by)
    values ('direct', v_uid)
    returning id into v_conversation;

    insert into public.kc_conversation_members(conversation_id, user_id, role)
    values
      (v_conversation, v_uid, 'member'),
      (v_conversation, p_contact_id, 'member');
  else
    update public.kc_conversation_members
      set hidden_at = null
    where conversation_id = v_conversation
      and user_id = v_uid;
  end if;

  return v_conversation;
end;
$function$;

revoke all on function public.kc_start_direct_conversation(uuid) from public, anon;
grant execute on function public.kc_start_direct_conversation(uuid) to authenticated;


-- Keep the legacy phone-number contact API consistent: add a contact only.
-- Its public wrapper keeps the same return shape for older clients.
create or replace function private.kc_add_contact_and_start_chat(p_phone text)
returns table(conversation_id uuid, contact_id uuid, display_name text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_contact uuid;
  v_name text;
  v_phone text;
begin
  if v_uid is null then
    raise exception 'Sign in required';
  end if;

  v_phone := regexp_replace(trim(coalesce(p_phone, '')), '[^0-9+]', '', 'g');
  if length(v_phone) < 8 or length(v_phone) > 16 then
    raise exception 'Enter a valid international phone number';
  end if;

  select p.id, p.display_name
    into v_contact, v_name
  from public.kc_profiles p
  where p.phone = v_phone
    and p.id <> v_uid
  limit 1;

  if v_contact is null then
    raise exception 'No registered Guftin account found for this phone number';
  end if;

  insert into public.kc_contacts(owner_id, contact_id)
  values (v_uid, v_contact)
  on conflict do nothing;

  return query
  select null::uuid, v_contact, coalesce(v_name, 'Guftin member');
end;
$function$;


-- The Official account created two direct chats before this change by adding
-- registered contacts. Remove only these empty placeholders; keep all users,
-- contact rows, channel followers, messages, and genuine conversations intact.
delete from public.kc_conversations c
using auth.users owner_user
where c.created_by = owner_user.id
  and lower(owner_user.email) = 'guftinofficle@gmail.com'
  and c.kind = 'direct'
  and not exists (
    select 1 from public.kc_messages m
    where m.conversation_id = c.id
  )
  and not exists (
    select 1 from public.kc_call_logs l
    where l.conversation_id = c.id
  );
