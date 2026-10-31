-- King Chat: real phone-number contacts and safe direct-chat creation.
create table if not exists public.kc_contacts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(owner_id, contact_id),
  constraint kc_contacts_not_self check(owner_id <> contact_id)
);
alter table public.kc_contacts enable row level security;
drop policy if exists "membership add" on public.kc_conversation_members;
create policy "membership add" on public.kc_conversation_members
for insert to authenticated
with check (exists (select 1 from public.kc_conversations c where c.id = conversation_id and c.created_by = auth.uid()));
drop policy if exists "profile read authenticated" on public.kc_profiles;
create policy "profile self or shared chat" on public.kc_profiles
for select to authenticated
using (id = auth.uid() or exists (
  select 1 from public.kc_conversation_members mine
  join public.kc_conversation_members theirs on theirs.conversation_id = mine.conversation_id
  where mine.user_id = auth.uid() and theirs.user_id = kc_profiles.id
));
create policy "contacts read own" on public.kc_contacts for select to authenticated using (owner_id = auth.uid());
create policy "contacts add own" on public.kc_contacts for insert to authenticated with check (owner_id = auth.uid());
create policy "contacts remove own" on public.kc_contacts for delete to authenticated using (owner_id = auth.uid());

create or replace function public.kc_add_contact_and_start_chat(p_phone text)
returns table(conversation_id uuid, contact_id uuid, display_name text)
language plpgsql security definer set search_path = public as $$
declare v_contact uuid; v_name text; v_conversation uuid; v_phone text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  v_phone := regexp_replace(trim(p_phone), '[^0-9+]', '', 'g');
  if length(v_phone) < 8 or length(v_phone) > 16 then raise exception 'Enter a valid international phone number'; end if;
  select p.id, p.display_name into v_contact, v_name from public.kc_profiles p where p.phone = v_phone and p.id <> auth.uid() limit 1;
  if v_contact is null then raise exception 'No King Chat account found for this phone number'; end if;
  insert into public.kc_contacts(owner_id, contact_id) values(auth.uid(), v_contact) on conflict do nothing;
  select c.id into v_conversation from public.kc_conversations c
  join public.kc_conversation_members a on a.conversation_id = c.id and a.user_id = auth.uid()
  join public.kc_conversation_members b on b.conversation_id = c.id and b.user_id = v_contact
  where c.kind = 'direct' and (select count(*) from public.kc_conversation_members m where m.conversation_id = c.id) = 2 limit 1;
  if v_conversation is null then
    insert into public.kc_conversations(kind, created_by) values('direct', auth.uid()) returning id into v_conversation;
    insert into public.kc_conversation_members(conversation_id, user_id, role)
    values (v_conversation, auth.uid(), 'member'), (v_conversation, v_contact, 'member');
  end if;
  return query select v_conversation, v_contact, coalesce(v_name, 'King Chat user');
end; $$;
revoke all on function public.kc_add_contact_and_start_chat(text) from public;
grant execute on function public.kc_add_contact_and_start_chat(text) to authenticated;

create or replace function public.kc_sync_auth_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.kc_profiles(id, phone, display_name)
  values (new.id, new.phone, coalesce(nullif(new.raw_user_meta_data->>'display_name',''), 'New member'))
  on conflict (id) do update set phone = excluded.phone;
  return new;
end; $$;
drop trigger if exists kc_auth_profile_sync on auth.users;
create trigger kc_auth_profile_sync after insert or update of phone on auth.users
for each row execute function public.kc_sync_auth_profile();
