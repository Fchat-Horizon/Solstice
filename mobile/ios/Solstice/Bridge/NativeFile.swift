import UIKit
import WebKit

// Mirrors File.kt. All paths are relative to the app's Application Support directory —
// the iOS analogue of Android's private filesDir. The web layer (filesystem.ts) treats
// "/" as the root and uses names like "!settings", "<character>/<key>" and
// "<character>/logs/<key>".
final class NativeFile: NSObject, WKScriptMessageHandlerWithReply {
    weak var host: WebViewController?
    let rootURL: URL

    override init() {
        let fm = FileManager.default
        let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        self.rootURL = dir
        super.init()
    }

    private func url(for name: String) -> URL {
        if name.isEmpty || name == "/" { return rootURL }
        var n = name
        while n.hasPrefix("/") { n.removeFirst() }
        return rootURL.appendingPathComponent(n)
    }

    /// In-flight sync upload archive; see the `zipStart` case below.
    private var zipWriter: ZipArchive.Writer?

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let call = BridgeCall(message) else { return replyHandler(nil, "bad call") }
        let fm = FileManager.default
        switch call.method {
        case "read":
            let contents = try? String(contentsOf: url(for: call.string(0)), encoding: .utf8)
            replyHandler(contents ?? NSNull(), nil)
        case "getSize":
            let attrs = try? fm.attributesOfItem(atPath: url(for: call.string(0)).path)
            replyHandler((attrs?[.size] as? NSNumber)?.intValue ?? 0, nil)
        case "readBytes":
            replyHandler(readBytes(url: url(for: call.string(0)), offset: call.int(1), length: call.int(2)), nil)
        case "delete":
            replyHandler((try? fm.removeItem(at: url(for: call.string(0)))) != nil, nil)
        case "write":
            writeData(Data(call.string(1).utf8), to: url(for: call.string(0)))
            replyHandler(nil, nil)
        case "writeBytes":
            writeData(Data(base64Encoded: call.string(1)) ?? Data(), to: url(for: call.string(0)))
            replyHandler(nil, nil)
        case "appendBytes":
            appendData(Data(base64Encoded: call.string(1)) ?? Data(), to: url(for: call.string(0)))
            replyHandler(nil, nil)
        case "rename":
            replyHandler(rename(from: url(for: call.string(0)), to: url(for: call.string(1))), nil)
        case "listFiles":
            replyHandler(entries(at: url(for: call.string(0)), directories: false), nil)
        case "listDirectories":
            replyHandler(entries(at: url(for: call.string(0)), directories: true), nil)
        case "ensureDirectory":
            try? fm.createDirectory(at: url(for: call.string(0)), withIntermediateDirectories: true)
            replyHandler(nil, nil)
        case "zipStart":
            // A new archive abandons any half-built one, so an interrupted upload
            // cannot leak entries into the next batch.
            zipWriter = ZipArchive.Writer()
            replyHandler(nil, nil)
        case "zipAdd":
            // The entry text arrives as a plain string and is UTF-8 encoded here:
            // encoding it in the WebView is a large part of what this call exists
            // to avoid, and base64 would put it straight back.
            zipWriter?.add(name: call.string(0), data: Data(call.string(1).utf8))
            replyHandler(nil, nil)
        case "zipFinish":
            let finished = zipWriter?.finish() ?? Data()
            zipWriter = nil
            replyHandler(finished.base64EncodedString(), nil)
        case "exportData":
            replyHandler(exportData(), nil)
        case "exportCrashLog":
            replyHandler(exportCrashLog(), nil)
        case "pickImportFile":
            host?.presentImportPicker()
            replyHandler(nil, nil)
        default:
            replyHandler(nil, "unknown method \(call.method)")
        }
    }

    private func writeData(_ data: Data, to url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? data.write(to: url)
    }

    // Appends, so the sync merge can extend a conversation without rewriting it. Without
    // this the only way to add a message to a 300 MB log is to read, re-encode and write
    // all 300 MB back, which costs about twice that in JavaScript objects.
    private func appendData(_ data: Data, to url: URL) {
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard fm.fileExists(atPath: url.path) else {
            try? data.write(to: url)
            return
        }
        guard let fh = try? FileHandle(forWritingTo: url) else { return }
        defer { try? fh.close() }
        _ = try? fh.seekToEnd()
        try? fh.write(contentsOf: data)
    }

    // Moves a finished scratch file over the log it replaces, so a merge that dies partway
    // leaves the original intact rather than a half-written one.
    private func rename(from: URL, to: URL) -> Bool {
        let fm = FileManager.default
        guard fm.fileExists(atPath: from.path) else { return false }
        try? fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
        // replaceItemAt handles an existing destination, which plain moveItem refuses.
        if (try? fm.replaceItemAt(to, withItemAt: from)) != nil { return true }
        try? fm.removeItem(at: to)
        return (try? fm.moveItem(at: from, to: to)) != nil
    }

    // Reads `length` bytes at `offset` and returns them base64-encoded. Mirrors File.kt's
    // readBytes — the importer reads the staged zip in chunks to avoid huge allocations.
    private func readBytes(url: URL, offset: Int, length: Int) -> String {
        guard length > 0, let fh = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? fh.close() }
        do {
            try fh.seek(toOffset: UInt64(max(0, offset)))
            return (try fh.read(upToCount: length) ?? Data()).base64EncodedString()
        } catch {
            return ""
        }
    }

    // Writes a picked import file into app storage and returns its relative name, so the web
    // layer reads it back via getSize/readBytes (the same temp-file flow Android uses) and
    // deletes it when done. Called by WebViewController's document-picker delegate.
    func stageImportFile(_ data: Data) -> String? {
        let name = ".import.tmp"
        do {
            try data.write(to: url(for: name))
            return name
        } catch {
            return nil
        }
    }

    private func entries(at url: URL, directories: Bool) -> [String] {
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: url, includingPropertiesForKeys: [.isDirectoryKey]) else { return [] }
        return items.compactMap { item in
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            return isDir == directories ? item.lastPathComponent : nil
        }
    }

    private func exportData() -> String {
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let fileName = "horizon-backup-\(fmt.string(from: Date())).zip"
        let dest = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
        try? FileManager.default.removeItem(at: dest)
        do {
            try ZipArchive.zip(directory: rootURL, to: dest)
        } catch {
            return ""
        }
        host?.presentShareSheet(fileURL: dest)
        return fileName
    }

    // Shares the sanitized diagnostic log ('!crashlog', written by mobile/chat.ts) via a share sheet
    // so it can be attached to a bug report. Returns the file name, or "" when there is no log yet or
    // the copy failed. Mirrors File.kt's exportCrashLog (which copies to Downloads on Android).
    private func exportCrashLog() -> String {
        let src = url(for: "!crashlog")
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: src.path),
              let size = attrs[.size] as? NSNumber, size.intValue > 0 else { return "" }
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let fileName = "solstice-crashlog-\(fmt.string(from: Date())).txt"
        let dest = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
        try? FileManager.default.removeItem(at: dest)
        do {
            try FileManager.default.copyItem(at: src, to: dest)
        } catch {
            return ""
        }
        host?.presentShareSheet(fileURL: dest)
        return fileName
    }
}
