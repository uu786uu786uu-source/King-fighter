-- Per-device encrypted shared key for each 1:1 LiveKit call.
-- The JSONB envelope contains no plaintext key; each device receives a
-- NaCl box-encrypted copy addressed to its registered E2EE public key.
alter table public.kc_call_logs
  add column if not exists e2ee_key_envelopes jsonb;

alter table public.kc_call_logs
  drop constraint if exists kc_call_logs_e2ee_key_envelopes_object_check;

alter table public.kc_call_logs
  add constraint kc_call_logs_e2ee_key_envelopes_object_check
  check (
    e2ee_key_envelopes is null
    or jsonb_typeof(e2ee_key_envelopes) = 'object'
  );
