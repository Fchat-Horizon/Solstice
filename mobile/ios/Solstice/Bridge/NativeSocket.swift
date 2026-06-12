import UIKit
import WebKit
import UserNotifications

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
    private var buffer: [String] = []
    private var closeEmitted = false
    private static let bufferCap = 3000

    // Who to notify for while backgrounded (set from JS on connect). `character` is the logged-in
    // character; `highlights` are lowercased terms (character name + highlight words) that make a
    // channel message worth a notification.
    private var character = ""
    private var highlights: [String] = []

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
        case "setIdentity":
            character = call.string(0)
            highlights = call.string(1)
                .lowercased()
                .split(separator: "\n")
                .map { String($0) }
                .filter { !$0.isEmpty }
            replyHandler(nil, nil)
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
            buffer.append(text)
            if buffer.count > Self.bufferCap {
                buffer.removeFirst(buffer.count - Self.bufferCap)
            }
        } else {
            emit("message", WebViewController.jsString(text))
        }
    }

    // Fire a local notification for an incoming PM (PRI) or a channel message (MSG) that mentions
    // the character or a highlight term. F-List frames are "<3-char command> <json>".
    private func notifyIfNeeded(_ frame: String) {
        guard frame.count > 4 else { return }
        let command = String(frame.prefix(3))
        guard command == "PRI" || command == "MSG" else { return }
        let jsonStart = frame.index(frame.startIndex, offsetBy: 4)
        guard let data = String(frame[jsonStart...]).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        let sender = (obj["character"] as? String) ?? ""
        let message = stripBBCode((obj["message"] as? String) ?? "")
        if command == "PRI" {
            postNotification(title: sender, body: message, key: sender)
        } else if sender.lowercased() != character.lowercased() {
            let low = message.lowercased()
            if highlights.contains(where: { low.contains($0) }) {
                let channel = (obj["channel"] as? String) ?? ""
                postNotification(title: "\(sender) in \(channel)", body: message, key: channel)
            }
        }
    }

    private func postNotification(title: String, body: String, key: String) {
        let content = UNMutableNotificationContent()
        content.title = title.isEmpty ? "Solstice" : title
        content.body = body
        content.sound = .default
        content.userInfo = ["data": key]
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
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
        for frame in pending { emit("message", WebViewController.jsString(frame)) }
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

    private func emit(_ type: String, _ payloadJS: String) {
        host?.evalJS("window.__nativeSocketEvent && window.__nativeSocketEvent('\(type)', \(payloadJS))")
    }
}
