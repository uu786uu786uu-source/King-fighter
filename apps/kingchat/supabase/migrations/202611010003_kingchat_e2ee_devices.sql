-- Public device keys only. Private keys stay in each device's OS-backed secure storage.
create table if not exists public.kc_e2ee_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  public_key text not null check (public_key ~ '^[0-9a-f]{64}$'),
  device_label text not null default 'King Chat device',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint kc_e2ee_devices_user_public_key_uq unique (user_id, public_key)
);

create index if not exists kc_e2ee_devices_user_active_idx
  on public.kc_e2ee_devices(user_id) where revoked_at is null;

alter table public.kc_e2ee_devices enable row level security;

revoke all on table public.kc_e2ee_devices from public, anon, authenticated;
grant select, insert, update on table public.kc_e2ee_devices to authenticated;

drop policy if exists "read own and conversation device keys" on public.kc_e2ee_devices;
create policy "read own and conversation device keys"
on public.kc_e2ee_devices
for select
to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1
    from public.kc_conversation_members mine
    join public.kc_conversation_members theirs
      on theirs.conversation_id = mine.conversation_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = kc_e2ee_devices.user_id
  )
);

drop policy if exists "register own encryption device" on public.kc_e2ee_devices;
create policy "register own encryption device"
on public.kc_e2ee_devices
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists "revoke own encryption device" on public.kc_e2ee_devices;
create policy "revoke own encryption device"
on public.kc_e2ee_devices
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));
