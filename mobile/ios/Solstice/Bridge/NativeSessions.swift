import WebKit

// The iOS side of mobile/sessions.ts: several characters at once, one ChatPage each. Android's
// NativeSessions answers synchronously; WKWebView cannot, so bridge.js serves the getters (id, max,
// state, credentials, ticket) from a copy that WebViewController seeds through the page's boot script
// and keeps current with window.__solsticeSessionsPush. Only the calls that change something come here.
final class NativeSessions: NSObject, WKScriptMessageHandlerWithReply {
    private let pageId: Int
    private weak var controller: WebViewController?

    init(pageId: Int, controller: WebViewController) {
        self.pageId = pageId
        self.controller = controller
    }

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let call = BridgeCall(message) else { return replyHandler(nil, "bad call") }
        guard let controller = controller else { return replyHandler(nil, nil) }
        switch call.method {
        case "report": controller.updateState(of: pageId, json: call.string(0)); replyHandler(nil, nil)
        case "switchTo": controller.activate(call.int(0)); replyHandler(nil, nil)
        case "add": replyHandler(controller.addPage(), nil)
        case "close":
            // A page usually closes itself, so tear it down after this callback rather than inside it.
            let id = call.int(0)
            replyHandler(nil, nil)
            DispatchQueue.main.async { controller.removePage(id) }
        case "setCredentials": controller.setSharedCredentials(call.string(0), from: pageId); replyHandler(nil, nil)
        case "setTicket": controller.setSharedTicket(call.string(0), from: pageId); replyHandler(nil, nil)
        default: replyHandler(nil, "unknown method \(call.method)")
        }
    }
}
