import Foundation

/// Persists the user's folder list to `~/.hasna/apps/notes/folders.json` so that
/// folders created in the UI — including empty ones with no notes yet — survive
/// relaunch. Note↔folder assignment itself lives in each note's `folder` frontmatter;
/// this file only tracks the set of known folder names and their order.
public struct FolderStore {
    public let fileURL: URL

    /// Defaults to `<root>/folders.json` where root is `~/.hasna/apps/notes/`.
    public init(root: URL? = nil) {
        let resolvedRoot = root ?? FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".hasna", isDirectory: true)
            .appendingPathComponent("apps", isDirectory: true)
            .appendingPathComponent("notes", isDirectory: true)
        self.fileURL = resolvedRoot.appendingPathComponent("folders.json")
    }

    private struct Payload: Codable { var folders: [String] }

    /// Load the persisted folder names (order preserved). Returns [] if the file is
    /// absent or unreadable.
    public func load() -> [String] {
        guard let data = try? Data(contentsOf: fileURL),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
            return []
        }
        return payload.folders
    }

    /// Persist the folder names atomically. De-duplicates while preserving first-seen order.
    public func save(_ folders: [String]) throws {
        var seen = Set<String>()
        let unique = folders.filter { name in
            let key = name
            if name.isEmpty || seen.contains(key) { return false }
            seen.insert(key)
            return true
        }
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(Payload(folders: unique))
        try data.write(to: fileURL, options: .atomic)
    }
}
