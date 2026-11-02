const {
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
} = require("@expo/config-plugins");

function withAdMobAppIds(config, options = {}) {
  const androidAppId = options.androidAppId;
  const iosAppId = options.iosAppId;

  if (androidAppId) {
    config = withAndroidManifest(config, (mod) => {
      const manifest = mod.modResults.manifest;
      manifest.$ = manifest.$ || {};
      // The Google Mobile Ads library declares APPLICATION_ID with an empty
      // value. Mark our app-level value as the intentional override so the
      // Android manifest merger can combine both manifests in release builds.
      manifest.$["xmlns:tools"] =
        manifest.$["xmlns:tools"] || "http://schemas.android.com/tools";

      const application = manifest.application?.[0];
      if (!application) {
        throw new Error("Guftin AdMob plugin could not find the Android application manifest.");
      }
      application["meta-data"] = application["meta-data"] || [];
      const name = "com.google.android.gms.ads.APPLICATION_ID";
      const existing = application["meta-data"].find((entry) => entry.$?.["android:name"] === name);
      if (existing) {
        existing.$["android:value"] = androidAppId;
        existing.$["tools:replace"] = "android:value";
      } else {
        application["meta-data"].push({
          $: {
            "android:name": name,
            "android:value": androidAppId,
            "tools:replace": "android:value",
          },
        });
      }
      return mod;
    });
  }

  if (iosAppId) {
    config = withInfoPlist(config, (mod) => {
      mod.modResults.GADApplicationIdentifier = iosAppId;
      return mod;
    });
  }

  return config;
}

module.exports = createRunOncePlugin(withAdMobAppIds, "with-admob-app-ids", "1.0.1");
