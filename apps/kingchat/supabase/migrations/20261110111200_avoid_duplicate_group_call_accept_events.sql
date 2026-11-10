create or replace function public.kc_answer_group_call(p_call_id uuid,p_status text)
returns text language plpgsql security definer
set search_path=pg_catalog,public,pg_temp as $function$
declare
 v_uid uuid:=auth.uid(); v_call public.kc_call_logs%rowtype;
 v_participant public.kc_call_participants%rowtype; v_pending integer; v_accepted integer;
begin
 if v_uid is null then raise exception 'Sign in required'; end if;
 if p_status is null or p_status not in ('accepted','declined') then raise exception 'Invalid call response'; end if;
 select * into v_call from public.kc_call_logs where id=p_call_id and call_scope='group' for update;
 if not found then raise exception 'Group call not found'; end if;
 if v_call.status not in ('ringing','accepted') then raise exception 'This call is no longer active'; end if;
 if not exists(select 1 from public.kc_conversation_members m where m.conversation_id=v_call.conversation_id and m.user_id=v_uid)
 then raise exception 'You are no longer a member of this group'; end if;
 select * into v_participant from public.kc_call_participants where call_id=p_call_id and user_id=v_uid for update;
 if not found or v_participant.role<>'invitee' then raise exception 'You were not invited to this group call'; end if;
 if v_participant.status not in ('ringing','invited') then raise exception 'You have already responded to this call'; end if;
 update public.kc_call_participants set status=p_status,answered_at=now() where call_id=p_call_id and user_id=v_uid;
 if p_status='accepted' then
   if v_call.status='ringing' then
     update public.kc_call_logs set status='accepted',started_at=coalesce(started_at,now()) where id=p_call_id;
   end if;
 else
   select count(*) filter(where status in ('ringing','invited')),count(*) filter(where status='accepted')
     into v_pending,v_accepted from public.kc_call_participants where call_id=p_call_id and role='invitee';
   if v_pending=0 and v_accepted=0 then
     update public.kc_call_logs set status='declined',ended_at=now() where id=p_call_id;
   end if;
 end if;
 return p_status;
end; $function$;
revoke all on function public.kc_answer_group_call(uuid,text) from public,anon;
grant execute on function public.kc_answer_group_call(uuid,text) to authenticated;
