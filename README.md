# King Chat 👑

A mobile-first WhatsApp-inspired chat starter using Firebase Authentication and Cloud Firestore.

## Included
- Email/password sign-up and sign-in
- Google sign-in (enable provider in Firebase)
- User directory and one-to-one text conversations
- Live message updates through Firestore listeners
- Responsive mobile-first layout

## Firebase setup
1. Create a project at https://console.firebase.google.com/.
2. Register a Web app in Project settings and copy the Firebase config.
3. Replace the placeholder `firebaseConfig` values in `index.html`.
4. In Authentication > Sign-in method, enable Email/Password and Google.
5. Create a Cloud Firestore database.
6. Apply `firestore.rules` and review them before production.
7. Add your website domain under Authentication > Settings > Authorized domains.

## Run
Test using a local static server or deploy to Firebase Hosting / GitHub Pages. Firebase client config is not a secret; access must be protected by Security Rules.

## Android APK
This repository currently contains a web app starter, not a compiled APK. To create an installable Android APK, wrap it with Capacitor or build a native Android app, configure Firebase, and build with Android Studio/Gradle. A signed release APK requires your own signing key.

## Not included yet
Voice/video calls, push notifications, photo/video/file sharing, group chats, status stories, contact syncing, reactions, read receipts, backups and end-to-end encryption. This starter does not have WhatsApp's security or full feature parity.
