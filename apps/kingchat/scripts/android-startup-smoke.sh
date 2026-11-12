#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$GITHUB_WORKSPACE/apps/kingchat"
APK="$PROJECT_ROOT/android/app/build/outputs/apk/release/app-release.apk"
LOG="$PROJECT_ROOT/startup-smoke-logcat.txt"

capture_logs() {
  adb logcat -d -v threadtime > "$LOG" 2>/dev/null || true
}
trap capture_logs EXIT

if [[ ! -s "$APK" ]]; then
  echo "::error::Release APK not found or empty: $APK"
  exit 1
fi
ls -lh "$APK"

adb wait-for-device
timeout 180s adb install -r "$APK"
adb logcat -c
timeout 30s adb shell monkey -p com.guftin.app -c android.intent.category.LAUNCHER 1

# Give React Native, native modules, and the first screen time to initialize.
sleep 60
capture_logs

PID="$(adb shell pidof -s com.guftin.app | tr -d '\r' || true)"
if [[ -z "$PID" ]]; then
  echo "::error::Guftin process exited after launch. Inspect the attached startup-smoke-logcat.txt for the fatal exception."
  grep -E -i 'FATAL EXCEPTION|Fatal signal|UnsatisfiedLinkError|AndroidRuntime|ReactNativeJS|SoLoader|LiveKit' "$LOG" | tail -n 160 || true
  exit 1
fi

if grep -E -q 'FATAL EXCEPTION|Fatal signal [0-9]+|TurboModuleInteropUtils|Exception in HostObject' "$LOG"; then
  echo "::error::Android reported a fatal exception or native-module startup error. Inspect startup-smoke-logcat.txt."
  grep -E -i 'FATAL EXCEPTION|Fatal signal|TurboModuleInteropUtils|Exception in HostObject|UnsatisfiedLinkError|AndroidRuntime|ReactNativeJS|SoLoader|LiveKit' "$LOG" | tail -n 160 || true
  exit 1
fi

RESUMED_ACTIVITY="$(adb shell dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | grep -F 'com.guftin.app' || true)"
if [[ -z "$RESUMED_ACTIVITY" ]]; then
  echo "::error::Guftin process is alive but its launcher activity is not resumed."
  exit 1
fi

echo "Guftin remained alive for 60 seconds and its launcher activity stayed resumed (PID $PID)."
echo "$RESUMED_ACTIVITY"
