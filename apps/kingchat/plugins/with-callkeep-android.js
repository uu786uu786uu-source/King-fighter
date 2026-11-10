const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, AndroidConfig, withMainApplication, withDangerousMod } = require("@expo/config-plugins");

module.exports = function withCallKeepAndroidPermissions(config) {
  config = withAndroidManifest(config, (config) => {
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

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    const connectionService = (application.service || []).find(
      (service) => service.$?.["android:name"] === "io.wazo.callkeep.VoiceConnectionService"
    );
    if (connectionService) {
      connectionService.$["android:foregroundServiceType"] = "phoneCall|microphone";
    }
    return config;
  });

  // Register a tiny native bridge so the setup wizard can verify Android 14+
  // full-screen-intent access with NotificationManager.canUseFullScreenIntent().
  config = withMainApplication(config, (config) => {
    const marker = "add(GuftinCallPermissionsPackage())";
    if (!config.modResults.contents.includes(marker)) {
      const anchor = "PackageList(this).packages.apply {";
      if (!config.modResults.contents.includes(anchor)) {
        throw new Error("GuftinCallPermissionsPackage could not be registered: MainApplication.kt template changed.");
      }
      config.modResults.contents = config.modResults.contents.replace(
        anchor,
        anchor + "\n        " + marker
      );
    }
    return config;
  });

  config = withDangerousMod(config, ["android", async (config) => {
    const packageName = config.android?.package || "com.guftin.app";
    const packagePath = packageName.split(".").join(path.sep);
    const sourceDirectory = path.join(
      config.modRequest.platformProjectRoot,
      "app", "src", "main", "java", packagePath
    );
    fs.mkdirSync(sourceDirectory, { recursive: true });
    const sourcePath = path.join(sourceDirectory, "GuftinCallPermissionsModule.kt");
    const source = `package ${packageName}

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

class GuftinCallPermissionsModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "GuftinCallPermissions"

  @ReactMethod
  fun canUseFullScreenIntent(promise: Promise) {
    try {
      val allowed = if (Build.VERSION.SDK_INT < 34) {
        true
      } else {
        val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.canUseFullScreenIntent()
      }
      promise.resolve(allowed)
    } catch (error: Exception) {
      promise.reject("E_FULL_SCREEN_PERMISSION_CHECK", "Could not check full-screen call permission.", error)
    }
  }
}

class GuftinCallPermissionsPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(GuftinCallPermissionsModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;
    fs.writeFileSync(sourcePath, source, "utf8");
    return config;
  }]);

  return config;
};
