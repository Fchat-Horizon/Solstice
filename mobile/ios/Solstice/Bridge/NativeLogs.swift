import Foundation
import WebKit

// Byte-faithful port of Logs.kt. The on-disk format MUST stay identical across Android and
// iOS (and the AppExporterDialog.vue JS writer), or imports/exports and existing logs break.
//
// All integers are little-endian. Files live under `<character>/logs/`:
//
//   Index file `<key>.idx`:
//     [1 byte name length N][N bytes conversation name (UTF-8)]
//     then repeating 7-byte entries: [int16 day][uint32 offset-low][1 byte offset-high]
//       (offset is 40-bit: low | (high << 32))
//
//   Data file `<key>` — repeating message records:
//     [int32 time][1 byte type][1 byte sender length S][S bytes sender]
//     [int16 text length T][T bytes text][int16 total = 8+S+T]
//       (on-disk record size = 10 + S + T; the trailing total enables the reverse scan)
final class NativeLogs: NSObject, WKScriptMessageHandlerWithReply {

    private final class IndexItem {
        var name: String
        var days: [Int] = []           // insertion order of day keys (== returned `dates`)
        var offsets: [Int] = []        // parallel to days: data-file offset where the day starts
        var dayToIdx: [Int: Int] = [:]
        init(name: String) { self.name = name }
        func addDay(_ day: Int, offset: Int) {
            dayToIdx[day] = days.count
            days.append(day)
            offsets.append(offset)
        }
    }

    private let root: URL
    private var index: [String: IndexItem] = [:]
    private var loadedIndex: [String: IndexItem] = [:]
    private var baseDir: URL?
    private var character: String?

