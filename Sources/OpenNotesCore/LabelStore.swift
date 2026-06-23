import Foundation

/// Persists the user's known labels to `~/.hasna/apps/notes/labels.json`.
/// Note-label assignment itself lives in each note's `labels` frontmatter; this file
/// preserves labels that currently have no notes and keeps rename/delete lightweight.
public struct LabelStore {
    public let fileURL: URL

    public init(root: URL? = nil) {
        let resolvedRoot = root ?? FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".hasna", isDirectory: true)
            .appendingPathComponent("apps", isDirectory: true)
            .appendingPathComponent("notes", isDirectory: true)
        self.fileURL = resolvedRoot.appendingPathComponent("labels.json")
    }

    private struct Payload: Codable { var labels: [String] }

    public func load() -> [String] {
        guard let data = try? Data(contentsOf: fileURL),
              let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
            return []
        }
        return LabelStore.normalized(payload.labels)
    }

    public func save(_ labels: [String]) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(Payload(labels: LabelStore.normalized(labels)))
        try data.write(to: fileURL, options: .atomic)
    }

    public static func normalized(_ labels: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in labels {
            let label = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty else { continue }
            let key = label.lowercased()
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            out.append(label)
        }
        return out
    }
}
