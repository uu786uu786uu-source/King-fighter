# Guftin Android Google Sign-In setup

Guftin Android uses Google's native Android Credential Manager through
`react-native-nitro-google-signin`. The Android Google button no longer uses
the Supabase OAuth browser redirect.

## Google Cloud configuration

All OAuth clients must belong to the same Google Cloud project:

- **Android OAuth client:** package name `com.guftin.app` and the SHA-1
  fingerprint for the certificate that signs the APK being installed.
- **Web application OAuth client:** this is the client ID used as
  `webClientId` by the native library and the same Web client configured in
  Supabase Authentication → Providers → Google.
- Keep the Web client secret private. It is not needed in the Android app.

## Build variable

Add the public Web client ID to the repository's GitHub Actions secrets under
the name `GUFTIN_GOOGLE_WEB_CLIENT_ID`. The build workflow injects it as
`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`.

The Web client ID is a public OAuth identifier, not a client secret. Never put
the client secret in the app, repository, or chat.

Android Google sign-in is not ready until this variable is supplied. If it is
missing, the APK shows a clear configuration message instead of opening a
broken web page.

## Token and nonce handling

Each sign-in attempt creates a random nonce, sends its SHA-256 hash to Google,
and passes the original nonce with the ID token to Supabase
`signInWithIdToken`. Supabase verifies the token and establishes the app
session. No Google client secret is stored by the app.
