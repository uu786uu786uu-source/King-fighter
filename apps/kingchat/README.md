# King Chat — Native app foundation
Expo React Native + Supabase messaging app foundation.

## Included
- Native Android project setup and Supabase client with persistent auth session
- Schema for profiles, direct/group/channel conversations, memberships, messages, replies, reactions, 24-hour statuses, call logs and device tokens
- Row-level security policies and private chat-media bucket
- Phone OTP-ready Supabase Auth integration point

## Setup
1. Install Node.js LTS.
2. `cd apps/kingchat && npm install`
3. Copy `.env.example` to `.env`, set Supabase URL and anon key.
4. Apply SQL in `supabase/migrations` to the linked Supabase project.
5. Configure Phone Auth and an SMS provider in Supabase before enabling OTP login.
6. Run `npx expo start`; use EAS Build for an installable Android build.

Calls need a production WebRTC/SFU provider, TURN infrastructure and push notifications; this foundation does not claim live calling or end-to-end encryption. Never embed a service-role key in the mobile app. Add privacy policy, account deletion and Play Console testing before release.
