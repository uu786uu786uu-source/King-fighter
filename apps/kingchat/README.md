# King Chat — email and username messaging app

Expo React Native app using Supabase Auth, Postgres, Realtime and RLS.

## Account and contact model

- Sign up with email, password, display name and a unique username.
- Sign in with email/password or continue with Google OAuth.
- Each account has a public King Chat username (3–24 lowercase letters, numbers or underscores).
- Use **＋** on the Chats screen to find a member by exact username and create/save a direct conversation.
- Direct messages are stored in `kc_messages` and synchronized with Supabase Realtime.
- Email addresses stay in Supabase Auth and are not exposed in the public profile table.

## Supabase setup required

1. Apply migrations in `supabase/migrations` in numeric order. The username migration adds profile completion and username lookup RPCs; the privacy migration limits public profile columns.
2. In **Authentication → Providers → Email**, keep email/password enabled. Email confirmation is recommended.
3. In **Authentication → URL Configuration → Redirect URLs**, add `kingchat://auth/callback`. The app scheme is `kingchat`.
4. For Google sign-in, enable **Google** under **Authentication → Providers**, enter the OAuth Web Client ID and Client Secret from the Google Cloud project, and save.
5. In Google Cloud OAuth client settings, add this Supabase callback URI as an authorized redirect URI:
   `https://oyjemlbsmffvofefgxvd.supabase.co/auth/v1/callback`
6. Configure a production SMTP sender for reliable signup confirmation and password recovery emails. Supabase's default sender is rate-limited and intended for testing.
7. Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in the build environment if using another Supabase project. Never embed a service-role or secret key in the APK.

## Build

`npm install`, `npm run typecheck`, then `npx expo prebuild --platform android --non-interactive` and build the Android release using Gradle `assembleRelease`.

## Current limitations

This release implements email/password auth, a Google OAuth flow, username profiles, username contact discovery, direct chat history, message sending, Realtime updates and profile editing. Google sign-in works only after Google OAuth credentials and the redirect allow-list are configured in Supabase. Voice/video calling, status publishing, media uploads, push notifications, account deletion UX and end-to-end encryption are not implemented yet. Do not present the app as a finished WhatsApp replacement until those areas are built and independently tested.
