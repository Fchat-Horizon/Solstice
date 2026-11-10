import Foundation

// The F-List frames that arrive while the app is backgrounded (WebView suspended), held for
// NativeSocket to replay on resume. Foundation only, so SolsticeTests can exercise it directly.
//
// F-List sends every client the logins, logouts and status changes of every character online, so a
// long idle produces far more of those than anything else. A plain list that dropped its oldest
// frames past a fixed cap silently lost them (issue #32): presence went stale, and PMs and channel
// messages vanished from their conversations and logs. So instead:
//   - Status (STA) and typing (TPN) frames are pure state, so only each character's latest is kept.
//   - Everything else is kept in arrival order.
//   - If the buffer still fills up, presence (NLN/FLN/STA/TPN) is dropped and `needsResync` is set:
//     the WebView reconnects after replaying, and the fresh login resends the full online list.
//     Should even that not be enough, the oldest frames go, PMs last since they cannot be refetched.
struct FrameBuffer {
    struct Frame: Equatable {
        let text: String
        let timeMs: Int
    }

    // seq records arrival order, so the coalesced frames merge back into their place on drain.
    private struct Entry {
        let seq: Int
        let frame: Frame
    }

    static let presenceCommands: Set<String> = ["NLN", "FLN", "STA", "TPN"]

    let cap: Int
    private var ordered: [Entry] = []
    private var latest: [String: Entry] = [:]
    private var nextSeq = 0
    private(set) var needsResync = false

    init(cap: Int = 50_000) {
        self.cap = cap
    }

    var count: Int { ordered.count + latest.count }

    mutating func append(_ text: String, timeMs: Int) {
        // PIN is answered natively and ignored by the JS Connection, so replaying it is waste.
        if text == "PIN" { return }
        let command = String(text.prefix(3))
        // Once a resync is due the online list gets rebuilt from scratch, so presence is redundant.
        if needsResync && Self.presenceCommands.contains(command) { return }
        let entry = Entry(seq: nextSeq, frame: Frame(text: text, timeMs: timeMs))
        nextSeq += 1
        if command == "STA" || command == "TPN", let name = Self.character(in: text) {
            latest["\(command) \(name.lowercased())"] = entry
        } else {
            ordered.append(entry)
        }
        if count > cap { shed() }
    }

    // Everything buffered, in arrival order, and whether the WebView must reconnect afterwards.
    // Leaves the buffer empty.
    mutating func drain() -> (frames: [Frame], needsResync: Bool) {
        let frames = (ordered + latest.values).sorted { $0.seq < $1.seq }.map { $0.frame }
        let resync = needsResync
        removeAll()
        return (frames, resync)
    }

    mutating func removeAll() {
        self = FrameBuffer(cap: cap)
    }

    private mutating func shed() {
        if !needsResync {
            needsResync = true
            latest.removeAll()
            ordered.removeAll { Self.presenceCommands.contains(String($0.frame.text.prefix(3))) }
        }
        // Trim to 90% so this O(n) pass runs once per cap/10 frames, not on every frame.
        var excess = ordered.count - cap * 9 / 10
        guard excess > 0 else { return }
        var kept: [Entry] = []
        kept.reserveCapacity(ordered.count - excess)
        for entry in ordered {
            if excess > 0 && !entry.frame.text.hasPrefix("PRI ") {
                excess -= 1
            } else {
                kept.append(entry)
            }
        }
        kept.removeFirst(min(excess, kept.count))
        ordered = kept
    }

    // The "character" field of a "<CMD> <json>" frame.
    private static func character(in frame: String) -> String? {
        let json = Data(frame.utf8.dropFirst(4))
        let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any]
        return obj?["character"] as? String
    }
}
