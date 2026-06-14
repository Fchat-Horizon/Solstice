import UIKit
import WebKit

// Mirrors Clipboard.kt. The app is served from file:// (a non-secure context) where
// navigator.clipboard is unreliable, so chat.ts routes clipboard access here.
final class NativeClipboard: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let call = BridgeCall(message) else { return replyHandler(nil, "bad call") }
        switch call.method {
        case "writeText":
            UIPasteboard.general.string = call.string(0)
            replyHandler(nil, nil)
        case "readText":
            replyHandler(UIPasteboard.general.string ?? "", nil)
        default:
            replyHandler(nil, "unknown method \(call.method)")
        }
    }
}
