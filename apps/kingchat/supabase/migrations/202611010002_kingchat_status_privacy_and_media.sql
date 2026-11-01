-- Limit status visibility to the user's King Chat contacts.
drop policy if exists "active status visible" on public.kc_status_updates;
create policy "active status visible to contacts"
on public.kc_status_updates
for select
to authenticated
using (
  expires_at > now()
  and (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.kc_contacts c
      where c.owner_id = (select auth.uid())
        and c.contact_id = kc_status_updates.user_id
    )
    or exists (
      select 1 from public.kc_contacts c
      where c.owner_id = kc_status_updates.user_id
        and c.contact_id = (select auth.uid())
    )
  )
);

-- Store objects under <uploader-uid>/<conversation-id>/<filename>.
-- Only conversation members can upload or download the private media.
drop policy if exists "read own chat media" on storage.objects;
drop policy if exists "upload own chat media" on storage.objects;

create policy "read media for conversation members"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'chat-media'
  and public.kc_is_conversation_member((storage.foldername(name))[2]::uuid)
);

create policy "upload media to own conversation folder"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'chat-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.kc_is_conversation_member((storage.foldername(name))[2]::uuid)
);

create index if not exists kc_contacts_contact_owner_idx
on public.kc_contacts(contact_id, owner_id);
