-- Group calling schema and authenticated participant-only access.
alter table public.kc_call_logs add column if not exists call_scope text not null default 'direct';
alter table public.kc_call_logs drop constraint if exists kc_call_logs_call_scope_check;
alter table public.kc_call_logs add constraint kc_call_logs_call_scope_check check (call_scope in ('direct','group'));

create table if not exists public.kc_call_participants (
  call_id uuid not null references public.kc_call_logs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('caller','invitee')),
  status text not null default 'invited' check (status in ('invited','ringing','accepted','declined','left')),
  invited_at timestamptz not null default now(),
  answered_at timestamptz,
  primary key (call_id,user_id)
);
alter table public.kc_call_participants enable row level security;
revoke all on public.kc_call_participants from anon, public;
grant select, update on public.kc_call_participants to authenticated;

drop policy if exists "read own group call participant row" on public.kc_call_participants;
create policy "read own group call participant row" on public.kc_call_participants
for select to authenticated using (user_id=(select auth.uid()));
drop policy if exists "update own group call participant row" on public.kc_call_participants;
create policy "update own group call participant row" on public.kc_call_participants
for update to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));

drop policy if exists "read own call logs" on public.kc_call_logs;
create policy "read call logs for direct parties or group participants" on public.kc_call_logs
for select to authenticated using (
  caller_id=(select auth.uid()) or callee_id=(select auth.uid()) or
  exists(select 1 from public.kc_call_participants cp where cp.call_id=kc_call_logs.id and cp.user_id=(select auth.uid()))
);

drop policy if exists "create direct conversation call invite" on public.kc_call_logs;
create policy "create direct conversation call invite" on public.kc_call_logs
for insert to authenticated with check (
  call_scope='direct' and caller_id=(select auth.uid()) and callee_id is not null and conversation_id is not null
  and exists (
    select 1 from public.kc_conversations conv
    join public.kc_conversation_members caller_member on caller_member.conversation_id=conv.id and caller_member.user_id=(select auth.uid())
    join public.kc_conversation_members callee_member on callee_member.conversation_id=conv.id and callee_member.user_id=kc_call_logs.callee_id
    where conv.id=kc_call_logs.conversation_id and conv.kind='direct'
      and (select count(*) from public.kc_conversation_members cm where cm.conversation_id=conv.id)=2
  )
);

create or replace function public.kc_create_group_call(p_conversation_id uuid,p_call_type text,p_e2ee_key_envelopes jsonb)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $function$
declare v_uid uuid:=auth.uid(); v_call_id uuid; v_member_count integer; v_callee uuid;
begin
  if v_uid is null then raise exception 'Sign in required'; end if;
  if p_call_type not in ('voice','video') then raise exception 'Unsupported call type'; end if;
  if jsonb_typeof(p_e2ee_key_envelopes)<>'object' or p_e2ee_key_envelopes->>'version'<>'1'
     or p_e2ee_key_envelopes->>'algorithm'<>'X25519-XSalsa20-Poly1305'
     or jsonb_typeof(p_e2ee_key_envelopes->'recipients')<>'object' then
    raise exception 'A valid end-to-end call key envelope is required';
  end if;
  if not exists (
    select 1 from public.kc_conversations c join public.kc_conversation_members m on m.conversation_id=c.id
    where c.id=p_conversation_id and c.kind='group' and m.user_id=v_uid
  ) then raise exception 'You are not a member of this group'; end if;
  select count(*),(array_agg(user_id order by user_id) filter(where user_id<>v_uid))[1]
    into v_member_count,v_callee from public.kc_conversation_members where conversation_id=p_conversation_id;
  if v_member_count<2 then raise exception 'A group call needs at least two members'; end if;
  if v_member_count>20 then raise exception 'Group calls support up to 20 participants'; end if;
  if v_callee is null then raise exception 'No other group members found'; end if;
  if exists(select 1 from public.kc_conversation_members m where m.conversation_id=p_conversation_id
    and not exists(select 1 from public.kc_e2ee_devices d where d.user_id=m.user_id and d.revoked_at is null))
    then raise exception 'Every group member must register an active encrypted device'; end if;
  if exists(select 1 from public.kc_conversation_members m
    join public.kc_e2ee_devices d on d.user_id=m.user_id and d.revoked_at is null
    where m.conversation_id=p_conversation_id and not(p_e2ee_key_envelopes->'recipients' ? d.id::text))
    then raise exception 'The call key must be wrapped to every active participant device'; end if;
  insert into public.kc_call_logs(conversation_id,caller_id,callee_id,call_type,status,call_scope,e2ee_key_envelopes)
  values(p_conversation_id,v_uid,v_callee,p_call_type,'ringing','group',p_e2ee_key_envelopes) returning id into v_call_id;
  insert into public.kc_call_participants(call_id,user_id,role,status,answered_at)
  select v_call_id,m.user_id,case when m.user_id=v_uid then 'caller' else 'invitee' end,
    case when m.user_id=v_uid then 'accepted' else 'ringing' end,
    case when m.user_id=v_uid then now() else null end
  from public.kc_conversation_members m where m.conversation_id=p_conversation_id;
  return v_call_id;
