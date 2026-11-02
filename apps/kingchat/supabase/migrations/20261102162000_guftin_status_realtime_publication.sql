-- Guftin: publish status, views and likes to Supabase Realtime.
-- Idempotent so it can be replayed after the live project has already been configured.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'kc_status_updates',
    'kc_status_views',
    'kc_status_likes'
  ] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end $$;
