import UIKit
import WebKit

// Mirrors Background.kt / BackgroundService.kt — but iOS has no equivalent to Android's
// foreground service + partial wake lock. The best we can do is hold a background-task
// grace window so the WebSocket survives briefly after the app is backgrounded; iOS will
// still suspend the app once the window expires. See the README "iOS limitations" section.
final class NativeBackground: NSObject, WKScriptMessageHandlerWithReply {
    private var taskId: UIBackgroundTaskIdentifier = .invalid

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let call = BridgeCall(message) else { return replyHandler(nil, "bad call") }
        switch call.method {
        case "start": start(); replyHandler(nil, nil)
        case "stop": stop(); replyHandler(nil, nil)
        default: replyHandler(nil, "unknown method \(call.method)")
        }
    }

    private func start() {
        stop()
        taskId = UIApplication.shared.beginBackgroundTask(withName: "fchat") { [weak self] in
            self?.stop()
        }
    }

    private func stop() {
        guard taskId != .invalid else { return }
        UIApplication.shared.endBackgroundTask(taskId)
        taskId = .invalid
    }
}
