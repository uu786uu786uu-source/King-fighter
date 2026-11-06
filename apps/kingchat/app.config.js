const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const assetsDirectory = path.join(__dirname, "assets");
const svgIcon = path.join(assetsDirectory, "guftin-icon.svg");
const pngIcon = path.join(assetsDirectory, "guftin-icon.png");

// Expo resolves app.config.js synchronously. Create the PNG before returning the
// config so EAS, Android prebuild and iOS prebuild all see a real image asset.
const pngIsMissing = !fs.existsSync(pngIcon);
const svgIsNewer = !pngIsMissing &&
  fs.statSync(svgIcon).mtimeMs > fs.statSync(pngIcon).mtimeMs;
if (pngIsMissing || svgIsNewer) {
  const generated = spawnSync(process.execPath, [path.join(__dirname, "scripts", "prepare-assets.js")], {
    cwd: __dirname,
    stdio: "inherit"
  });
  if (generated.status !== 0) {
    throw new Error("Guftin icon generation failed before Expo config resolution.");
  }
}


module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...(config.extra || {}),
    eas: {
      ...(config.extra?.eas || {}),
      ...(process.env.EXPO_PUBLIC_EAS_PROJECT_ID ? { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID } : {})
    }
  },
  name: "Guftin",
  slug: "guftin",
  version: "1.4.7",
  orientation: "portrait",
  userInterfaceStyle: "light",
  // Keep the app deep-link scheme for Guftin links and email auth callbacks.
  scheme: "kingchat",
  icon: "./assets/guftin-icon.png",
  android: {
    ...config.android,
    package: "com.guftin.app",
    versionCode: 12,
    // Explicitly register the Supabase OAuth return URL on Android. The broad
    // scheme registration remains in place for other Guftin deep links.
    intentFilters: [
      ...(config.android?.intentFilters || []),
      {
        action: "VIEW",
        autoVerify: false,
        data: [{ scheme: "kingchat", host: "auth", pathPrefix: "/callback" }],
        category: ["BROWSABLE", "DEFAULT"]
      }
    ],
    adaptiveIcon: {
      foregroundImage: "./assets/guftin-icon.png",
      backgroundColor: "#031522"
    },
    permissions: [
      ...(config.android?.permissions || []),
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.VIBRATE",
      "android.permission.POST_NOTIFICATIONS"
    ]
  },
  ios: {
    ...config.ios,
    bundleIdentifier: "com.guftin.app",
    buildNumber: "12",
    icon: "./assets/guftin-icon.png",
    supportsTablet: true,
    infoPlist: {
      ...config.ios?.infoPlist,
      NSCameraUsageDescription: "Guftin uses the camera for photos and video calls.",
      NSMicrophoneUsageDescription: "Guftin uses the microphone for voice messages and calls.",
      NSPhotoLibraryUsageDescription: "Guftin accesses your photo library when you choose media to share.",
      NSPhotoLibraryAddUsageDescription: "Guftin can save media you choose to your photo library."
    }
  },
  plugins: [
    ...(config.plugins || []),
    [
      "expo-media-library",
      {
        photosPermission: "Allow Guftin to save photos and videos you choose.",
        savePhotosPermission: "Allow Guftin to save shared media to your gallery."
      }
    ],
    [
      "expo-notifications",
      {
        color: "#087e6c",
        defaultChannel: "messages",
        enableBackgroundRemoteNotifications: true
      }
    ],
    [
      "./plugins/with-admob-app-ids",
      {
        "androidAppId": process.env.ADMOB_ANDROID_APP_ID || "ca-app-pub-3116820002792089~9836244876",
        "iosAppId": process.env.ADMOB_IOS_APP_ID || "ca-app-pub-3940256099942544~1458002511"
      }
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/guftin-icon.png",
        imageWidth: 190,
        resizeMode: "contain",
        backgroundColor: "#031522"
      }
    ]
  ]
});
