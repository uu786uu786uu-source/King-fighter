revoke update on table public.kc_conversation_members from public, anon, authenticated;
grant update(last_read_at) on table public.kc_conversation_members to authenticated;

drop policy if exists "update own conversation read timestamp" on public.kc_conversation_members;
create policy "update own conversation read timestamp"
on public.kc_conversation_members
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create or replace function public.kc_mark_conversation_read(p_conversation_id uuid)
returns timestamptz
language plpgsql
security invoker
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
