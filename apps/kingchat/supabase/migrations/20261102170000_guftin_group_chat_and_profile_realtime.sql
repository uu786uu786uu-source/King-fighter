-- Atomic group creation with a creator-only read path for the short pre-membership window.
-- All member additions must refer to contacts already owned by the caller.
do $$
declare table_name text;
begin
  foreach table_name in array array['kc_profiles','kc_conversations'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I',table_name);
    end if;
  end loop;
end $$;

drop policy if exists "conversation members read" on public.kc_conversations;
create policy "conversation members read" on public.kc_conversations
for select to authenticated
using (public.kc_is_conversation_member(id) or created_by=(select auth.uid()));

create or replace function public.kc_create_group(p_title text, p_member_ids uuid[])
returns uuid
language plpgsql
security invoker
set search_path=public
as $$
declare
  v_id uuid;
  v_title text := left(trim(coalesce(p_title,'')),60);
  v_members uuid[];
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in is required to create a group.';
  end if;
  if length(v_title)<2 then
    raise exception 'Group name must contain at least 2 characters.';
  end if;

  select coalesce(array_agg(distinct member_id), '{}'::uuid[])
    into v_members
  from unnest(coalesce(p_member_ids, '{}'::uuid[])) as member_id
  where member_id is not null and member_id <> auth.uid();

  v_count := coalesce(array_length(v_members,1),0);
  if v_count < 1 then
    raise exception 'Select at least one contact to create a group.';
  end if;
  if v_count > 49 then
    raise exception 'A group can contain up to 50 members including you.';
  end if;
  if exists (
    select 1
    from unnest(v_members) as selected_id
    where not exists (
      select 1 from public.kc_contacts c
      where c.owner_id=auth.uid() and c.contact_id=selected_id
    )
  ) then
    raise exception 'Groups can only include contacts you have added.';
  end if;

  insert into public.kc_conversations(kind,title,created_by)
  values ('group',v_title,auth.uid())
  returning id into v_id;

  insert into public.kc_conversation_members(conversation_id,user_id,role)
  values (v_id,auth.uid(),'admin');

  insert into public.kc_conversation_members(conversation_id,user_id,role)
  select v_id, member_id, 'member' from unnest(v_members) as member_id;

  return v_id;
end;
$$;

grant execute on function public.kc_create_group(text,uuid[]) to authenticated;