end; $function$;
revoke all on function public.kc_create_group_call(uuid,text,jsonb) from public,anon;
grant execute on function public.kc_create_group_call(uuid,text,jsonb) to authenticated;

create or replace function public.kc_answer_group_call(p_call_id uuid,p_status text)
returns text language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $function$
declare v_uid uuid:=auth.uid(); v_call public.kc_call_logs%rowtype;
  v_participant public.kc_call_participants%rowtype; v_pending integer; v_accepted integer;
begin
  if v_uid is null then raise exception 'Sign in required'; end if;
  if p_status not in ('accepted','declined') then raise exception 'Invalid call response'; end if;
  select * into v_call from public.kc_call_logs where id=p_call_id and call_scope='group' for update;
  if not found then raise exception 'Group call not found'; end if;
  if v_call.status not in ('ringing','accepted') then raise exception 'This call is no longer active'; end if;
  select * into v_participant from public.kc_call_participants where call_id=p_call_id and user_id=v_uid for update;
  if not found or v_participant.role<>'invitee' then raise exception 'You were not invited to this group call'; end if;
  if v_participant.status not in ('ringing','invited') then raise exception 'You have already responded to this call'; end if;
  update public.kc_call_participants set status=p_status,answered_at=now() where call_id=p_call_id and user_id=v_uid;
  if p_status='accepted' then update public.kc_call_logs set status='accepted',started_at=coalesce(started_at,now()) where id=p_call_id;
  else
    select count(*) filter(where status in ('ringing','invited')),count(*) filter(where status='accepted')
      into v_pending,v_accepted from public.kc_call_participants where call_id=p_call_id and role='invitee';
    if v_pending=0 and v_accepted=0 then update public.kc_call_logs set status='declined',ended_at=now() where id=p_call_id; end if;
  end if;
  return p_status;
end; $function$;
revoke all on function public.kc_answer_group_call(uuid,text) from public,anon;
grant execute on function public.kc_answer_group_call(uuid,text) to authenticated;

create or replace function public.kc_leave_group_call(p_call_id uuid)
returns text language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $function$
declare v_uid uuid:=auth.uid(); v_call public.kc_call_logs%rowtype; v_role text; v_remaining integer;
begin
  if v_uid is null then raise exception 'Sign in required'; end if;
  select * into v_call from public.kc_call_logs where id=p_call_id and call_scope='group' for update;
  if not found then raise exception 'Group call not found'; end if;
  select role into v_role from public.kc_call_participants where call_id=p_call_id and user_id=v_uid for update;
  if v_role is null then raise exception 'You are not a participant in this call'; end if;
  update public.kc_call_participants set status='left' where call_id=p_call_id and user_id=v_uid;
  if v_role='caller' then update public.kc_call_logs set status='ended',ended_at=now() where id=p_call_id;
  else
    select count(*) into v_remaining from public.kc_call_participants
      where call_id=p_call_id and role='invitee' and status in ('ringing','invited','accepted');
    if v_remaining=0 then update public.kc_call_logs set status='ended',ended_at=now() where id=p_call_id; end if;
  end if;
  return 'left';
end; $function$;
revoke all on function public.kc_leave_group_call(uuid) from public,anon;
grant execute on function public.kc_leave_group_call(uuid) to authenticated;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='kc_call_participants')
  then alter publication supabase_realtime add table public.kc_call_participants; end if;
end $$;