    init(root: URL? = nil) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        try? FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: true)
        super.init()
    }

    // MARK: - Bridge dispatch

    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage,
                              replyHandler: @escaping (Any?, String?) -> Void) {
        guard let call = BridgeCall(message) else { return replyHandler(nil, "bad call") }
        switch call.method {
        case "init":
            replyHandler(initLogs(call.string(0)), nil)
        case "getCharacters":
            replyHandler(getCharacters(), nil)
        case "loadIndex":
            replyHandler(loadIndexPublic(call.string(0)), nil)
        case "logMessage":
            logMessage(key: call.string(0), conversation: call.string(1), time: call.int(2),
                       type: call.int(3), sender: call.string(4), text: call.string(5))
            replyHandler(nil, nil)
        case "getBacklog":
            replyHandler(getBacklog(key: call.string(0)), nil)
        case "getLogs":
            replyHandler(getLogs(character: call.string(0), key: call.string(1), date: call.int(2)), nil)
        case "repair":
            repair()
            replyHandler(nil, nil)
        default:
            replyHandler(nil, "unknown method \(call.method)")
        }
    }

    // MARK: - Public operations (also exercised directly by the unit test)

    func initLogs(_ character: String) -> [String: Any] {
        let dir = root.appendingPathComponent("\(character)/logs")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        baseDir = dir
        self.character = character
        let idx = loadIndex(character)
        index = idx
        loadedIndex = idx
        return indexJSON(idx)
    }

    func loadIndexPublic(_ character: String) -> [String: Any] {
        loadedIndex = (character == self.character) ? index : loadIndex(character)
        return indexJSON(loadedIndex)
    }

    func getCharacters() -> [String] {
        let items = (try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return items.compactMap { item in
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            return isDir ? item.lastPathComponent : nil
        }
    }

    func logMessage(key: String, conversation: String, time: Int, type: Int, sender: String, text: String) {
        guard let baseDir = baseDir else { return }
        let day = time / 86400
        let dataURL = baseDir.appendingPathComponent(key)
        let idxURL = baseDir.appendingPathComponent("\(key).idx")

        var idxAppend = Data()
        let item: IndexItem
        if let existing = index[key] {
            item = existing
        } else {
            let newItem = IndexItem(name: conversation)
            index[key] = newItem
            item = newItem
            let nameData = Data(conversation.utf8)
            idxAppend.append(UInt8(nameData.count & 0xFF))
            idxAppend.append(nameData)
        }

        if item.dayToIdx[day] == nil {
            let offset = fileSize(dataURL)
            item.addDay(day, offset: offset)
            idxAppend.appendLE(UInt16(truncatingIfNeeded: day))
            idxAppend.appendLE(UInt32(truncatingIfNeeded: offset & 0xFFFFFFFF))
            idxAppend.append(UInt8((offset >> 32) & 0xFF))
        }
        if !idxAppend.isEmpty { append(idxAppend, to: idxURL) }

        let senderData = Data(sender.utf8)
        let textData = Data(text.utf8)
        var msg = Data()
        msg.appendLE(UInt32(truncatingIfNeeded: time))
        msg.append(UInt8(type & 0xFF))
        msg.append(UInt8(senderData.count & 0xFF))
        msg.append(senderData)
        msg.appendLE(UInt16(truncatingIfNeeded: textData.count))
        msg.append(textData)
        msg.appendLE(UInt16(truncatingIfNeeded: 8 + senderData.count + textData.count))
        append(msg, to: dataURL)
    }

    func getBacklog(key: String) -> [[String: Any]] {
        guard let baseDir = baseDir else { return [] }
        let url = baseDir.appendingPathComponent(key)
        guard FileManager.default.fileExists(atPath: url.path),
              let fh = try? FileHandle(forReadingFrom: url) else { return [] }
        defer { try? fh.close() }
        var pos = fileSize(url)
        var result: [[String: Any]] = []
        while pos > 0 && result.count < 20 {
            guard let lenData = read(fh, at: pos - 2, length: 2), lenData.count == 2 else { break }
            let length = Int(readUInt16LE(lenData, 0))
            let start = pos - length - 2
            guard start >= 0, let body = read(fh, at: start, length: length), body.count == length,
                  let msg = deserialize(body) else { break }
            result.insert(msg, at: 0)
            pos = start
        }
        return result
    }

    func getLogs(character: String, key: String, date: Int) -> [[String: Any]] {
        guard let item = loadedIndex[key], let dateIdx = item.dayToIdx[date] else { return [] }
        let url = root.appendingPathComponent("\(character)/logs/\(key)")
        guard let fh = try? FileHandle(forReadingFrom: url) else { return [] }
        defer { try? fh.close() }
        let size = fileSize(url)
        let start = item.offsets[dateIdx]
        let end = (dateIdx >= item.offsets.count - 1) ? size : item.offsets[dateIdx + 1]
        guard end > start, let buffer = read(fh, at: start, length: end - start) else { return [] }

        var result: [[String: Any]] = []
        var pos = 0
        let count = buffer.count
        while pos + 8 <= count {
            let senderLen = Int(byte(buffer, pos + 5))
            let textLenPos = pos + 6 + senderLen
            guard textLenPos + 2 <= count else { break }
            let textLen = Int(readUInt16LE(buffer, textLenPos))
            let bodyLen = 8 + senderLen + textLen
            guard pos + bodyLen + 2 <= count else { break }
            if let msg = deserialize(slice(buffer, pos, bodyLen)) { result.append(msg) }
            pos += bodyLen + 2
        }
        return result
    }

    func repair() {
        guard let baseDir = baseDir else { return }
        let files = (try? FileManager.default.contentsOfDirectory(at: baseDir, includingPropertiesForKeys: nil)) ?? []
        for entry in files where entry.pathExtension != "idx" {
            let idxURL = baseDir.appendingPathComponent("\(entry.lastPathComponent).idx")
            guard let idxData = try? Data(contentsOf: idxURL), !idxData.isEmpty else { continue }
            let nameLength = Int(idxData[idxData.startIndex])
            guard idxData.count >= nameLength + 1 else { continue }
            var newIdx = Data(idxData.prefix(nameLength + 1))

            guard let data = try? Data(contentsOf: entry) else { continue }
            let count = data.count
            var pos = 0
            var lastDay = 0
            var truncateAt = 0
            while pos + 10 <= count {
                let time = Int(Int32(bitPattern: readUInt32LE(data, pos)))
                let senderLen = Int(byte(data, pos + 5))
                let textLenPos = pos + 6 + senderLen
                guard textLenPos + 2 <= count else { break }
                let textLen = Int(readUInt16LE(data, textLenPos))
                let bodyLen = 8 + senderLen + textLen
                guard pos + bodyLen + 2 <= count else { break }
                guard Int(readUInt16LE(data, pos + bodyLen)) == bodyLen else { break } // corruption → stop
                let day = time / 86400
                if day > lastDay {
                    lastDay = day
                    newIdx.appendLE(UInt16(truncatingIfNeeded: day))
                    newIdx.appendLE(UInt32(truncatingIfNeeded: pos & 0xFFFFFFFF))
                    newIdx.append(UInt8((pos >> 32) & 0xFF))
                }
                pos += bodyLen + 2
                truncateAt = pos
            }
            try? newIdx.write(to: idxURL)
            if truncateAt < count, let fh = try? FileHandle(forWritingTo: entry) {
                try? fh.truncate(atOffset: UInt64(truncateAt))
                try? fh.close()
            }
        }
        if let character = character {
            let idx = loadIndex(character)
            index = idx
            loadedIndex = idx
        }
    }

    // MARK: - Index helpers

    private func loadIndex(_ character: String) -> [String: IndexItem] {
        let dir = root.appendingPathComponent("\(character)/logs")
        var result: [String: IndexItem] = [:]
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.pathExtension == "idx" {
            guard let data = try? Data(contentsOf: file), !data.isEmpty else { continue }
            let nameLength = Int(data[data.startIndex])
            guard data.count >= 1 + nameLength else { continue }
            let name = String(data: slice(data, 1, nameLength), encoding: .utf8) ?? ""
            let item = IndexItem(name: name)
            var pos = 1 + nameLength
            while pos + 7 <= data.count {
                let day = Int(readInt16LE(data, pos))
                let low = UInt64(readUInt32LE(data, pos + 2))
                let high = UInt64(byte(data, pos + 6))
                item.addDay(day, offset: Int(low | (high << 32)))
                pos += 7
            }
            result[file.deletingPathExtension().lastPathComponent] = item
        }
        return result
    }

    private func indexJSON(_ index: [String: IndexItem]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (key, item) in index { out[key] = ["name": item.name, "dates": item.days] }
        return out
    }

    private func deserialize(_ body: Data) -> [String: Any]? {
        guard body.count >= 6 else { return nil }
        let time = Int(Int32(bitPattern: readUInt32LE(body, 0)))
        let type = Int(byte(body, 4))
        let senderLen = Int(byte(body, 5))
        guard body.count >= 8 + senderLen else { return nil }
        let sender = String(data: slice(body, 6, senderLen), encoding: .utf8) ?? ""
        let textLen = Int(readUInt16LE(body, 6 + senderLen))
        guard body.count >= 8 + senderLen + textLen else { return nil }
        let text = String(data: slice(body, 8 + senderLen, textLen), encoding: .utf8) ?? ""
        return ["time": time, "type": type, "sender": sender, "text": text]
    }

    // MARK: - File / byte helpers

    private func fileSize(_ url: URL) -> Int {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.size] as? NSNumber)?.intValue ?? 0
    }

    private func append(_ data: Data, to url: URL) {
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            fm.createFile(atPath: url.path, contents: nil)
        }
        guard let fh = try? FileHandle(forWritingTo: url) else { return }
        defer { try? fh.close() }
        _ = try? fh.seekToEnd()
        try? fh.write(contentsOf: data)
    }

    private func read(_ fh: FileHandle, at offset: Int, length: Int) -> Data? {
        guard length >= 0 else { return nil }
        do {
            try fh.seek(toOffset: UInt64(offset))
            return try fh.read(upToCount: length)
        } catch { return nil }
    }

    private func byte(_ d: Data, _ off: Int) -> UInt8 { d[d.startIndex + off] }

    private func slice(_ d: Data, _ start: Int, _ length: Int) -> Data {
        let s = d.startIndex + start
        return d.subdata(in: s..<(s + length))
    }

    private func readUInt16LE(_ d: Data, _ off: Int) -> UInt16 {
        let i = d.startIndex + off
        return UInt16(d[i]) | (UInt16(d[i + 1]) << 8)
    }

    private func readInt16LE(_ d: Data, _ off: Int) -> Int16 {
        Int16(bitPattern: readUInt16LE(d, off))
    }

    private func readUInt32LE(_ d: Data, _ off: Int) -> UInt32 {
        let i = d.startIndex + off
        return UInt32(d[i]) | (UInt32(d[i + 1]) << 8) | (UInt32(d[i + 2]) << 16) | (UInt32(d[i + 3]) << 24)
    }
}

private extension Data {
    mutating func appendLE(_ value: UInt16) {
        append(UInt8(value & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
    }
    mutating func appendLE(_ value: UInt32) {
        append(UInt8(value & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8((value >> 16) & 0xFF))
        append(UInt8((value >> 24) & 0xFF))
    }
}
