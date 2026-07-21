import UIKit
import WebKit
import UserNotifications
import AudioToolbox

// Native WebSocket transport for iOS, used instead of the browser WebSocket (chat/WebSocket.ts).
//
// Why: the browser socket lives in WKWebView's WebContent process, which iOS suspends in the
// background even when the host app is kept awake by the audio background mode. Suspended JS can't
// answer F-List's PIN keepalive, so the connection drops. Running the socket here in the host
// process keeps it alive: we answer PIN natively, and buffer inbound frames while backgrounded so
// the WebView catches up on foreground. The JS side (mobile/NativeSocketConnection.ts) drives
// connect/send/close and receives events via window.__nativeSocketEvent, dispatched through the
// WebViewController's web view.
final class NativeSocket: NSObject, WKScriptMessageHandlerWithReply, URLSessionWebSocketDelegate {
    weak var host: WebViewController?

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var inBackground = false
    // Buffered frames carry the time they arrived, so the WebView can stamp them with their real
    // arrival time on replay instead of the (later) resume time.
    private var buffer: [(frame: String, timeMs: Int)] = []
    private var closeEmitted = false
    private static let bufferCap = 3000

    // Background-notify policy pushed from JS (mobile/notifyConfig.ts) on connect and whenever it
    // changes, so native can reproduce the foreground decision (chat/conversations.ts) while JS is
    // suspended. All names/terms are lowercased; highlight terms are pre-compiled into a word-boundary
    // regex matching the foreground `\b(...)\b` match.
    private struct ChannelCfg {
        let title: String                     // conversation.name, the room's display title
        let highlightRegex: NSRegularExpression?
        let watched: Set<String>              // per-channel + global watched/bookmarked characters
        let notifyAll: Bool                   // channel set to notify on every message
    }
    private var character = ""                // lowercased own character, for self-message exclusion
    private var ignored: Set<String> = []
    private var mutedPrivates: Set<String> = []
    private var globalHighlightRegex: NSRegularExpression?   // fallback for channels not in the map
    private var globalWatched: Set<String> = []
    private var channels: [String: ChannelCfg] = [:]

    // One notification per conversation (Discord-style): each conversation key maps to how many unread
    // messages its single notification represents. Drives the "(N)" title suffix and the app icon badge;
    // reset per conversation when the user opens it (clearConversation).
    private var unreadCounts: [String: Int] = [:]
    // Rate-limit the notification vibration so a busy notify-all channel can't buzz continuously.
    private var lastVibrateMs = 0

    override init() {
        super.init()
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(didBackground),
                       name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(willForeground),
                       name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let call = BridgeCall(message) else { return replyHandler(nil, "bad call") }
        switch call.method {
        case "connect": connect(call.string(0)); replyHandler(nil, nil)
        case "setNotifyConfig": applyNotifyConfig(call.string(0)); replyHandler(nil, nil)
        case "clearConversation": clearConversation(call.string(0)); replyHandler(nil, nil)
        case "send": task?.send(.string(call.string(0))) { _ in }; replyHandler(nil, nil)
        case "close":
            // Explicit close (e.g. logout): tear down and emit a clean close so the JS Connection's
            // onClose -> 'closed' lifecycle runs, matching the browser socket. The cancelled task's
            // own callback is suppressed by the stale-task guard, so this does not double-fire.
            closeSocket()
            closeEmitted = false
            emitClose(code: 1000, reason: "", clean: true)
            replyHandler(nil, nil)
        default: replyHandler(nil, "unknown method \(call.method)")
        }
    }

    private func connect(_ urlString: String) {
        closeSocket()
        guard let url = URL(string: urlString) else { return }
        closeEmitted = false
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        // Deliver all callbacks on the main queue so socket state (task/buffer/inBackground) and the
        // lifecycle handlers never race, and evaluateJavaScript is always main-thread.
        let session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        let task = session.webSocketTask(with: url)
        self.session = session
        self.task = task
        task.resume()
        receive()
    }

    private func receive() {
        guard let current = task else { return }
        current.receive { [weak self] result in
            // Ignore callbacks from a socket we have already replaced (reconnect/close).
            guard let self = self, self.task === current else { return }
            switch result {
            case .failure(let error):
                let detail = WebViewController.jsString(error.localizedDescription)
                self.emit("error", detail)
                self.emitClose(code: 1006, reason: "", clean: false)
            case .success(let message):
                let text: String
                switch message {
                case .string(let s): text = s
                case .data(let d): text = String(decoding: d, as: UTF8.self)
                @unknown default: text = ""
                }
                // Answer F-List's PIN keepalive natively so the connection survives while the
                // WebView is suspended. The JS Connection skips PIN when nativeKeepalive is set.
                if text == "PIN" { self.task?.send(.string("PIN")) { _ in } }
                self.deliver(text)
                self.receive()
            }
        }
    }

