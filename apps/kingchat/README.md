# King Chat — email and username messaging app

Expo React Native app using Supabase Auth, Postgres, Realtime and RLS.

## Account and contact model

- Sign up with email, password, display name and a unique username.
- Sign in with email and password only.
- Each account has a public King Chat username (3–24 lowercase letters, numbers or underscores).
- Use **＋** on the Chats screen to find a member by exact username and create/save a direct conversation.
- Direct messages are stored in `kc_messages` and synchronized with Supabase Realtime.
- Email addresses stay in Supabase Auth and are not exposed in the public profile table.

## Supabase setup required

1. Apply migrations in `supabase/migrations` in numeric order. The username migration adds profile completion and username lookup RPCs; the privacy migration limits public profile columns.
2. In **Authentication → Providers → Email**, keep email/password enabled. Email confirmation is recommended.
3. In **Authentication → URL Configuration → Redirect URLs**, add `kingchat://auth/callback`. The app scheme is `kingchat`.
4. Configure a production SMTP sender for reliable signup confirmation and password recovery emails. Supabase's default sender is rate-limited and intended for testing.
5. Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in the build environment if using another Supabase project. Never embed a service-role or secret key in the APK.

## Build

`npm install`, `npm run typecheck`, then `npx expo prebuild --platform android --non-interactive` and build the Android release using Gradle `assembleRelease`.

## Current limitations

This release implements email/password auth, username profiles, username contact discovery, direct chats, group creation, message/media uploads, Realtime updates, status posts/reactions, and direct LiveKit voice/video calls. New calls carry a random 32-byte media E2EE key, encrypted separately for each active conversation device with its registered X25519 public key. The LiveKit React Native E2EE manager enables room media encryption on both participants. Calls still require a valid LiveKit server and the three private Edge Function secrets documented below. Background push still requires an Expo EAS project ID and Firebase FCM V1 credentials. Message and call encryption have no verified safety numbers or forward secrecy and have not had an independent security audit. Do not present the app as a finished WhatsApp replacement until external services and two-device behavior are independently tested.


## Push notifications and gallery saving

- On first launch, Guftin creates its notification channels and asks the OS for notification permission. After sign-in, it registers this device in `kc_device_tokens` when permission is granted. The Settings switch remains available to re-enable notifications.
- Set the actual Expo EAS project ID as the GitHub Actions variable or secret `EXPO_PUBLIC_EAS_PROJECT_ID`. This value was empty in previous builds, so the app could ask for OS permission but could not register Expo push tokens.
- Add the Firebase Android configuration file as `apps/kingchat/google-services.json`. The Expo app config automatically includes it when present. Configure the Firebase Cloud Messaging (FCM) V1 service-account key in the linked Expo project's credentials before expecting Android push notifications when the app is in the background or closed.
- The Supabase `guftin-push` Edge Function sends generic message/call notifications after a message/call is created. No message text is included in the notification payload.
- Users can save individual photo/video messages to their gallery, or enable auto-save in Settings. Gallery access is requested by the OS when needed.
- Incoming call pushes use the `calls` Android notification channel and expose Accept/Decline actions. Android still needs real FCM configuration and physical-device testing; force-stopping the app in Android Settings can prevent delivery until the app is opened again.


## LiveKit voice/video calls

- Direct voice/video calls use LiveKit rooms. The app requests a short-lived participant token from the `livekit-token` Supabase Edge Function only after the call is accepted.
- Each new call generates a fresh 32-byte random media key. The key is encrypted separately to every active E2EE device in the direct conversation and stored as ciphertext in `kc_call_logs.e2ee_key_envelopes`. Each device unwraps only its own copy; LiveKit receives the shared key only inside the installed clients.
- LiveKit's React Native `useRNE2EEManager` applies media E2EE to the room. LiveKit signaling, room metadata and API requests remain TLS-protected rather than end-to-end encrypted. The current design has no safety-number verification or forward secrecy and is not independently audited.
- In Supabase Dashboard → Edge Functions → Secrets, set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` for the `oyjemlbsmffvofefgxvd` project. Use the server URL and credentials from the LiveKit project. Never put the API secret in the APK, app config, or GitHub source.
- Previous call attempts returned HTTP 503 because those LiveKit secrets were not configured. Calls cannot connect until all three values are saved.
- Calls created by older app versions have no E2EE call-key envelope; the new app refuses to join those calls rather than silently falling back to unencrypted media.


## AdMob (test mode by default)

- The build includes Google's official TEST App IDs and TEST banner unit by default.
- Banner ads appear on the main tabs; chat, call, and sign-in screens do not display a banner.
- Requests are non-personalized and content-rated conservatively.
- Live AdMob monetization is intentionally not enabled by default. Google's publisher rules require the AdMob account holder to be at least 18; a parent/guardian may apply with their own Google Account and payments are issued to that person.
- For an approved adult-managed publisher account only, set `ADMOB_ANDROID_APP_ID`, `ADMOB_IOS_APP_ID`, and `EXPO_PUBLIC_ADMOB_BANNER_UNIT_ID` in the build environment. The unit ID must be a Banner-format unit. Keep these outside Git.
- The two Ad Unit IDs in the screenshots are not used in this test build because the screenshots do not show which format each unit belongs to. Do not use a non-banner unit in the banner placement.


## Navigation, sessions and live status updates

- Supabase Auth persists sessions in AsyncStorage and the app waits for session restoration before showing the sign-in screen.
- Android hardware Back dismisses dialogs, returns from a chat to the chat list, and navigates other tabs back to Chats without immediately exiting Guftin from its home tab.
- Status updates, views and likes are included in the `supabase_realtime` publication. The Updates tab listens for changes and also refreshes periodically while it is open.
- The main tab bar reserves the Android navigation safe-area inset to keep controls clear of the system navigation buttons.
