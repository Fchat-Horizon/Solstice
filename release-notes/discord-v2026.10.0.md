**Solstice v2026.10.0 is out**

Built on Horizon 2.4.0. The app can now pull your chat log history off Horizon on your computer, log exports work on both platforms, and a large import no longer freezes the app.

What changed since 2026.6.4:

- **Log syncing with Horizon.** Copy your chat log history onto your phone over your local network. In Horizon, open "Manage Data" and choose "Sync with Solstice", then scan the pairing QR code in the app. The transfer runs directly between the two devices and your existing logs are merged, not overwritten. Needs Horizon 2.4.0 or later.
- **Syncing copes with big log folders.** Logs transfer one bounded batch at a time, so neither device holds the whole log set in memory and folders that were too big to sync now go through.
- **Exporting chat logs works.** It did nothing on iOS and only partly worked on Android. Exports now save through the app: Android drops the file into Downloads, iOS hands it to the share sheet.
- **A large import no longer freezes the app.** Importing a desktop backup locked everything up until it finished, 85 seconds for a 296 MB one. It now runs in small batches and stays responsive, and one that fails writes a trace you can hand over.
- **Manage Data survives signing out (#17).** Its tabs no longer freeze and its dialogs open again after logging out and back in.
- **iOS builds against the current SDK (#20).** Rebuilt for the iOS 26 and Xcode 27 SDK. iOS 15 is the minimum supported version.
- **Two iOS install channels.** The public SideStore source always points at the newest release; the rolling test channel lists itself separately as "Solstice (Test)".
- **Everything from Horizon 2.4.0.** Localized dates and plurals, avatars in the character pickers, friend requests showing as pending, the ad and smart filter fixes, channels staying grouped, and accessibility fixes. Full list in the release notes.

https://github.com/Fchat-Horizon/Solstice/releases/latest
