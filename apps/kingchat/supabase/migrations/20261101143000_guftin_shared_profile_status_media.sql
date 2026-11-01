-- Allow authenticated users to read media intentionally shared through visible profiles and active statuses.
drop policy if exists "read shared profile and active status media" on storage.objects;
create policy "read shared profile and active status media"
on storage.objects for select to authenticated
using (
  bucket_id = 'chat-media'
  and (
    exists (
      select 1 from public.kc_profiles p
      where p.avatar_url = name
    )
    or exists (
      select 1 from public.kc_status_updates s
      where s.media_url = name and s.expires_at > now()
    )
  )
);
