import UIKit
import WebKit
import AVFoundation
import UserNotifications

// Mirrors Notifications.kt. Uses *local* notifications (UNUserNotificationCenter) — no
// APNs/remote push, so it works under SideStore free provisioning. Sounds are played
// from the bundled www/sounds/<name>.mp3 just like the Android MediaPlayer path.
//
// Foreground presentation and notification taps are handled by WebViewController, which is
// the UNUserNotificationCenterDelegate (it owns the WebView needed to dispatch the
// `notification-clicked` event back into the web app).
final class NativeNotification: NSObject, WKScriptMessageHandlerWithReply, AVAudioPlayerDelegate {
    static let notificationIdentifier = "message"

    // AVAudioPlayer stops the moment it is deallocated, so keep players alive until they
    // finish (multiple notification sounds can briefly overlap).
    private var activePlayers: [AVAudioPlayer] = []

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let call = BridgeCall(message) else { return replyHandler(nil, "bad call") }
        switch call.method {
        case "playSound":
            playSound(call.string(0))
            replyHandler(nil, nil)
        case "setSoundTheme":
            SoundThemes.setTheme(call.string(0))
            replyHandler(nil, nil)
        case "requestPermission":
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
            replyHandler(nil, nil)
        case "notify":
            // notify(notify, title, text, icon, sound, data)
            let shouldNotify = call.bool(0)
            let title = call.string(1)
            let text = call.string(2)
            let icon = call.optionalString(3)
            let sound = call.optionalString(4)
            let data = call.optionalString(5) ?? ""
            notify(shouldNotify, title: title, text: text, icon: icon, sound: sound, data: data)
            replyHandler(nil, nil)
        default:
            replyHandler(nil, "unknown method \(call.method)")
        }
    }

    private func notify(_ shouldNotify: Bool, title: String, text: String,
                        icon: String?, sound: String?, data: String) {
        if let sound = sound { playSound(sound) }

        // Muted-conversation path: Android vibrates instead of posting a notification.
        if !shouldNotify {
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
            return
        }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = text
        content.userInfo = ["data": data]
        // One notification per conversation: the JS layer passes conversation.key as `data`, so reuse it
        // as the identifier (a new message replaces that conversation's banner instead of stacking) and
        // the thread id (Notification Center grouping). Fall back to a constant when no key is given.
        let key = data.isEmpty ? Self.notificationIdentifier : data
        content.threadIdentifier = key

        func submit(_ attachments: [UNNotificationAttachment]) {
            content.attachments = attachments
            let request = UNNotificationRequest(identifier: key, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
        }

        // Download the large icon (avatar) as an attachment, mirroring the Android AsyncTask.
        guard let icon = icon, let url = URL(string: icon) else { return submit([]) }
        URLSession.shared.dataTask(with: url) { dataIn, response, _ in
            var attachments: [UNNotificationAttachment] = []
            if let dataIn = dataIn {
                let ext = (response?.mimeType == "image/png") ? "png" : "jpg"
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("notif-icon-\(UUID().uuidString).\(ext)")
                if (try? dataIn.write(to: tmp)) != nil,
                   let attachment = try? UNNotificationAttachment(identifier: "icon", url: tmp) {
                    attachments.append(attachment)
                }
            }
            DispatchQueue.main.async { submit(attachments) }
        }.resume()
    }

    private func playSound(_ name: String) {
        guard let url = SoundThemes.playerURL(for: name) else { return }
        do {
            // .playback so notification sounds are audible even with the ring switch on
            // silent — matching the Android USAGE_MEDIA stream.
            try AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            let player = try AVAudioPlayer(contentsOf: url)
            player.delegate = self
            activePlayers.append(player)
            player.play()
        } catch {
            // Missing file or playback error — silently ignore, as Android does.
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        activePlayers.removeAll { $0 === player }
    }
}
