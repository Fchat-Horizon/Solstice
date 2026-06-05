import Foundation
import Compression

// Minimal PKZIP writer producing a *flat* archive whose entry paths are relative to the
// source directory — byte-compatible with the Android export (java.util.zip) and the
// AdmZip reader used by AppExporterDialog.vue. Apple's NSFileCoordinator(.forUploading)
// zip is deliberately avoided because it nests everything under a wrapper folder, which
// would break the importer's mobile/PC format detection.
//
// Entries use DEFLATE (method 8) when that is smaller, otherwise STORED (method 0).
enum ZipArchive {
    static func zip(directory: URL, to destination: URL) throws {
        let fm = FileManager.default
        var output = Data()
        var central = Data()
        var entryCount: UInt16 = 0
        let (dosTime, dosDate) = dosDateTime(Date())

        let basePath = directory.standardizedFileURL.path
        let files = regularFiles(under: directory, fm: fm).sorted { $0.path < $1.path }

        for fileURL in files {
            let fileData = (try? Data(contentsOf: fileURL)) ?? Data()
            var rel = fileURL.standardizedFileURL.path
            if rel.hasPrefix(basePath) { rel.removeFirst(basePath.count) }
            while rel.hasPrefix("/") { rel.removeFirst() }
            guard !rel.isEmpty, let nameData = rel.data(using: .utf8) else { continue }

            let crc = crc32(fileData)
            var method: UInt16 = 0
            var payload = fileData
            if !fileData.isEmpty, let deflated = deflate(fileData), deflated.count < fileData.count {
                method = 8
                payload = deflated
            }

            let localOffset = UInt32(output.count)

            // Local file header (0x04034b50)
            output.appendLE(UInt32(0x04034b50))
            output.appendLE(UInt16(20))                 // version needed
            output.appendLE(UInt16(0x0800))             // flags: UTF-8 names
            output.appendLE(method)
            output.appendLE(dosTime)
            output.appendLE(dosDate)
            output.appendLE(crc)
            output.appendLE(UInt32(payload.count))      // compressed size
            output.appendLE(UInt32(fileData.count))     // uncompressed size
            output.appendLE(UInt16(nameData.count))
            output.appendLE(UInt16(0))                  // extra length
            output.append(nameData)
            output.append(payload)

            // Central directory header (0x02014b50)
            central.appendLE(UInt32(0x02014b50))
            central.appendLE(UInt16(20))                // version made by
            central.appendLE(UInt16(20))                // version needed
            central.appendLE(UInt16(0x0800))
            central.appendLE(method)
            central.appendLE(dosTime)
            central.appendLE(dosDate)
            central.appendLE(crc)
            central.appendLE(UInt32(payload.count))
            central.appendLE(UInt32(fileData.count))
            central.appendLE(UInt16(nameData.count))
            central.appendLE(UInt16(0))                 // extra length
            central.appendLE(UInt16(0))                 // comment length
            central.appendLE(UInt16(0))                 // disk number start
            central.appendLE(UInt16(0))                 // internal attributes
            central.appendLE(UInt32(0))                 // external attributes
            central.appendLE(localOffset)
            central.append(nameData)

            entryCount += 1
        }

        let centralOffset = UInt32(output.count)
        output.append(central)

        // End of central directory (0x06054b50)
        output.appendLE(UInt32(0x06054b50))
        output.appendLE(UInt16(0))                      // disk number
        output.appendLE(UInt16(0))                      // disk with central dir
        output.appendLE(entryCount)
        output.appendLE(entryCount)
        output.appendLE(UInt32(central.count))
        output.appendLE(centralOffset)
        output.appendLE(UInt16(0))                      // comment length

        try output.write(to: destination)
    }

    private static func regularFiles(under directory: URL, fm: FileManager) -> [URL] {
        guard let enumerator = fm.enumerator(at: directory, includingPropertiesForKeys: [.isRegularFileKey]) else { return [] }
        var result: [URL] = []
        for case let url as URL in enumerator {
            if (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true {
                result.append(url)
            }
        }
        return result
    }

    private static func deflate(_ data: Data) -> Data? {
        let dstCap = data.count + 64
        var dst = Data(count: dstCap)
        let written = dst.withUnsafeMutableBytes { (dstRaw: UnsafeMutableRawBufferPointer) -> Int in
            data.withUnsafeBytes { (srcRaw: UnsafeRawBufferPointer) -> Int in
                // COMPRESSION_ZLIB emits a raw DEFLATE stream (RFC 1951) — exactly what
                // ZIP method 8 expects (no zlib header/trailer).
                compression_encode_buffer(
                    dstRaw.bindMemory(to: UInt8.self).baseAddress!, dstCap,
                    srcRaw.bindMemory(to: UInt8.self).baseAddress!, data.count,
                    nil, COMPRESSION_ZLIB)
            }
        }
        guard written > 0 else { return nil }
        return Data(dst.prefix(written))
    }

    private static let crcTable: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1) }
        return c
    }

    private static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for b in data { crc = crcTable[Int((crc ^ UInt32(b)) & 0xFF)] ^ (crc >> 8) }
        return crc ^ 0xFFFFFFFF
    }

    private static func dosDateTime(_ date: Date) -> (UInt16, UInt16) {
        let c = Calendar(identifier: .gregorian)
            .dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        // Explicit Int locals — folding all of this into the UInt16(...) initialisers makes
        // Swift's type-checker time out (error: unable to type-check in reasonable time).
        let year: Int = max(1980, c.year ?? 1980)
        let month: Int = c.month ?? 1
        let day: Int = c.day ?? 1
        let hour: Int = c.hour ?? 0
        let minute: Int = c.minute ?? 0
        let second: Int = c.second ?? 0
        let time: Int = (hour << 11) | (minute << 5) | (second / 2)
        let dosDate: Int = ((year - 1980) << 9) | (month << 5) | day
        return (UInt16(truncatingIfNeeded: time), UInt16(truncatingIfNeeded: dosDate))
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
