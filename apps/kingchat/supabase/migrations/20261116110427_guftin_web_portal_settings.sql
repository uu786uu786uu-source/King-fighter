create table if not exists public.guftin_site_settings (
  id smallint primary key default 1 check (id = 1),
  app_version text not null default '1.5.6',
  android_download_url text,
  ios_download_url text,
  support_email text not null default 'guftinofficle@gmail.com',
  hero_title text not null default 'Stay close. Stay connected.',
  hero_description text not null default 'Messages, groups, shared media and supported calling features in one communication experience.',
  announcement text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.guftin_site_settings (
  id, app_version, android_download_url, ios_download_url,
  support_email, hero_title, hero_description, announcement
)
values (
  1, '1.5.6', null, null,
  'guftinofficle@gmail.com',
  'Stay close. Stay connected.',
  'Messages, groups, shared media and supported calling features in one communication experience.',
  'The browser chat is being introduced. Calling remains available in the Android app where the service is configured.'
)
on conflict (id) do nothing;

alter table public.guftin_site_settings enable row level security;
grant select on public.guftin_site_settings to anon, authenticated;
grant update on public.guftin_site_settings to authenticated;

drop policy if exists "Public can read Guftin site settings" on public.guftin_site_settings;
create policy "Public can read Guftin site settings"
on public.guftin_site_settings
for select to anon, authenticated using (true);

create or replace function private.is_guftin_site_admin()
returns boolean
language sql stable security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1 from auth.users u
    where u.id = (select auth.uid())
      and u.email_confirmed_at is not null
      and lower(u.email) = 'guftinofficle@gmail.com'
  );
$$;

revoke all on function private.is_guftin_site_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_guftin_site_admin() to authenticated;

drop policy if exists "Verified Guftin owner can update site settings" on public.guftin_site_settings;
create policy "Verified Guftin owner can update site settings"
on public.guftin_site_settings
for update to authenticated
using ((select private.is_guftin_site_admin()))
with check ((select private.is_guftin_site_admin()));
