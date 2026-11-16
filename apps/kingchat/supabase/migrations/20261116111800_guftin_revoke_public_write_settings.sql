
revoke all privileges on table public.guftin_site_settings from anon;
grant select (
  id, app_version, android_download_url, ios_download_url, support_email,
  hero_title, hero_description, announcement, intro_title,
  intro_paragraph_one, intro_paragraph_two,
  feature_1_title, feature_1_description,
  feature_2_title, feature_2_description,
  feature_3_title, feature_3_description,
  feature_4_title, feature_4_description,
  feature_5_title, feature_5_description,
  feature_6_title, feature_6_description,
  experience_title, experience_description, footer_tagline
) on table public.guftin_site_settings to anon;
