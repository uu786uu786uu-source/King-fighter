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
      const application = mod.modResults.manifest.application?.[0];
      if (!application) {
        throw new Error("Guftin AdMob plugin could not find the Android application manifest.");
      }
      application["meta-data"] = application["meta-data"] || [];
      const name = "com.google.android.gms.ads.APPLICATION_ID";
      const existing = application["meta-data"].find((entry) => entry.$?.["android:name"] === name);
      if (existing) {
        existing.$["android:value"] = androidAppId;
      } else {
        application["meta-data"].push({
          $: { "android:name": name, "android:value": androidAppId },
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

module.exports = createRunOncePlugin(withAdMobAppIds, "with-admob-app-ids", "1.0.0");
