import Foundation
import WebKit

/// Native HTTP for the LAN log sync session (Horizon repo docs/log-sync-protocol.md). WKWebView
/// cannot make these requests itself: they are plain HTTP to a private LAN address (blocked by App
/// Transport Security and the local-network privacy layer) and cross-origin from the file:// page
/// (so a browser fetch would need a CORS preflight Horizon never answers). URLSession is subject to
/// none of that. This bridge is a dumb byte transport - all crypto, zip and merge stay in JS
/// (mobile/sync) - and mirrors Android's Sync.kt.
final class NativeSync: NSObject, WKScriptMessageHandlerWithReply {
    // Ephemeral: no cache or cookies for a single-use session. `waitsForConnectivity` stays false so
    // an unreachable address fails fast and the client fails over to the next.
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let call = BridgeCall(message), call.method == "request" else {
            return replyHandler(nil, "bad call")
        }
        guard let url = URL(string: call.string(1)) else {
            return replyHandler(nil, "bad url")
        }
        var request = URLRequest(url: url)
        request.httpMethod = call.string(0)
        // args: [method, url, headers, bodyBase64, timeoutMs]. The timeout is an idle timeout.
        let timeoutMs = call.int(4)
        request.timeoutInterval = timeoutMs > 0 ? Double(timeoutMs) / 1000.0 : 30
        if call.args.count > 2, let headers = call.args[2] as? [String: Any] {
            for (name, value) in headers {
                if let value = value as? String { request.setValue(value, forHTTPHeaderField: name) }
            }
        }
        if let bodyBase64 = call.optionalString(3), let body = Data(base64Encoded: bodyBase64) {
            request.httpBody = body
        }

        session.dataTask(with: request) { data, response, error in
            if let error = error {
                // Connection-level failure: reject so the client fails over to the next address.
                return replyHandler(nil, error.localizedDescription)
            }
            guard let http = response as? HTTPURLResponse else {
                return replyHandler(nil, "not an HTTP response")
            }
            replyHandler([
                "status": http.statusCode,
                "bodyBase64": (data ?? Data()).base64EncodedString()
            ], nil)
        }.resume()
    }
}
