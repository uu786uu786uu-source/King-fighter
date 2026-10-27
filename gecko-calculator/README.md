# Gecko Calculator for Android

A native Android calculator starter with a dark green Gecko-inspired interface.

## Included
- Standard arithmetic with brackets and operator precedence
- Scientific functions: sin, cos, tan, square root, square, log and ln
- BMI, discount, loan-payment, length conversion and example USD-to-PKR conversion
- Recent calculation history
- AdMob banner and rewarded-ad unit configuration based on the IDs supplied by the owner

## Build an APK on GitHub
1. Open the repository's **Actions** tab.
2. Select **Build Gecko Calculator APK**.
3. If a run has not started automatically, choose **Run workflow**.
4. Open the successful run and download the **Gecko-Calculator-debug-APK** artifact ZIP.
5. Extract it to find `app-debug.apk`, then install it on your Android device.

The workflow builds a debug APK, not a Play Store release. A signed release requires a private signing key.

## Important notes
- The currency conversion currently uses a sample rate of 284.50 PKR per USD; it is not a live exchange-rate feed.
- AdMob ads can take time to begin serving. Verify the AdMob app and unit IDs in your account and follow Google's consent and policy requirements before production use.
- This is source code plus an automated build workflow. The APK download is only available after GitHub Actions completes successfully.
