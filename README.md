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

This repository contains a continuation of the heavily customized F-Chat Rising, a version of the mainline F-Chat 3.0 client, packaged as a native Android application (with an experimental iOS build installable via SideStore).

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
> The iOS build is **experimental** and currently distributed as a **private test build** —
> it wraps the same web app in a `WKWebView` and mirrors the Android native bridges in Swift
> (`mobile/ios/`). The `.ipa` is ad-hoc signed in CI; [SideStore](https://sidestore.io/)
> re-signs it on-device with your own Apple ID, so no paid Apple Developer account is required.

### Installing via SideStore

The IPA is **not published publicly**. It is built by CI and uploaded as a private workflow
artifact (downloadable by repo collaborators).

1. Download the latest test build (requires repo access):

   ```bash
   gh run download -R Fchat-Horizon/Solstice -n Solstice-ios-unsigned
   ```

   (or from the **Actions → Build iOS** run page → Artifacts).

2. Install it with a **standalone** [SideStore](https://sidestore.io/) (or AltStore):
   **My Apps → + → pick `Solstice-<version>.ipa`**. SideStore re-signs it and refreshes the
   7-day signature automatically.

> [!IMPORTANT]
> Use a _standalone_ SideStore, **not** the SideStore bundled inside LiveContainer — the
> embedded one crashes in its local-install path. (Running the IPA as a LiveContainer guest
> also works.)
>
> `mobile/ios/sidestore-source.json` is a template for future public source-based
> distribution; it is intentionally not published while the build is private.

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

iOS is more restrictive than Android; on this build:

- **Background connectivity uses a silent-audio keep-alive.** iOS has no equivalent to
  Android's foreground service, so while connected the app plays an inaudible looping audio
  stream (the `audio` background mode) to stay running in the background and keep the
  WebSocket alive. It mixes with other audio, so it won't stop your music. iOS can still
  reclaim the app under memory pressure, and battery use is higher than a fully-suspended app.
- **No remote/push notifications.** Only local notifications are used (which the app
  generates itself) — this is also what keeps it installable under SideStore free signing.
- **SideStore constraints apply.** Free Apple IDs limit you to a few sideloaded apps and a
  7-day signature that SideStore must refresh periodically.

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
