-- Keep SECURITY DEFINER routines outside the exposed public API schema.
-- Public RPC wrappers execute as invoker; private routines validate auth.uid().
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.kc_is_conversation_member(cid uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists(select 1 from public.kc_conversation_members
    where conversation_id = cid and user_id = auth.uid());
$$;
revoke all on function private.kc_is_conversation_member(uuid) from public, anon;
grant execute on function private.kc_is_conversation_member(uuid) to authenticated;

create or replace function public.kc_is_conversation_member(cid uuid)
returns boolean language sql stable security invoker
set search_path = public, private, pg_temp
as $$ select private.kc_is_conversation_member(cid); $$;
revoke all on function public.kc_is_conversation_member(uuid) from public, anon, authenticated;
grant execute on function public.kc_is_conversation_member(uuid) to authenticated;

drop function if exists public.kc_add_contact_and_start_chat(text);
create or replace function private.kc_add_contact_and_start_chat(p_phone text)
returns table(conversation_id uuid, contact_id uuid, display_name text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_contact uuid; v_name text; v_conversation uuid; v_phone text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  v_phone := regexp_replace(trim(p_phone), '[^0-9+]', '', 'g');
  if length(v_phone) < 8 or length(v_phone) > 16 then raise exception 'Enter a valid international phone number'; end if;
  select p.id, p.display_name into v_contact, v_name from public.kc_profiles p
    where p.phone = v_phone and p.id <> auth.uid() limit 1;
  if v_contact is null then raise exception 'No King Chat account found for this phone number'; end if;
  insert into public.kc_contacts(owner_id, contact_id) values(auth.uid(), v_contact) on conflict do nothing;
  select c.id into v_conversation from public.kc_conversations c
    join public.kc_conversation_members a on a.conversation_id=c.id and a.user_id=auth.uid()
    join public.kc_conversation_members b on b.conversation_id=c.id and b.user_id=v_contact
    where c.kind='direct' and (select count(*) from public.kc_conversation_members m where m.conversation_id=c.id)=2 limit 1;
  if v_conversation is null then
    insert into public.kc_conversations(kind,created_by) values('direct',auth.uid()) returning id into v_conversation;
    insert into public.kc_conversation_members(conversation_id,user_id,role)
      values(v_conversation,auth.uid(),'member'),(v_conversation,v_contact,'member');
  end if;
  return query select v_conversation,v_contact,coalesce(v_name,'King Chat user');
end;
$$;
revoke all on function private.kc_add_contact_and_start_chat(text) from public, anon;
grant execute on function private.kc_add_contact_and_start_chat(text) to authenticated;

create or replace function public.kc_add_contact_and_start_chat(p_phone text)
returns table(conversation_id uuid, contact_id uuid, display_name text)
language sql security invoker set search_path = public, private, pg_temp
as $$ select * from private.kc_add_contact_and_start_chat(p_phone); $$;
revoke all on function public.kc_add_contact_and_start_chat(text) from public, anon, authenticated;
grant execute on function public.kc_add_contact_and_start_chat(text) to authenticated;

drop trigger if exists kc_auth_profile_sync on auth.users;
drop function if exists public.kc_sync_auth_profile();
create or replace function private.kc_sync_auth_profile()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into public.kc_profiles(id,phone,display_name)
  values(new.id,new.phone,coalesce(nullif(new.raw_user_meta_data->>'display_name',''),'New member'))
  on conflict(id) do update set phone=excluded.phone;
  return new;
end;
$$;
revoke all on function private.kc_sync_auth_profile() from public, anon, authenticated;
create trigger kc_auth_profile_sync after insert or update of phone on auth.users
for each row execute function private.kc_sync_auth_profile();

drop trigger if exists kc_message_updates_conversation on public.kc_messages;
drop function if exists public.kc_touch_conversation_on_message();
create or replace function private.kc_touch_conversation_on_message()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.kc_conversations set updated_at=coalesce(new.created_at,now()) where id=new.conversation_id;
  return new;
end;
$$;
revoke all on function private.kc_touch_conversation_on_message() from public, anon, authenticated;
create trigger kc_message_updates_conversation after insert on public.kc_messages
for each row execute function private.kc_touch_conversation_on_message();
