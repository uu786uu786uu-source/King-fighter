-- Guftin call recording: per-participant consent and private storage.
create table if not exists public.kc_call_recordings (
 id uuid primary key default gen_random_uuid(),
 call_id uuid not null references public.kc_call_logs(id) on delete cascade,
 requested_by uuid not null references auth.users(id) on delete cascade,
 status text not null default 'awaiting_consent'
  check (status in ('awaiting_consent','switching_to_recording','starting','recording','stopping','complete','declined','failed','cancelled')),
 media_type text not null check (media_type in ('voice','video')),
 egress_id text, storage_path text, error_message text,
 created_at timestamptz not null default now(), ended_at timestamptz
);
create index if not exists kc_call_recordings_call_id_created_idx
 on public.kc_call_recordings(call_id,created_at desc);
create unique index if not exists kc_call_recordings_one_active_per_call_idx
 on public.kc_call_recordings(call_id)
 where status in ('awaiting_consent','switching_to_recording','starting','recording','stopping');
create table if not exists public.kc_call_recording_consents (
 recording_id uuid not null references public.kc_call_recordings(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 decision text not null default 'pending' check (decision in ('pending','accepted','declined')),
 e2ee_disabled_at timestamptz, updated_at timestamptz not null default now(),
 primary key (recording_id,user_id)
);
create index if not exists kc_call_recording_consents_user_idx on public.kc_call_recording_consents(user_id,recording_id);
alter table public.kc_call_recordings enable row level security;
alter table public.kc_call_recording_consents enable row level security;
revoke all on public.kc_call_recordings from anon,authenticated;
revoke all on public.kc_call_recording_consents from anon,authenticated;
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('call-recordings','call-recordings',false,1073741824,array['video/mp4'])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists "participants upload Guftin call recordings" on storage.objects;
create policy "participants upload Guftin call recordings" on storage.objects for insert to authenticated
with check (
 bucket_id='call-recordings' and (storage.foldername(name))[1]=(select auth.uid())::text
 and exists (select 1 from public.kc_call_logs c where c.id=((storage.foldername(name))[2])::uuid
  and (c.caller_id=(select auth.uid()) or c.callee_id=(select auth.uid()) or exists (
   select 1 from public.kc_call_participants cp where cp.call_id=c.id and cp.user_id=(select auth.uid()) and cp.status in ('accepted','left')
  )))
);
drop policy if exists "participants read Guftin call recordings" on storage.objects;
create policy "participants read Guftin call recordings" on storage.objects for select to authenticated
using (
 bucket_id='call-recordings'
 and exists (select 1 from public.kc_call_logs c where c.id=((storage.foldername(name))[2])::uuid
  and (c.caller_id=(select auth.uid()) or c.callee_id=(select auth.uid()) or exists (
   select 1 from public.kc_call_participants cp where cp.call_id=c.id and cp.user_id=(select auth.uid())
  )))
);
