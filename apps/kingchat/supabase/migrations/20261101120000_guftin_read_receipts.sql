create or replace function public.kc_mark_conversation_read(p_conversation_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid uuid := auth.uid();
  v_read_at timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  update public.kc_conversation_members
     set last_read_at = v_read_at
   where conversation_id = p_conversation_id
     and user_id = v_uid;

  if not found then
    raise exception 'You are not a member of this conversation';
  end if;

  return v_read_at;
end;
$$;

revoke all on function public.kc_mark_conversation_read(uuid) from public, anon;
grant execute on function public.kc_mark_conversation_read(uuid) to authenticated;

create index if not exists kc_messages_conversation_sender_created_idx
on public.kc_messages(conversation_id, sender_id, created_at desc)
where deleted_at is null;
