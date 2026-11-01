do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime'
      and schemaname='public'
      and tablename='kc_conversation_members'
  ) then
    alter publication supabase_realtime add table public.kc_conversation_members;
  end if;
end $$;
