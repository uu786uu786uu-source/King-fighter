-- Restrict profile/contact RPCs to signed-in users only.
revoke all on function public.kc_add_contact_by_username(text) from public, anon;
grant execute on function public.kc_add_contact_by_username(text) to authenticated;
revoke all on function public.kc_finish_profile(text,text) from public, anon;
grant execute on function public.kc_finish_profile(text,text) to authenticated;
revoke all on function public.kc_sync_auth_profile() from public, anon, authenticated;