    // Main thread only, serialized with the lifecycle handlers below.
    private func deliver(_ text: String) {
        if inBackground {
            // JS is suspended, so it can't fire notifications. Inspect PMs/highlights natively and
            // post a local notification, then buffer the frame for the WebView to catch up on resume.
            notifyIfNeeded(text)
            buffer.append((text, Int(Date().timeIntervalSince1970 * 1000)))
            if buffer.count > Self.bufferCap {
                buffer.removeFirst(buffer.count - Self.bufferCap)
            }
        } else {
            emit("message", WebViewController.jsString(text))
        }
    }

    // Fire a local notification for an incoming PM (PRI) or a channel message (MSG) the user would be
    // notified for in the foreground, using the policy pushed via setNotifyConfig. F-List frames are
    // "<3-char command> <json>". (Smart filters run async profile lookups in JS and can't be
    // reproduced here, so they don't suppress background notifications.)
    private func notifyIfNeeded(_ frame: String) {
        guard frame.count > 4 else { return }
        let command = String(frame.prefix(3))
        guard command == "PRI" || command == "MSG" else { return }
        let jsonStart = frame.index(frame.startIndex, offsetBy: 4)
        guard let data = String(frame[jsonStart...]).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        let sender = (obj["character"] as? String) ?? ""
        let senderLow = sender.lowercased()
        if ignored.contains(senderLow) { return }
        let message = stripBBCode((obj["message"] as? String) ?? "")

        if command == "PRI" {
            if mutedPrivates.contains(senderLow) { return }
            postNotification(title: sender, body: message, key: sender, avatar: sender)
            return
        }

        // MSG: never notify for our own messages.
        if senderLow == character { return }
        let rawChannel = (obj["channel"] as? String) ?? ""
        let cfg = channels[rawChannel.lowercased()]
        let watched = cfg?.watched ?? globalWatched
        let regex = cfg?.highlightRegex ?? globalHighlightRegex
        let shouldNotify = (cfg?.notifyAll ?? false)
            || watched.contains(senderLow)
            || matches(message, regex)
        guard shouldNotify else { return }
        let title = cfg?.title ?? rawChannel
        // byKey resolves channels off channelMap, which is keyed by the raw channel id; "#" + the
        // frame's channel is exactly the lookup chat/conversations.ts uses, so a tap always routes.
        postNotification(title: "\(sender) in \(title)", body: message, key: "#\(rawChannel)", avatar: sender)
    }

    // Parse the background-notify config pushed from JS into the matcher state above.
    private func applyNotifyConfig(_ json: String) {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        character = (obj["character"] as? String ?? "").lowercased()
        ignored = lowerSet(obj["ignored"])
        mutedPrivates = lowerSet(obj["mutedPrivates"])
        globalHighlightRegex = highlightRegex(from: obj["globalHighlights"])
        globalWatched = lowerSet(obj["globalWatched"])
        var parsed: [String: ChannelCfg] = [:]
        if let chans = obj["channels"] as? [String: Any] {
            for (id, raw) in chans {
                guard let c = raw as? [String: Any] else { continue }
                parsed[id] = ChannelCfg(
                    title: c["title"] as? String ?? id,
                    highlightRegex: highlightRegex(from: c["highlights"]),
                    watched: lowerSet(c["watched"]),
                    notifyAll: c["notifyAll"] as? Bool ?? false)
            }
        }
        channels = parsed
    }

    private func lowerSet(_ value: Any?) -> Set<String> {
        return Set((value as? [String])?.map { $0.lowercased() } ?? [])
    }

    // Compile lowercased terms into a case-insensitive word-boundary regex, matching the foreground
    // `\b(term1|term2)\b` highlight match (chat/conversations.ts). nil when there are no terms.
    private func highlightRegex(from value: Any?) -> NSRegularExpression? {
        let terms = ((value as? [String]) ?? []).filter { !$0.isEmpty }
        guard !terms.isEmpty else { return nil }
        let escaped = terms.map { NSRegularExpression.escapedPattern(for: $0) }
        let pattern = "\\b(\(escaped.joined(separator: "|")))\\b"
        return try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }

