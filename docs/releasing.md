# Cutting a Solstice release

`VERSIONING.md` describes Horizon's release process (semver, `beta`/`main` branches, nightly
canaries). Solstice's is different, and this file is the one to follow here.

## What is different from Horizon

- **CalVer, not semver**: `YYYY.M.PATCH`, where `M` is the month the line was cut. Patches continue
  into later months, so a line cut in September stays `2026.9.x` in October. A new line uses the
  month it is cut in.
- **One branch**: everything releases from `development`. There is no `beta` or `main` to merge
  forward into.
- **No `CHANGELOG.md` entry**: that file tracks Horizon versions and is inherited, so Solstice's
  changelog is the GitHub _release notes_. Nothing in the release process touches it.
- **The tag is the trigger.** Pushing `v*` starts `build.yml` (signed Android APKs) and `ios.yml`
  (the IPA plus, for a stable, the public SideStore source manifest). Both attach their assets to a
  **draft** release that you publish by hand once the assets look right.
- **Two remotes**: `origin` (Fchat-Horizon/Solstice) and `fork` (Kannamoris/Solstice) are kept in
  sync, and testers install from the fork.

## The release

```bash
# 1. On development, up to date, clean tree.
pnpm release 2026.10.0        # the explicit version; release-it does not guess CalVer
```

That runs the local gate (`typecheck`, `test`, `i18n:check`, `check`) and refuses to go on if any of
it fails, then bumps the version everywhere, commits `chore: release v<version>`, tags it, and
pushes to both remotes.

Version-bearing files, all handled by `scripts/sync-electron-version.js` as part of the bump:
`package.json`, `electron/package.json`, `mobile/package.json`,
`mobile/android/app/build.gradle` (`versionName`, and `versionCode` incremented, which Android
requires for a sideloaded update to install over the old one) and `mobile/ios/project.yml`
(`MARKETING_VERSION`).

```bash
# 2. Scaffold the notes and write them.
pnpm release:notes:draft      # writes release-notes/v<version>.md
```

The scaffold has the `Built on Horizon X.Y.Z` line (read from `chat/version.ts`) and one `**TODO.**`
bullet per thing that landed since the last stable release. Rewrite every bullet in user-facing
words: a **bold** plain-language lead-in, then full sentences saying what changed for the person
using the app, no commit links. Write in the first person singular, because Solstice is
solo-maintained: "I", never "we". No install-directions section, the asset list on the release page
covers that. No em dashes.

```bash
# 3. Once CI has attached the APKs and the IPA to the draft release:
pnpm release:notes            # sets the release body, writes the Discord post
pnpm release:notes -- --dry-run   # same, without touching GitHub
```

This refuses to run while the notes still contain `TODO` or an em dash. It also writes
`release-notes/discord-v<version>.md`, the announcement post in the shape the Discord channel
expects, and warns when it is over Discord's 2000 character limit: trim it by hand, and a re-run
will keep your trimmed version rather than regenerate it.

```bash
# 4. Publish the draft when the assets look right.
gh release edit v2026.10.0 -R Fchat-Horizon/Solstice --draft=false
```

Publishing matters for more than visibility on iOS: the public SideStore source is
`releases/latest/download/sidestore-source.json`, which GitHub resolves to the newest _published_
non-prerelease release, so the stable channel only moves when you publish.

## Pre-releases

```bash
pnpm release 2026.10.0-dev.0
```

`build.yml` treats a tag containing `-dev.` or `-beta.` as a draft pre-release, and `ios.yml` also
refreshes the rolling `ios-latest` test channel from it. Release notes for a pre-release are worth
writing but are addressed to testers rather than users.

## If something goes wrong

- **The gate fails before anything is bumped.** Nothing has happened yet; fix and re-run.
- **It fails after the commit and tag but before the push.** `git reset --hard HEAD~1` and
  `git tag -d v<version>`, then re-run.
- **The tag is pushed but a build fails.** Fix forward: the draft release is just a container, so
  delete the draft, delete the tag on both remotes, and re-tag when the fix is in. Never re-point a
  tag that a published release used.
- **The fork push failed** (it runs after the origin push): `git push fork development --follow-tags`.
- **Dry run anything**: `pnpm release 2026.10.0 --dry-run` prints every command without running it.
