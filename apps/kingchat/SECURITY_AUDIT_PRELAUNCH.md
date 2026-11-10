# Guftin — Internal Security Review (Pre-launch)

**Review date:** 10 November 2026  
**Scope:** Static review of the mobile client, Supabase schema/RLS and the deployed call/push Edge Functions; Supabase Security and Performance Advisor output.  
**Status:** Partial internal review. This is not an independent penetration test, cryptographic audit, or WhatsApp-equivalence certification.

## Implemented controls observed

- New direct-message text and photo/video/voice media use device-side encryption; attachments are stored as ciphertext and decrypted locally on registered devices.
- Direct voice/video calling uses LiveKit media E2EE with a per-call key wrapped to registered devices.
- Group-call creation requires every group member to have an active registered device and verifies that the call-key envelope contains a recipient entry for every active participant device.
- Group calls are limited to 20 group members (including the caller). Group membership, participant rows, call acceptance/decline/leave and LiveKit token issuance are checked server-side.
- Group-call participant rows are RLS-enabled and readable only by the participant themselves. Client-side updates to those rows are revoked; state transitions occur through authenticated RPCs.
- Group/direct call tokens are issued only for accepted calls. The group-call token path additionally checks that the current user has an accepted participant row.
- Call push notifications carry call metadata, not message body text or attachment content. The push Edge Function validates the signed-in actor and call ownership before dispatch.

## Findings and remaining work

| Finding | Severity | Status / action |
|---|---|---|
| No forward secrecy / no Double Ratchet-style per-message key evolution was found in the current E2EE design. | High | Outstanding protocol redesign and cryptographic review required. |
| No verified safety numbers / out-of-band identity verification flow was found. | High | Outstanding. Add key-change warnings and a user-verifiable fingerprint flow before claiming strong identity assurance. |
| Supabase Auth leaked-password protection is reported disabled by the Security Advisor. | High | Dashboard owner action required: enable leaked-password protection and password policy controls, then re-run the advisor. |
| Supabase Advisor reports anonymous-access warnings on tables with authenticated RLS policies. | High | The listed table policies inspected in this review target authenticated, not the anon role. Confirm whether anonymous Auth sign-ins are enabled; disable anonymous sign-ins if Guftin does not intentionally support them, and retest with an anonymous session. |
| Six exposed SECURITY DEFINER RPCs are callable by authenticated users: three existing profile/contact helpers and the three new group-call RPCs. | Medium | The new group-call functions revoke PUBLIC and anon execution and grant only authenticated; they validate auth.uid plus group membership/participant state and use a fixed search path. The three legacy RPCs still need a focused privilege/function review. The Advisor warning remains because authenticated users can invoke definer functions. |
| Status media/updates are not end-to-end encrypted. | Medium | Explicit product limitation. Do not describe status as E2EE. |
| Device-private keys are not recoverable after Android reinstall, and the current model does not provide audited recovery or forward secrecy. | High | Outstanding key backup/recovery design review; never promise account recovery of these keys. |
| No independent security audit or real-device abuse testing has been completed. | High | Required before public claims comparable to WhatsApp. |

## Verification still required before production release

1. Build the Android APK from this feature branch and pass TypeScript/build checks.
2. Test two-, three- and maximum-size group calls across separate physical devices, including simultaneous answer/decline, caller cancellation, participant leave, network interruption and app background/termination.
3. Verify microphone mute, speaker/earpiece/Bluetooth routing, camera enable/disable and front/rear switch on the supported Android handset matrix.
4. Test PDF/DOC/DOCX/XLS/XLSX/PPT/PPTX/TXT/CSV transfer, offline queueing, retry, recipient decryption, Android open/share chooser and the 45 MB limit.
5. Run authorization tests for non-members, removed members, revoked devices, forged call IDs, unaccepted call tokens, and attempts to read another participant row.
6. Enable breached-password protection; review Auth anonymous sign-in settings; re-run Supabase Security Advisor.
7. Commission an independent mobile/backend/cryptographic penetration test and publish a remediation report.

## Product claim boundary

The code now contains group calling, document attachment support and in-call controls on this feature branch. These changes are not yet verified on physical devices and are not yet included in a newly built APK. Guftin must not be advertised as WhatsApp-level secure until the outstanding cryptographic design gaps and independent audit are closed.
