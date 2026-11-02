-- Guftin: per-user chat/message hiding, delivery receipts, status likes and private-media paths.
alter table public.kc_conversation_members add column if not exists hidden_at timestamptz;

create table if not exists public.kc_message_hidden (
  message_id uuid not null references public.kc_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key(message_id,user_id)
);
alter table public.kc_message_hidden enable row level security;
revoke all on public.kc_message_hidden from public,anon,authenticated;
grant select,insert,delete on public.kc_message_hidden to authenticated;
create policy "read own hidden messages" on public.kc_message_hidden for select to authenticated using(user_id=(select auth.uid()));
create policy "hide own conversation messages" on public.kc_message_hidden for insert to authenticated with check(
 user_id=(select auth.uid()) and exists(select 1 from public.kc_messages m where m.id=message_id and public.kc_is_conversation_member(m.conversation_id))
);
create policy "unhide own messages" on public.kc_message_hidden for delete to authenticated using(user_id=(select auth.uid()));

create table if not exists public.kc_message_receipts (
 message_id uuid not null references public.kc_messages(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 delivered_at timestamptz not null default now(),
 primary key(message_id,user_id)
);
alter table public.kc_message_receipts enable row level security;
revoke all on public.kc_message_receipts from public,anon,authenticated;
grant select,insert on public.kc_message_receipts to authenticated;
create policy "read receipts in own conversations" on public.kc_message_receipts for select to authenticated using(
 exists(select 1 from public.kc_messages m where m.id=message_id and public.kc_is_conversation_member(m.conversation_id))
);
create policy "mark messages delivered to self" on public.kc_message_receipts for insert to authenticated with check(
 user_id=(select auth.uid()) and exists(select 1 from public.kc_messages m where m.id=message_id and m.sender_id<>(select auth.uid()) and public.kc_is_conversation_member(m.conversation_id))
);

create table if not exists public.kc_status_likes (
 status_id uuid not null references public.kc_status_updates(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default now(),
 primary key(status_id,user_id)
);
alter table public.kc_status_likes enable row level security;
revoke all on public.kc_status_likes from public,anon,authenticated;
grant select,insert,delete on public.kc_status_likes to authenticated;
create policy "read status likes" on public.kc_status_likes for select to authenticated using(
 user_id=(select auth.uid()) or exists(select 1 from public.kc_status_updates s where s.id=status_id and s.user_id=(select auth.uid()))
);
create policy "like visible contact status" on public.kc_status_likes for insert to authenticated with check(
 user_id=(select auth.uid()) and exists(select 1 from public.kc_status_updates s where s.id=status_id and s.user_id<>(select auth.uid()) and s.expires_at>now())
);
create policy "remove own status like" on public.kc_status_likes for delete to authenticated using(user_id=(select auth.uid()));

grant update(hidden_at) on public.kc_conversation_members to authenticated;

drop policy if exists "read media for conversation members" on storage.objects;
create policy "read Guftin private media" on storage.objects for select to authenticated using(
 bucket_id='chat-media' and (
  ((storage.foldername(name))[2]='profile' and exists(
   select 1 from public.kc_profiles p where p.avatar_url=name and (
    p.id=(select auth.uid()) or exists(
     select 1 from public.kc_conversation_members mine
     join public.kc_conversation_members theirs on theirs.conversation_id=mine.conversation_id
     where mine.user_id=(select auth.uid()) and theirs.user_id=p.id
    )
   )
  )) or
  ((storage.foldername(name))[2]='status' and exists(select 1 from public.kc_status_updates s where s.media_url=name and s.expires_at>now())) or
  ((storage.foldername(name))[2]<>'profile' and (storage.foldername(name))[2]<>'status'
    and public.kc_is_conversation_member((storage.foldername(name))[2]::uuid))
 )
);
drop policy if exists "upload media to own conversation folder" on storage.objects;
create policy "upload own Guftin media" on storage.objects for insert to authenticated with check(
 bucket_id='chat-media' and (storage.foldername(name))[1]=(select auth.uid())::text and
 ((storage.foldername(name))[2] in ('profile','status') or public.kc_is_conversation_member((storage.foldername(name))[2]::uuid))
);

create index if not exists kc_message_receipts_user_message_idx on public.kc_message_receipts(user_id,message_id);
create index if not exists kc_status_likes_status_idx on public.kc_status_likes(status_id,created_at desc);
