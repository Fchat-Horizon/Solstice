import XCTest
@testable import Solstice

// Covers the background frame buffer NativeSocket replays on resume (issue #32): nothing is lost
// silently, status/typing are coalesced per character, and an overflow asks for a resync.
final class FrameBufferTests: XCTestCase {
    private func texts(_ frames: [FrameBuffer.Frame]) -> [String] {
        return frames.map { $0.text }
    }

    func testKeepsArrivalOrderAndTimes() {
        var buffer = FrameBuffer()
        buffer.append("MSG {\"channel\":\"c\",\"character\":\"A\",\"message\":\"hi\"}", timeMs: 1)
        buffer.append("PRI {\"character\":\"B\",\"message\":\"yo\"}", timeMs: 2)
        buffer.append("NLN {\"identity\":\"C\",\"gender\":\"Male\",\"status\":\"online\"}", timeMs: 3)
        let (frames, needsResync) = buffer.drain()
        XCTAssertEqual(frames.map { $0.timeMs }, [1, 2, 3])
        XCTAssertTrue(frames[1].text.hasPrefix("PRI "))
        XCTAssertFalse(needsResync)
        XCTAssertEqual(buffer.count, 0)
    }

    func testSkipsPin() {
        var buffer = FrameBuffer()
        buffer.append("PIN", timeMs: 1)
        XCTAssertEqual(buffer.count, 0)
    }

    func testCoalescesStatusAndTypingPerCharacter() {
        var buffer = FrameBuffer()
        buffer.append("STA {\"character\":\"Alice\",\"status\":\"away\",\"statusmsg\":\"\"}", timeMs: 1)
        buffer.append("MSG {\"channel\":\"c\",\"character\":\"X\",\"message\":\"m\"}", timeMs: 2)
        buffer.append("STA {\"character\":\"Bob\",\"status\":\"busy\",\"statusmsg\":\"\"}", timeMs: 3)
        buffer.append("STA {\"character\":\"alice\",\"status\":\"looking\",\"statusmsg\":\"\"}", timeMs: 4)
        buffer.append("TPN {\"character\":\"Alice\",\"status\":\"typing\"}", timeMs: 5)
        buffer.append("TPN {\"character\":\"Alice\",\"status\":\"clear\"}", timeMs: 6)
        let (frames, _) = buffer.drain()
        XCTAssertEqual(frames.map { $0.timeMs }, [2, 3, 4, 6])
        XCTAssertTrue(frames[2].text.contains("looking"))
        XCTAssertTrue(frames[3].text.contains("clear"))
    }

    func testStatusStaysAfterTheLoginItFollows() {
        var buffer = FrameBuffer()
        buffer.append("STA {\"character\":\"A\",\"status\":\"away\",\"statusmsg\":\"\"}", timeMs: 1)
        buffer.append("FLN {\"character\":\"A\"}", timeMs: 2)
        buffer.append("NLN {\"identity\":\"A\",\"gender\":\"Male\",\"status\":\"online\"}", timeMs: 3)
        buffer.append("STA {\"character\":\"A\",\"status\":\"busy\",\"statusmsg\":\"\"}", timeMs: 4)
        let (frames, _) = buffer.drain()
        XCTAssertEqual(frames.map { $0.timeMs }, [2, 3, 4])
    }

    func testMalformedStatusIsKeptInOrder() {
        var buffer = FrameBuffer()
        buffer.append("STA not json", timeMs: 1)
        buffer.append("STA not json", timeMs: 2)
        XCTAssertEqual(buffer.drain().frames.map { $0.timeMs }, [1, 2])
    }

    func testOverflowDropsPresenceAndRequestsResync() {
        var buffer = FrameBuffer(cap: 10)
        buffer.append("PRI {\"character\":\"P\",\"message\":\"pm\"}", timeMs: 0)
        buffer.append("MSG {\"channel\":\"c\",\"character\":\"X\",\"message\":\"m\"}", timeMs: 1)
        for i in 0..<9 {
            buffer.append("NLN {\"identity\":\"N\(i)\",\"gender\":\"Male\",\"status\":\"online\"}", timeMs: 2 + i)
        }
        XCTAssertTrue(buffer.needsResync)
        XCTAssertEqual(buffer.count, 2)
        // Presence after the overflow is redundant too; everything else still goes in.
        buffer.append("FLN {\"character\":\"N0\"}", timeMs: 20)
        buffer.append("STA {\"character\":\"N1\",\"status\":\"away\",\"statusmsg\":\"\"}", timeMs: 21)
        buffer.append("TPN {\"character\":\"P\",\"status\":\"typing\"}", timeMs: 22)
        buffer.append("MSG {\"channel\":\"c\",\"character\":\"X\",\"message\":\"m2\"}", timeMs: 23)
        let (frames, needsResync) = buffer.drain()
        XCTAssertTrue(needsResync)
        XCTAssertEqual(frames.map { $0.timeMs }, [0, 1, 23])
        XCTAssertFalse(buffer.needsResync)
    }

    func testOverflowWithoutPresenceDropsOldestButKeepsPMs() {
        var buffer = FrameBuffer(cap: 10)
        buffer.append("PRI {\"character\":\"P\",\"message\":\"pm\"}", timeMs: 0)
        for i in 1...10 {
            buffer.append("MSG {\"channel\":\"c\",\"character\":\"X\",\"message\":\"\(i)\"}", timeMs: i)
        }
        XCTAssertEqual(buffer.count, 9)
        XCTAssertEqual(buffer.drain().frames.map { $0.timeMs }, [0, 3, 4, 5, 6, 7, 8, 9, 10])
    }

    func testOverflowOfOnlyPMsStillBoundsMemory() {
        var buffer = FrameBuffer(cap: 10)
        for i in 0...10 {
            buffer.append("PRI {\"character\":\"P\",\"message\":\"\(i)\"}", timeMs: i)
        }
        XCTAssertEqual(buffer.count, 9)
        XCTAssertEqual(buffer.drain().frames.first?.timeMs, 2)
    }
}
