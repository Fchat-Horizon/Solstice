# Table of Contents <!-- omit in toc -->

- [Disclaimer](#disclaimer)
- [Solstice](#solstice)
  - [Features](#features)
- [Installing](#installing)
  - [Android](#android)
    - [Prerequisites](#prerequisites)
    - [Building](#building)
  - [iOS (SideStore)](#ios-sidestore)
    - [Installing via SideStore](#installing-via-sidestore)
    - [Building from source (macOS)](#building-from-source-macos)
    - [iOS limitations](#ios-limitations)
- [Usage](#usage)
  - [Getting started](#getting-started)
- [Development](#development)
- [Credits](#credits)
  - [Translation](#translation)

# Disclaimer

> [!WARNING]
> **Solstice is an independent fork of [Horizon](https://github.com/Fchat-Horizon/Horizon), created with their blessing.**
>
> The Horizon project and its maintainers are **not responsible** for Solstice in any way. This includes, but is not limited to: bugs, crashes, data loss, security issues, behaviour differences, or anything else that may arise from using this software. Any issues you encounter should be reported here, **not** to the Horizon project.
>
> If you are looking for the original Horizon client for Windows, macOS, or Linux, please visit the [Horizon repository](https://github.com/Fchat-Horizon/Horizon) directly.

# Solstice

Solstice is a mobile port of [F-Chat Horizon](https://github.com/Fchat-Horizon/Horizon), itself a heavily customized continuation of the mainline F-Chat 3.0 client. It runs on **Android and iOS**, wrapping the shared Horizon web app in a thin native host on each platform: a WebView-based Android app, and a `WKWebView` host on iOS with native Swift bridges.

## Features

In a non-exhaustive list, Solstice has these features!

- **Profile matching** automatically compares your profile with others to determine with whom you are compatible.
- **Automatic ad posting** repeatedly posts and rotates ads on selected channels.
- **Link previews** popup shows a preview of an image / video when you hover your mouse over a link.
- **Caching** speeds up profile loads and other actions.
- **Smart filters** let you choose what kind of ads and posts you see in the chat.

# Installing

## Android

Solstice is available as a native Android application that wraps the web app in a WebView.

### Prerequisites

- [Node.js](https://nodejs.org/) >= 24 and [pnpm](https://pnpm.io/)
- JDK 17+ (e.g. `sudo pacman -S jdk17-openjdk` / `sudo apt install openjdk-17-jdk`)
- [Android SDK](https://developer.android.com/studio) with API 35 platform installed  
  (Android Studio is the easiest way to get this)

### Building

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Compile the web assets (outputs to `mobile/www/`):

   ```bash
   pnpm run build:mobile:dist
   ```

3. Build the Android APK (Gradle will copy the web assets automatically):

   ```bash
   cd mobile/android
   ./gradlew assembleDebug
   ```

   The APK will be at `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

   For a release build, use `./gradlew assembleRelease` — you will need to configure signing in `app/build.gradle`.

   Alternatively, open `mobile/android/` in Android Studio and build from there.

## iOS (SideStore)

> [!NOTE]
> The iOS build is newer than Android and still best-effort, but it is publicly available. It
> wraps the same web app in a `WKWebView` with native Swift bridges (`mobile/ios/`), and runs the
> F-List connection on a native WebSocket so it stays connected and delivers notifications while
> backgrounded. The `.ipa` is ad-hoc signed in CI; [SideStore](https://sidestore.io/) re-signs it
> on-device with your own Apple ID, so no paid Apple Developer account is required.

### Installing via SideStore

Solstice for iOS is publicly available through two channels:

- **SideStore source (recommended)** gives one-tap install and automatic updates. On your iPhone
  with [SideStore](https://sidestore.io/) installed, tap the button to add the source, then tap
  Install/Update:

  [![Add to SideStore](https://img.shields.io/badge/Add%20to-SideStore-7B68EE?style=for-the-badge)](https://celloserenity.github.io/altdirect/?url=https://github.com/Fchat-Horizon/Solstice/releases/download/ios-latest/sidestore-source.json&r=sidestore)

  Or add this URL manually as a Source (GitHub strips the `sidestore://` scheme, so the button
  routes through the [altdirect](https://github.com/CelloSerenity/altdirect) redirect):

  ```
  https://github.com/Fchat-Horizon/Solstice/releases/download/ios-latest/sidestore-source.json
  ```

  The source tracks a **rolling pre-release** (tag `ios-latest`) rebuilt on each tagged
  release, so it always points at the latest released build.

- **Release IPA** if you prefer a tagged build: every
  [release](https://github.com/Fchat-Horizon/Solstice/releases) attaches a `Solstice-<version>.ipa`
  next to the Android APK. Download it on your iPhone and choose **Open in SideStore** (or **Open
  in LiveContainer**). The rolling test build is downloadable the same way:

  ```
  https://github.com/Fchat-Horizon/Solstice/releases/download/ios-latest/Solstice.ipa
  ```

SideStore/LiveContainer re-signs the app on-device with your Apple ID (no paid account needed)
and refreshes the 7-day signature automatically.

> [!IMPORTANT]
> **Background features (staying connected and notifications) need a _standalone_ SideStore
> install, not LiveContainer.** LiveContainer does not honor the background-audio entitlement the
> keep-alive relies on, and the SideStore bundled inside LiveContainer also crashes in its
> local-install path. Install with standalone SideStore for the full experience.

### Building from source (macOS)

iOS binaries can only be produced on **macOS with Xcode**. CI does this automatically
(`.github/workflows/ios.yml`, on a macOS runner), but to build locally:

1. Install tooling: Xcode 15+, [XcodeGen](https://github.com/yonaskolb/XcodeGen)
   (`brew install xcodegen`), Node.js ≥ 24 and pnpm.
2. Compile the web assets (this **must** run before generating the Xcode project — the
   project includes `mobile/www` as a folder reference):

   ```bash
   pnpm install
   pnpm run build:mobile:dist
   ```

3. Generate the Xcode project and build an unsigned `.ipa`:

   ```bash
   cd mobile/ios
   xcodegen generate
   xcodebuild -project Solstice.xcodeproj -scheme Solstice -configuration Release \
     -sdk iphoneos -derivedDataPath build \
     CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO clean build
   mkdir -p Payload && cp -R build/Build/Products/Release-iphoneos/Solstice.app Payload/
   zip -qry Solstice.ipa Payload
   ```

   Or open `Solstice.xcodeproj` in Xcode after `xcodegen generate` and run on a device/simulator.

### iOS limitations

iOS is more restrictive than Android, so a few things work differently:

- **Background connectivity is native and best-effort.** The F-List socket runs natively, because
  iOS suspends the WebView's process in the background and the socket cannot live there. A
  silent-audio keep-alive (the `audio` background mode) keeps the app process alive so it can
  answer F-List's keepalive. This keeps you connected with the app backgrounded, though iOS can
  still terminate it under memory pressure. It only works on a **standalone** SideStore install,
  not LiveContainer, which ignores the audio entitlement.
- **Notifications are local, not push.** There is no remote/APNs push, which is also what keeps
  the app installable under free signing. The app posts local notifications itself, including in
  the background: the native socket inspects incoming private messages and mentions and notifies
  you directly, with the sender's avatar and the room name.
- **SideStore constraints apply.** Free Apple IDs limit you to a few sideloaded apps and a 7-day
  signature that SideStore refreshes periodically.

# Usage

## Getting started

When you first load Solstice, you'll notice its interface is closely similar to the original F-Chat client. The settings menu contains additional options, including the **Solstice** tab for general settings and the **Smart Filters** tab for configuring content filters.

# Development

Please read [CONTRIBUTING.md](./CONTRIBUTING.md)

# Credits

## Translation

<!--Sort contributors alphabetically if you add more, please 🐟.-->

- **French**: Azthenor, Fragile, Xav
- **German**: Froggy, Peel
- **Hungarian**: Firespark
- **Italian**: Clovermoth
- **Spanish**: A Day with a Carrot, Dess, DannyIW
- **UWUnglish** (we're so sorry): @CodingWithAnxiety, @FatCatClient