    private func matches(_ text: String, _ regex: NSRegularExpression?) -> Bool {
        guard let regex = regex else { return false }
        return regex.firstMatch(in: text, options: [], range: NSRange(text.startIndex..., in: text)) != nil
    }

    private func postNotification(title: String, body: String, key: String, avatar: String) {
        // One notification per conversation: count this message, then reuse the conversation key as the
        // notification identifier so a new message REPLACES that conversation's notification instead of
        // stacking a fresh one. threadIdentifier keeps conversations grouped in Notification Center.
        let count = (unreadCounts[key] ?? 0) + 1
        unreadCounts[key] = count

        let content = UNMutableNotificationContent()
        // Surface the unread count once a conversation has more than one waiting message ("Sarah (3)").
        let baseTitle = title.isEmpty ? "Solstice" : title
        content.title = count > 1 ? "\(baseTitle) (\(count))" : baseTitle
        content.body = body
        // The current theme's PM/highlight sound (copied to Library/Sounds), or the system default.
        content.sound = SoundThemes.notificationSound(for: "attention")
        content.userInfo = ["data": key]
        content.threadIdentifier = key
        // App icon badge = total unread messages across all conversations.
        content.badge = NSNumber(value: unreadCounts.values.reduce(0, +))

        // Vibrate. UIFeedbackGenerator only fires while foregrounded, but the audio keep-alive keeps this
        // process alive, so AudioServicesPlaySystemSound can still drive the haptic motor from the
        // background. Motor only (no audio-session change), so it can't disturb the keep-alive tone.
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        if nowMs - lastVibrateMs > 1500 {
            lastVibrateMs = nowMs
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        }

        func submit(_ attachments: [UNNotificationAttachment]) {
            content.attachments = attachments
            let request = UNNotificationRequest(identifier: key, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
        }

        // Show the sender's avatar as the notification image (mirrors the foreground path). f-list.net
        // avatars live at a stable URL keyed by the lowercased name; percent-encode it so names with
        // spaces still form a valid URL. The host process is kept alive (audio mode), so this download
        // completes while backgrounded; if it fails we just post without an image.
        let name = avatar.lowercased()
        guard !name.isEmpty,
              let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "https://static.f-list.net/images/avatar/\(encoded).png")
        else { return submit([]) }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            var attachments: [UNNotificationAttachment] = []
            if let data = data {
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("notif-avatar-\(UUID().uuidString).png")
                if (try? data.write(to: tmp)) != nil,
                   let attachment = try? UNNotificationAttachment(identifier: "avatar", url: tmp) {
                    attachments.append(attachment)
                }
            }
            DispatchQueue.main.async { submit(attachments) }
        }.resume()
    }

    // The user opened a conversation (JS fires this via the select-conversation event): remove its
    // delivered notification, reset its unread count, and refresh the app icon badge to the new total.
    private func clearConversation(_ key: String) {
        guard !key.isEmpty else { return }
        unreadCounts.removeValue(forKey: key)
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [key])
        let total = unreadCounts.values.reduce(0, +)
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(total)
        } else {
            UIApplication.shared.applicationIconBadgeNumber = total
        }
    }

    private func stripBBCode(_ s: String) -> String {
        return s.replacingOccurrences(
            of: "\\[/?[a-zA-Z]+(=[^\\]]*)?\\]", with: "", options: .regularExpression)
    }

    @objc private func didBackground() { inBackground = true }

    @objc private func willForeground() {
        inBackground = false
        let pending = buffer
        buffer.removeAll()
        for entry in pending {
            emit("message", WebViewController.jsString(entry.frame), String(entry.timeMs))
        }
    }

    private func closeSocket() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        buffer.removeAll()
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        guard webSocketTask === task else { return }
        emit("open", "undefined")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let clean = (closeCode == .normalClosure || closeCode == .goingAway)
        emitClose(code: closeCode.rawValue, reason: text, clean: clean)
    }

    // MARK: - JS dispatch

    private func emitClose(code: Int, reason: String, clean: Bool) {
        guard !closeEmitted else { return }
        closeEmitted = true
        let payload = "{\"code\":\(code),\"reason\":\(WebViewController.jsString(reason)),\"wasClean\":\(clean)}"
        emit("close", payload)
    }

    private func emit(_ type: String, _ payloadJS: String, _ extraJS: String? = nil) {
        let extra = extraJS.map { ", \($0)" } ?? ""
        host?.evalJS("window.__nativeSocketEvent && window.__nativeSocketEvent('\(type)', \(payloadJS)\(extra))")
    }
}
