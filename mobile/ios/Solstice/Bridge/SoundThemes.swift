import Foundation
import UserNotifications

// Resolves sounds for the current sound theme (audiopack). Themes are bundled at
// www/sound-themes/<theme>/sounds/<name>.<ext> (mobile/webpack.config.js); the JS layer sets the
// current theme via the NativeNotification `setSoundTheme` bridge.
//
// Two consumers: NativeNotification plays the foreground/in-app sound with AVAudioPlayer
// (`playerURL`), and NativeSocket uses `notificationSound` for the background local notification.
// Background notifications need the sound as a UNNotificationSound, which only resolves wav/caf/aiff
// from the app's Library/Sounds, so on each theme change we copy the theme's notification wav there.
enum SoundThemes {
    private(set) static var current = "default"
    private static var hasCopied = false

    // Sounds that can fire a *background* notification (currently just the PM/highlight sound).
    private static let notificationSounds = ["attention"]

    static func setTheme(_ name: String) {
        let name = name.isEmpty ? "default" : name
        // Always copy on the first call so even the default theme's sound is used in the background.
        guard name != current || !hasCopied else { return }
        current = name
        hasCopied = true
        copyNotificationSounds()
    }

    // AVAudioPlayer source for a foreground sound: themed wav, then themed mp3, then the default
    // theme, then the legacy www/sounds default. (AVAudioPlayer does not decode ogg/flac.)
    static func playerURL(for sound: String) -> URL? {
        for theme in [current, "default"] {
            for ext in ["wav", "mp3"] {
                if let url = Bundle.main.url(
                    forResource: sound, withExtension: ext,
                    subdirectory: "www/sound-themes/\(theme)/sounds")
                {
                    return url
                }
            }
        }
        return Bundle.main.url(forResource: sound, withExtension: "mp3", subdirectory: "www/sounds")
    }

    // The notification sound for a background local notification: the wav copied into Library/Sounds
    // for the current theme, else the system default. (UNNotificationSound respects the ring switch.)
    static func notificationSound(for sound: String) -> UNNotificationSound {
        let fileName = "solstice-\(sound).wav"
        if FileManager.default.fileExists(atPath: librarySoundsDir.appendingPathComponent(fileName).path) {
            return UNNotificationSound(named: UNNotificationSoundName(fileName))
        }
        return .default
    }

    private static var librarySoundsDir: URL {
        let dir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Sounds", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func copyNotificationSounds() {
        let fm = FileManager.default
        let dir = librarySoundsDir
        for sound in notificationSounds {
            let dest = dir.appendingPathComponent("solstice-\(sound).wav")
            try? fm.removeItem(at: dest)
            // Prefer the current theme's wav; fall back to the default theme's wav.
            let src = Bundle.main.url(
                forResource: sound, withExtension: "wav",
                subdirectory: "www/sound-themes/\(current)/sounds")
                ?? Bundle.main.url(
                    forResource: sound, withExtension: "wav",
                    subdirectory: "www/sound-themes/default/sounds")
            if let src = src { try? fm.copyItem(at: src, to: dest) }
        }
    }
}
