import WebKit

/// Parsed `{ method, args }` payload posted by bridge.js over a message handler.
struct BridgeCall {
    let method: String
    let args: [Any]

    init?(_ message: WKScriptMessage) {
        guard let dict = message.body as? [String: Any],
              let method = dict["method"] as? String else { return nil }
        self.method = method
        self.args = (dict["args"] as? [Any]) ?? []
    }

    /// Non-null string argument (empty string if absent/null).
    func string(_ i: Int) -> String { optionalString(i) ?? "" }

    /// String argument that may be JS `null`/`undefined` (→ nil).
    func optionalString(_ i: Int) -> String? {
        guard i < args.count else { return nil }
        return args[i] as? String
    }

    func int(_ i: Int) -> Int {
        guard i < args.count else { return 0 }
        if let n = args[i] as? NSNumber { return n.intValue }
        if let n = args[i] as? Int { return n }
        if let n = args[i] as? Double { return Int(n) }
        return 0
    }

    func bool(_ i: Int) -> Bool {
        guard i < args.count else { return false }
        if let n = args[i] as? NSNumber { return n.boolValue }
        return (args[i] as? Bool) ?? false
    }
}
