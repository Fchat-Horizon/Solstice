import XCTest
@testable import Solstice

// Verifies NativeLogs against the binary format spec so iOS logs stay interoperable with
// Android (Logs.kt) and the AppExporterDialog.vue importer (jsonLogToBinary / buildLogIndex).
final class LogsRoundTripTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("solstice-logs-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testRoundTripAndOnDiskFormat() throws {
        let character = "TestChar"
        let key = "convo"
        let name = "Friend"

        let time1 = 1_700_000_000             // day boundary anchor
        let day1 = time1 / 86400
        let time2 = time1 + 30                 // same day
        let time3 = time1 + 86400              // next day
        let day2 = time3 / 86400

        let m1 = (time1, 0, "Alice", "Hello \u{1F31F}")  // multibyte text
        let m2 = (time2, 1, "Bob", "Hi there")
        let m3 = (time3, 0, "Alice", "Next day")

        let logs = NativeLogs(root: root)
        _ = logs.initLogs(character)
        for m in [m1, m2, m3] {
            logs.logMessage(key: key, conversation: name, time: m.0, type: m.1, sender: m.2, text: m.3)
        }

        // --- getBacklog returns all three, oldest first ---
        let backlog = logs.getBacklog(key: key)
        XCTAssertEqual(backlog.count, 3)
        assertMessage(backlog[0], m1)
        assertMessage(backlog[1], m2)
        assertMessage(backlog[2], m3)

        // --- getLogs slices by day ---
        _ = logs.loadIndexPublic(character)
        let day1Logs = logs.getLogs(character: character, key: key, date: day1)
        XCTAssertEqual(day1Logs.count, 2)
        assertMessage(day1Logs[0], m1)
        assertMessage(day1Logs[1], m2)

        let day2Logs = logs.getLogs(character: character, key: key, date: day2)
        XCTAssertEqual(day2Logs.count, 1)
        assertMessage(day2Logs[0], m3)

        // --- On-disk bytes match the cross-platform format exactly ---
        let logsDir = root.appendingPathComponent("\(character)/logs")
        let dataBytes = try Data(contentsOf: logsDir.appendingPathComponent(key))
        var expectedData = Data()
        expectedData.append(encodeMessage(m1))
        expectedData.append(encodeMessage(m2))
        expectedData.append(encodeMessage(m3))
        XCTAssertEqual(dataBytes, expectedData, "data file does not match the binary message format")

        let idxBytes = try Data(contentsOf: logsDir.appendingPathComponent("\(key).idx"))
        let nameData = Data(name.utf8)
        var expectedIdx = Data()
        expectedIdx.append(UInt8(nameData.count))
        expectedIdx.append(nameData)
        expectedIdx.append(idxEntry(day: day1, offset: 0))
        expectedIdx.append(idxEntry(day: day2, offset: encodeMessage(m1).count + encodeMessage(m2).count))
        XCTAssertEqual(idxBytes, expectedIdx, "index file does not match the .idx format")
    }

    func testRepairRebuildsIndexAndTruncatesCorruption() throws {
        let character = "RepairChar"
        let key = "c"
        let time = 1_700_000_000
        let logs = NativeLogs(root: root)
        _ = logs.initLogs(character)
        logs.logMessage(key: key, conversation: "X", time: time, type: 0, sender: "A", text: "ok")

        let logsDir = root.appendingPathComponent("\(character)/logs")
        let dataURL = logsDir.appendingPathComponent(key)
        let idxURL = logsDir.appendingPathComponent("\(key).idx")
        let validData = try Data(contentsOf: dataURL)

        // Realistic corruption: the .idx is present but stale, and the data file has a
        // trailing partial/garbage record. repair() re-derives both from the valid records.
        var corruptData = validData
        corruptData.append(contentsOf: [0xDE, 0xAD, 0xBE, 0xEF, 0x00])
        try corruptData.write(to: dataURL)
        var corruptIdx = try Data(contentsOf: idxURL)
        corruptIdx.append(contentsOf: [0xFF, 0xFF])
        try corruptIdx.write(to: idxURL)

        logs.repair()

        XCTAssertEqual(try Data(contentsOf: dataURL), validData, "repair should truncate trailing corruption")

        var expectedIdx = Data()
        expectedIdx.append(1)               // name length
        expectedIdx.append(Data("X".utf8))  // conversation name
        expectedIdx.append(idxEntry(day: time / 86400, offset: 0))
        XCTAssertEqual(try Data(contentsOf: idxURL), expectedIdx, "repair should rebuild the index")
    }

    // MARK: - Helpers

    private func assertMessage(_ got: [String: Any], _ expected: (Int, Int, String, String),
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(got["time"] as? Int, expected.0, file: file, line: line)
        XCTAssertEqual(got["type"] as? Int, expected.1, file: file, line: line)
        XCTAssertEqual(got["sender"] as? String, expected.2, file: file, line: line)
        XCTAssertEqual(got["text"] as? String, expected.3, file: file, line: line)
    }

    private func encodeMessage(_ m: (Int, Int, String, String)) -> Data {
        let sender = Data(m.2.utf8)
        let text = Data(m.3.utf8)
        var d = Data()
        d.appendUInt32LE(UInt32(truncatingIfNeeded: m.0))
        d.append(UInt8(m.1))
        d.append(UInt8(sender.count))
        d.append(sender)
        d.appendUInt16LE(UInt16(text.count))
        d.append(text)
        d.appendUInt16LE(UInt16(8 + sender.count + text.count))
        return d
    }

    private func idxEntry(day: Int, offset: Int) -> Data {
        var d = Data()
        d.appendUInt16LE(UInt16(truncatingIfNeeded: day))
        d.appendUInt32LE(UInt32(truncatingIfNeeded: offset & 0xFFFFFFFF))
        d.append(UInt8((offset >> 32) & 0xFF))
        return d
    }
}

private extension Data {
    mutating func appendUInt16LE(_ value: UInt16) {
        append(UInt8(value & 0xFF)); append(UInt8((value >> 8) & 0xFF))
    }
    mutating func appendUInt32LE(_ value: UInt32) {
        append(UInt8(value & 0xFF)); append(UInt8((value >> 8) & 0xFF))
        append(UInt8((value >> 16) & 0xFF)); append(UInt8((value >> 24) & 0xFF))
    }
}
