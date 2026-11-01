const path = require("node:path");

module.exports = ({ config }) => ({
  ...config,
  name: "Guftin",
  slug: "guftin",
  version: "1.1.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  // Keep the registered callback scheme so Google/email auth redirects keep working.
  scheme: "kingchat",
  icon: "./assets/guftin-icon.png",
  android: {
    ...config.android,
    package: "com.guftin.app",
    versionCode: 2,
    adaptiveIcon: {
      foregroundImage: "./assets/guftin-icon.png",
      backgroundColor: "#031522"
    },
    permissions: [
      ...(config.android?.permissions || []),
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.VIBRATE"
    ]
  },
  ios: {
    ...config.ios,
    bundleIdentifier: "com.guftin.app",
    buildNumber: "2",
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
