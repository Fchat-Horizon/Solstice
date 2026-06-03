# Contributing to Solstice

Before we begin, I'd like to thank you for taking interest in contributing! Solstice is a small-time side hobby, so any help is greatly appreciated.

Solstice is the **mobile (Android) fork of [Horizon](https://github.com/Fchat-Horizon/Horizon)**, itself a continuation of F-Chat Rising. It is a deliberately _light_ fork: we track Horizon closely and pull its changes in regularly. We generally **merge what works, fix what breaks.** Please keep this in mind when contributing, see [Working with upstream](#working-with-upstream) below.

## Table of Contents <!-- omit in toc -->

- [Contributing to Solstice](#contributing-to-solstice)
  - [Contributor License Agreement](#contributor-license-agreement)
  - [Where do I start?!](#where-do-i-start)
    - [Technology](#technology)
    - [Setting up your development enviroment](#setting-up-your-development-enviroment)
      - [Nix](#nix)
    - [Building](#building)
      - [Mobile (Android)](#mobile-android)
      - [Electron (shared upstream code)](#electron-shared-upstream-code)
  - [Working with upstream](#working-with-upstream)
    - [Mobile divergences from Horizon](#mobile-divergences-from-horizon)
  - [Project layout](#project-layout)
    - [Branches](#branches)
    - [Tags](#tags)
  - [Style guidelines](#style-guidelines)

## Contributor License Agreement

By submitting a pull request or contributing to this project (including translations via Weblate), you agree to the terms of our [Contributor License Agreement](./CLA.md).

In short: you keep ownership of your code, but you grant the project lead the right to license contributions under MPL-2.0 and to provide them to Dragonfruit under MIT.

## Where do I start?!

You wish to add a new feature to Solstice, or fix that one bug that's been pissing you off for months? Then this guide'll give you the rundown.

### Technology

Solstice is written primarily in _Vue_, _Typescript_, and _Javascript_, wrapped in a native Android WebView. You'll need **[Node.js](https://nodejs.org/en/download)** (v24+) and **[PNPM](https://pnpm.io/installation)**. A node version manager such as **[NVM](https://github.com/nvm-sh/nvm)** or fnm is recommended. You might also want to use VSCode to integrate with prettier.

For Android builds you'll additionally need **JDK 17+** and the **Android SDK** (API 35 platform). [Android Studio](https://developer.android.com/studio) is the easiest way to get the SDK.

### Setting up your development enviroment

In short, you can run the following commands:

```sh
git clone https://github.com/Fchat-Horizon/Solstice.git
cd Solstice
pnpm install
```

#### Nix

If you're using [Nix](https://nixos.org/)— whether as a package manager or as part of NixOS, a flake has been provided so you don't need to install any NodeJS dependencies yourself. Simply run the following command from the project root:

```bash
nix develop
```

Note that as of writing, the package `sass-embedded` is still required and doesn't directly work inside the Nix shell (because it's its own distributed binary). The Nix flake comes with its own patcher method that solves this, though you do need to run it every time you reinstall the PNPM packages:

```bash
pnpm install
patch_sass_embed
```

### Building

#### Mobile (Android)

This is the primary build. Compile the web assets (they're emitted to `mobile/www/`):

```sh
pnpm run build:mobile:dist
```

Then build the Android APK (Gradle copies the web assets automatically):

```sh
cd mobile/android
./gradlew assembleDebug
```

The APK will be at `mobile/android/app/build/outputs/apk/debug/app-debug.apk`. For a release build use `./gradlew assembleRelease` (you'll need to configure signing in `app/build.gradle`). Alternatively, open `mobile/android/` in Android Studio and build from there.

For an iterative workflow, `pnpm run watch:mobile` rebuilds the web assets on change.

#### Electron (shared upstream code)

Solstice keeps Horizon's `/electron` desktop code in-tree so that upstream merges remian simple. The mobile build strips it out via webpack shims (see [Mobile divergences](#mobile-divergences-from-horizon)). You generally don't need to build the desktop app, but it can be useful for testing shared chat/UI code:

```sh
pnpm build       # builds the solstice-electron workspace
pnpm start
```

This repo is a pnpm workspace, so you can target subprojects with filters, e.g. `pnpm --filter solstice-electron build` or `pnpm --filter solstice-mobile build`.

## Working with upstream

Solstice is a soft fork. The golden rule: **avoid editing upstream-tracked code unless you have to.** Every change to a file that Horizon also maintains becomes a merge conflict the next time we pull upstream.

- **Free to edit** (Solstice-owned, no merge cost): `mobile/`, `.github/` templates and workflows, `scripts/`, `bump_version.sh`, and root `package.json` metadata.
- **Avoid editing** (merge-tracked from Horizon): `chat/`, `electron/`, `learn/`, `scss/`, `fchat/`, `bbcode/`, `components/`, `site/`, `assets/`.

When a mobile fix genuinely requires touching shared code, keep the change as small and surgical as possible so future merges resolve cleanly.

### Mobile divergences from Horizon

Solstice deliberately diverges from Horizon in only a handful of places. If you're new to the project, these are the important ones to understand:

- **Settings entry point**: On mobile there is no top menu bar, so the desktop Settings window is unreachable. `mobile/AppSettingsDialog.vue` mounts the desktop `Settings.vue` inside a modal overlay to give mobile users a way in.
- **Trimmed EIcon category buttons**: The EIcon viewer's category buttons are trimmed down so the search bar fits on a phone screen (see commit `606917b7`).
- **Desktop-code stripping**: `mobile/webpack.config.js` aliases Electron/desktop-only modules (`electron`, `electron-log`, `@electron/remote`, `archiver`, `electron/filesystem`, `learn/store/worker`) to no-op shims in `mobile/shims/`, and disables Node `fs`/`tls`/`net` fallbacks. This is what lets the shared `chat/`, `learn/`, and `electron/` code bundle for mobile without an Electron runtime, and it's why we can keep `/electron` in-tree without it bloating the mobile build.

## Project layout

### Branches

- **main**: Production-ready. All stable releases are tagged here.
- **beta**: The 'semi-stable' branch. Development is merged into beta when stable enough for a pre-release.
- **development**: The main integration branch. New features and fixes are first merged here.
- **feature/\***: For new features, branch off `development` and open a PR back into it.
- **hotfix/\***: For urgent production fixes, branch off `main`, then merge back into both `main` and `development`.

### Tags

We follow a [semantic versioning](https://semver.org) format:

- **vX.Y.Z**: A production-ready release. For example: `v1.0.0`
- **vX.Y.Z-DEV-X.Y**: Early, often unstable releases. Doesn't leave the development branch.
- **vX.Y.Z-BETA-X.Y**: A pre-release version intended for testing before the final release.
- **vX.Y.Z-rc-X.Y**: A release candidate. Near-final; no new features should be added to RCs.

## Style guidelines

We use [Prettier](https://prettier.io/) to enforce a consistent coding style. Please follow these guidelines:

1. **Formatting**
   - Run `pnpm run lint` (or use the lint-staged integration) before committing. This ensures all code is consistent with [.prettierrc](./.prettierrc).
   - Use 2 spaces for indentation.
   - Keep a maximum line length of 80 characters.
   - Declare strings with single quotes (') instead of double quotes (").

2. **Structure & Syntax**
   - Always include semicolons.
   - Use trailing commas sparingly (only where allowed by Prettier).
   - For arrow functions with one parameter, avoid parentheses (e.g., `param => ...`).

3. **Vue Components**
   - Ensure `<script>` and `<style>` in `.vue` files are properly indented.
   - Follow the [Vue style guide](https://v2.vuejs.org/v2/style-guide) to the best of your ability.

A important part of Solstice is a strict code quality standard. Prettier should do most of the work for you.
