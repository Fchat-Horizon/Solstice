import Foundation

// Mirrors Storage.kt (DataRoot). Resolves where per-character data lives (`<character>/logs/*` and the
// `<character>/<key>` settings files): the user-chosen external folder when the "external data folder"
// option is enabled and the folder is reachable, otherwise Application Support. Root-level entries
// ('!settings', '!crashlog', '.import.tmp') always stay internal. NativeFile and NativeLogs resolve
// every path through here, so Device Sync, the backup importer and export follow the setting too.
//
// The folder comes from a document picker. Its bookmark is persisted in UserDefaults and its
// security scope is held open for the life of the process.
final class DataRoot {
    static let shared = DataRoot()

    private let enabledKey = "externalDataEnabled"
    private let bookmarkKey = "externalDataBookmark"
    private let nameKey = "externalDataName"
    private let defaults = UserDefaults.standard
    private let lock = NSLock()

    let internalRoot: URL
    private var externalURL: URL?
    private var externalScoped = false
    private var resolved = false

    private init() {
        let fm = FileManager.default
        internalRoot = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        try? fm.createDirectory(at: internalRoot, withIntermediateDirectories: true)
    }

    var isEnabled: Bool { defaults.bool(forKey: enabledKey) }

    /// The external folder with its security scope open, or nil when none is set or it can't be reached.
    var externalRoot: URL? {
        lock.lock()
        defer { lock.unlock() }
        if !resolved {
            resolved = true
            resolveBookmark()
        }
        guard let url = externalURL, isDirectory(url) else { return nil }
        return url
    }

    var root: URL { isEnabled ? (externalRoot ?? internalRoot) : internalRoot }

    func resolve(_ name: String) -> URL {
        var n = name
        while n.hasPrefix("/") { n.removeFirst() }
        if n.isEmpty { return internalRoot }
        if n.hasPrefix("!") || n.hasPrefix(".") { return internalRoot.appendingPathComponent(n) }
        return root.appendingPathComponent(n)
    }

    func status() -> [String: Any] {
        let available = externalRoot != nil
        return [
            "enabled": isEnabled,
            "path": defaults.string(forKey: nameKey) ?? NSNull(),
            "available": available
        ]
    }

    /// Adopts a folder picked by the user. Returns an error message, or nil on success.
    func setFolder(_ url: URL) -> String? {
        let scoped = url.startAccessingSecurityScopedResource()
        guard isWritable(url) else {
            if scoped { url.stopAccessingSecurityScopedResource() }
            return "Solstice can't write to that folder."
        }
        guard let bookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) else {
            if scoped { url.stopAccessingSecurityScopedResource() }
            return "Solstice couldn't keep access to that folder."
        }
        lock.lock()
        if externalScoped { externalURL?.stopAccessingSecurityScopedResource() }
        externalURL = url
        externalScoped = scoped
        resolved = true
        lock.unlock()
        defaults.set(bookmark, forKey: bookmarkKey)
        defaults.set(url.lastPathComponent, forKey: nameKey)
        return nil
    }

    /// Returns false when enabling without a usable folder.
    func setEnabled(_ enabled: Bool) -> Bool {
        if enabled && externalRoot == nil { return false }
        defaults.set(enabled, forKey: enabledKey)
        return true
    }

    /// Copies every character directory between app storage and the external folder. With
    /// overwrite=false a file is skipped when the destination already has it, or its log counterpart
    /// (`<key>` vs `<key>.idx`), so a data file and its index are never mixed from two sources.
    func copyData(toExternal: Bool, overwrite: Bool) -> [String: Any] {
        guard let external = externalRoot else { return ["error": "The external folder is not available."] }
        let src = toExternal ? internalRoot : external
        let dst = toExternal ? external : internalRoot
        var copied = 0
        var skipped = 0
        if src.standardizedFileURL.path != dst.standardizedFileURL.path {
            for dir in children(src) where isDirectory(dir) {
                let name = dir.lastPathComponent
                if name.hasPrefix(".") || name.hasPrefix("!") { continue }
                copyDir(dir, to: dst.appendingPathComponent(name), overwrite: overwrite,
                        copied: &copied, skipped: &skipped)
            }
        }
        return ["copied": copied, "skipped": skipped]
    }

    // MARK: - Helpers

    // Caller holds the lock.
    private func resolveBookmark() {
        guard let data = defaults.data(forKey: bookmarkKey) else { return }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil,
                                 bookmarkDataIsStale: &stale) else { return }
        externalScoped = url.startAccessingSecurityScopedResource()
        externalURL = url
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            defaults.set(fresh, forKey: bookmarkKey)
        }
    }

    private func copyDir(_ src: URL, to dst: URL, overwrite: Bool, copied: inout Int, skipped: inout Int) {
        let fm = FileManager.default
        try? fm.createDirectory(at: dst, withIntermediateDirectories: true)
        for item in children(src) {
            let name = item.lastPathComponent
            if name.hasPrefix(".") { continue }
            let target = dst.appendingPathComponent(name)
            if isDirectory(item) {
                copyDir(item, to: target, overwrite: overwrite, copied: &copied, skipped: &skipped)
                continue
            }
            let base = name.hasSuffix(".idx") ? String(name.dropLast(4)) : name
            if !overwrite && (fm.fileExists(atPath: dst.appendingPathComponent(base).path)
                              || fm.fileExists(atPath: dst.appendingPathComponent(base + ".idx").path)) {
                skipped += 1
                continue
            }
            try? fm.removeItem(at: target)
            if (try? fm.copyItem(at: item, to: target)) != nil { copied += 1 }
        }
    }

    private func children(_ url: URL) -> [URL] {
        (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
    }

    private func isDirectory(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    private func isWritable(_ url: URL) -> Bool {
        let probe = url.appendingPathComponent(".solstice-write-test")
        guard (try? Data().write(to: probe)) != nil else { return false }
        try? FileManager.default.removeItem(at: probe)
        return true
    }
}
