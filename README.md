# Table of Contents <!-- omit in toc -->

- [Disclaimer](#disclaimer)
- [Solstice](#solstice)
  - [Features](#features)
- [Installing](#installing)
  - [Android](#android)
    - [Prerequisites](#prerequisites)
    - [Building](#building)
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

This repository contains a continuation of the heavily customized F-Chat Rising, a version of the mainline F-Chat 3.0 client, packaged as a native Android application.

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
