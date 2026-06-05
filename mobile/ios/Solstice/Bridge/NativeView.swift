import UIKit
import WebKit

// Optional native bridge (Android sets it only on some builds). Index.vue calls
// setTheme(theme) whenever window.NativeView exists, so the native window background can
// match the web theme and avoid a flash of the wrong colour during navigation/reload.
final class NativeView: NSObject, WKScriptMessageHandlerWithReply {
    weak var host: WebViewController?

    init(host: WebViewController) { self.host = host }

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let call = BridgeCall(message) else { return replyHandler(nil, "bad call") }
        if call.method == "setTheme" {
            host?.applyTheme(call.string(0))
            replyHandler(nil, nil)
        } else {
            replyHandler(nil, "unknown method \(call.method)")
        }
    }
}
