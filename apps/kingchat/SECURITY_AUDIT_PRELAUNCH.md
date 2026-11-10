# Guftin — Internal Security Review (Pre-launch)

**Review date:** 10 November 2026  
**Scope:** Static review of the mobile client, Supabase schema/RLS and deployed call/push Edge Functions; Supabase Security and Performance Advisor output.  
**Status:** Partial internal review. This is not an independent penetration test, cryptographic audit, or WhatsApp-equivalence certification.

## Implemented controls observed

- New direct-message text and photo/video/voice media use device-side encryption; attachments are stored as ciphertext and decrypted locally on registered devices.
- Direct voice/video calling uses LiveKit media E2EE with a per-call key wrapped to registered devices.
- Group-call creation requires every group member to have an active registered device and verifies that the key envelope contains exactly the active group device set.
- Group calls are limited to 20 members (including the caller). Group creation, acceptance and leave are server-side RPCs; participant rows are RLS-protected and clients cannot directly update participant state.
- Group-call history and log reads require current group membership as well as a participant row.
- Direct-call insertion requires a two-member direct conversation, a ringing state, voice/video type and a key envelope covering the active devices of both users. Direct call updates are limited by RLS to direct participants.
- LiveKit token issuance requires an accepted call; group token issuance additionally re-checks current group membership and accepted participant state.
- Group-call push recipients are filtered against current group membership before notifications are sent.
- The private chat-media bucket remains non-public; its MIME allowlist includes PDF, Microsoft Word/Excel/PowerPoint, TXT and CSV. The app enforces a 45 MiB document limit under the bucket's 50 MiB cap.
- Call push notifications contain call metadata, not message body text or attachment contents.

## Findings and remaining work

| Finding | Severity | Status / action |
|---|---|---|
| No forward secrecy / no Double Ratchet-style per-message key evolution was found in the current E2EE design. | High | Outstanding protocol redesign and cryptographic review required. |
| No verified safety numbers / out-of-band identity verification flow was found. | High | Outstanding. Add key-change warnings and a user-verifiable fingerprint flow before claiming strong identity assurance. |
| Supabase Auth leaked-password protection is reported disabled by the Security Advisor. | High | Dashboard owner action required: enable breached-password protection/password policy and re-run the advisor. |
| Supabase Advisor reports anonymous-access policy warnings across app tables because Auth anonymous sign-ins are enabled or may be enabled. | High | Review Auth anonymous sign-in setting in Dashboard. Guftin UI uses password-based sign-in; disable anonymous sign-ins if not required, then re-run advisor and anonymous-session tests. |
| Six SECURITY DEFINER RPCs are reported executable by authenticated users: three existing profile/contact helpers and three group-call RPCs. | Medium | New group-call functions revoke PUBLIC/anon execution, grant only authenticated, validate auth.uid and group membership/participant state, and use fixed search paths. The legacy helpers still need focused review. |
| Status media/updates are not end-to-end encrypted. | Medium | Explicit product limitation. Do not describe status as E2EE. |
| Device-private keys are not recoverable after Android reinstall; there is no audited recovery or forward secrecy. | High | Outstanding recovery/key-rotation design review. |
| No independent security audit or real-device abuse testing has been completed. | High | Required before public claims comparable to WhatsApp. |

## Verification still required before production release

1. Finish the signed Android build and inspect its artifact.
2. Test two-, three- and 20-member group calls on separate physical devices, including simultaneous answers/declines, caller cancellation, member removal during ringing, participant leave, network interruption and app background/termination.
3. Verify microphone mute, speaker/earpiece/Bluetooth routing, camera enable/disable and front/rear switch across supported Android devices.
4. Test PDF/DOC/DOCX/XLS/XLSX/PPT/PPTX/TXT/CSV transfer, offline queueing/retry, recipient decryption, Android open/share chooser and size limits.
5. Test RLS with non-members, removed members, revoked devices, forged call IDs and attempts to read other participant rows.
6. Enable breached-password protection; review Auth anonymous sign-ins; re-run Supabase Security Advisor.
7. Commission an independent mobile/backend/cryptographic penetration test and publish a remediation report.

## Product claim boundary

The feature branch contains code for group calling, document attachment support and in-call controls. A successful compile/build is not evidence of physical-device behavior. Guftin must not be advertised as WhatsApp-level secure until the outstanding cryptographic gaps and independent audit are closed.
