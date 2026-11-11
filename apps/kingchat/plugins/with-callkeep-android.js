const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

module.exports = function withCallKeepAndroidPermissions(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    const permissions = [
      "android.permission.USE_FULL_SCREEN_INTENT",
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
};

