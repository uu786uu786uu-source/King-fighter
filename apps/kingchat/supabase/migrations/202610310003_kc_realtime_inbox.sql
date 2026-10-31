-- Keep the real conversation inbox ordered and enable message INSERT events
-- for Supabase Realtime clients. RLS remains enforced on kc_messages.
create index if not exists kc_conversation_members_user_id_idx
  on public.kc_conversation_members(user_id, conversation_id);

create or replace function public.kc_touch_conversation_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.kc_conversations
  set updated_at = coalesce(new.created_at, now())
  where id = new.conversation_id;
  return new;
end;
$$;

revoke all on function public.kc_touch_conversation_on_message() from public, anon, authenticated;

drop trigger if exists kc_message_updates_conversation on public.kc_messages;
create trigger kc_message_updates_conversation
after insert on public.kc_messages
for each row execute function public.kc_touch_conversation_on_message();

alter publication supabase_realtime add table public.kc_messages;
