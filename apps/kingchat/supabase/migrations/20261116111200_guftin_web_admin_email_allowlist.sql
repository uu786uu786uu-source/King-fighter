create or replace function private.is_guftin_site_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from auth.users u
    where u.id = (select auth.uid())
      and u.email_confirmed_at is not null
      and lower(u.email) = any (array[
        'guftinofficial@gmail.com',
        'guftin@gmail.com',
        'guftinofficle@gmail.com'
      ]::text[])
  );
$$;

revoke all on function private.is_guftin_site_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_guftin_site_admin() to authenticated;
