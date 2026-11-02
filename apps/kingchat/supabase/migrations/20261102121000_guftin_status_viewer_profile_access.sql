drop policy if exists "profile self or shared chat" on public.kc_profiles;
create policy "profile self shared chat or contact"
on public.kc_profiles
for select
to authenticated
using (
  id = (select auth.uid())
  or exists (
    select 1 from public.kc_conversation_members mine
    join public.kc_conversation_members theirs
      on theirs.conversation_id = mine.conversation_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = kc_profiles.id
  )
  or exists (
    select 1 from public.kc_contacts c
    where c.owner_id = (select auth.uid())
      and c.contact_id = kc_profiles.id
  )
  or exists (
    select 1 from public.kc_contacts c
    where c.owner_id = kc_profiles.id
      and c.contact_id = (select auth.uid())
  )
);