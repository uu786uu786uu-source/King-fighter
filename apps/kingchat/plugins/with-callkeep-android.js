const { withAndroidManifest, AndroidConfig, withMainApplication } = require("@expo/config-plugins");

module.exports = function withCallKeepAndroidPermissions(config) {
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    const permissions = [
      "android.permission.USE_FULL_SCREEN_INTENT",
      "android.permission.MANAGE_OWN_CALLS",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_PHONE_CALL",
      "android.permission.FOREGROUND_SERVICE_MICROPHONE"
    ];
    for (const permission of permissions) {
      if (!manifest["uses-permission"].some((entry) => entry.$?.["android:name"] === permission)) {
        manifest["uses-permission"].push({ $: { "android:name": permission } });
      }
    }

    // Keep the CallKeep phone-call foreground service correctly typed. The
    // full-screen special-access toggle is enabled directly by the user in Settings.
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    const connectionService = (application.service || []).find(
      (service) => service.$?.["android:name"] === "io.wazo.callkeep.VoiceConnectionService"
    );
    if (connectionService) {
      connectionService.$["android:foregroundServiceType"] = "phoneCall|microphone";
    }
    return config;
  });

  // LiveKit must initialize its Android audio/WebRTC runtime before React Native
  // starts. The Expo package plugin configures its manifest, but does not add this
  // Application.onCreate() initialization to the generated MainApplication.
  config = withMainApplication(config, (config) => {
    let contents = config.modResults.contents;
    const setupLine = "LiveKitReactNative.setup(this, AudioType.CommunicationAudioType())";

    if (!contents.includes(setupLine)) {
      const packageLine = contents.match(/^package [^\n]+$/m);
      if (!packageLine) {
        throw new Error("Guftin could not identify the Kotlin package line in MainApplication.kt.");
      }
      if (!contents.includes("import com.livekit.reactnative.LiveKitReactNative")) {
        contents = contents.replace(
          packageLine[0],
          packageLine[0] + "\n\nimport com.livekit.reactnative.LiveKitReactNative\nimport com.livekit.reactnative.audio.AudioType"
        );
      }

      const onCreateAnchor = "override fun onCreate() {";
      const superCall = "super.onCreate()";
      const onCreateIndex = contents.indexOf(onCreateAnchor);
      const superIndex = onCreateIndex >= 0 ? contents.indexOf(superCall, onCreateIndex) : -1;
      if (onCreateIndex < 0 || superIndex < 0) {
        throw new Error("Guftin could not safely insert LiveKit setup into MainApplication.onCreate().");
      }
      const insertionPoint = superIndex + superCall.length;
      contents = contents.slice(0, insertionPoint) + "\n    " + setupLine + contents.slice(insertionPoint);
    }

    config.modResults.contents = contents;
    return config;
  });

  return config;
};
