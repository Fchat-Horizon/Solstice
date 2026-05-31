#!/usr/bin/env node
// Called by release-it after bumping the root package.json (and usable
// standalone). Keeps the other version-bearing files in sync with the root:
//   - electron/package.json  -> same version string
//   - mobile/android/app/build.gradle -> versionName + incremented versionCode
const fs = require('fs');
const version = process.argv[2];
if (!version) throw new Error('Usage: sync-electron-version.js <version>');

// electron/package.json
const electronPath = 'electron/package.json';
const pkg = JSON.parse(fs.readFileSync(electronPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(electronPath, JSON.stringify(pkg, null, 2) + '\n');

// Android: set versionName and bump versionCode (must increase for the OS to
// recognise a sideloaded APK as an update).
const gradlePath = 'mobile/android/app/build.gradle';
let gradle = fs.readFileSync(gradlePath, 'utf8');
if (!/versionName\s+"[^"]*"/.test(gradle) || !/versionCode\s+\d+/.test(gradle))
  throw new Error(`Could not find versionName/versionCode in ${gradlePath}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
gradle = gradle.replace(
  /versionCode\s+(\d+)/,
  (_, code) => `versionCode ${parseInt(code, 10) + 1}`
);
fs.writeFileSync(gradlePath, gradle);
