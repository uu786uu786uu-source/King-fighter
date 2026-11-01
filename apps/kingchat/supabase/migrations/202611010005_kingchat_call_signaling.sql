-- Restrict call invites to direct-conversation members and publish call state for realtime ringing.
alter table public.kc_call_logs
  drop constraint if exists kc_call_logs_call_type_check;
alter table public.kc_call_logs
  add constraint kc_call_logs_call_type_check
  check (call_type is null or call_type in ('voice','video'));

alter table public.kc_call_logs
  drop constraint if exists kc_call_logs_status_check;
alter table public.kc_call_logs
  add constraint kc_call_logs_status_check
  check (status is null or status in ('ringing','accepted','declined','ended','missed','cancelled'));

drop policy if exists "create call log" on public.kc_call_logs;
create policy "create direct conversation call invite"
on public.kc_call_logs
for insert
to authenticated
with check (
  caller_id = (select auth.uid())
  and callee_id is not null
  and conversation_id is not null
  and exists (
    select 1
    from public.kc_conversations conv
    join public.kc_conversation_members caller_member
      on caller_member.conversation_id = conv.id
     and caller_member.user_id = (select auth.uid())
    join public.kc_conversation_members callee_member
      on callee_member.conversation_id = conv.id
     and callee_member.user_id = kc_call_logs.callee_id
    where conv.id = kc_call_logs.conversation_id
      and conv.kind = 'direct'
      and (select count(*) from public.kc_conversation_members cm where cm.conversation_id = conv.id) = 2
  )
);

drop policy if exists "update participant call" on public.kc_call_logs;
create policy "participants update call state"
on public.kc_call_logs
for update
to authenticated
using (
  caller_id = (select auth.uid())
  or callee_id = (select auth.uid())
)
with check (
  caller_id = (select auth.uid())
  or callee_id = (select auth.uid())
);

revoke update on public.kc_call_logs from public, anon, authenticated;
grant update(status, started_at, ended_at) on public.kc_call_logs to authenticated;
grant select, insert on public.kc_call_logs to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'kc_call_logs'
  ) then
    alter publication supabase_realtime add table public.kc_call_logs;
  end if;
end $$;
