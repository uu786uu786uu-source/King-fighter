drop policy if exists "read call logs for direct parties or group participants" on public.kc_call_logs;
drop policy if exists "read direct call parties and current group participants" on public.kc_call_logs;
drop policy if exists "read direct call parties and active group members" on public.kc_call_logs;
create policy "read direct parties and active group participants" on public.kc_call_logs
for select to authenticated using (
 (call_scope='direct' and (caller_id=(select auth.uid()) or callee_id=(select auth.uid())))
 or
 (call_scope='group'
  and exists(select 1 from public.kc_call_participants cp where cp.call_id=kc_call_logs.id and cp.user_id=(select auth.uid()))
  and exists(select 1 from public.kc_conversation_members cm where cm.conversation_id=kc_call_logs.conversation_id and cm.user_id=(select auth.uid())))
);