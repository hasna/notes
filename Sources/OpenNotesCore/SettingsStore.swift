import Foundation

public struct NotesSettings: Equatable, Codable {
    public static let defaultTrashRetentionDays = 30

    public var trashRetentionDays: Int

    public init(trashRetentionDays: Int = NotesSettings.defaultTrashRetentionDays) {
        self.trashRetentionDays = max(1, trashRetentionDays)
    }
}

public struct SettingsStore {
    public let url: URL

    public init(root: URL? = nil) {
        let resolvedRoot = root ?? FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".hasna", isDirectory: true)
            .appendingPathComponent("apps", isDirectory: true)
            .appendingPathComponent("notes", isDirectory: true)
        self.url = resolvedRoot.appendingPathComponent("settings.json")
    }

    public func load() -> NotesSettings {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(NotesSettings.self, from: data) else {
            return NotesSettings()
        }
        return NotesSettings(trashRetentionDays: decoded.trashRetentionDays)
    }

    public func save(_ settings: NotesSettings) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder.sortedPrettyPrinted.encode(settings)
        try data.write(to: url, options: .atomic)
    }
}

private extension JSONEncoder {
    static var sortedPrettyPrinted: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}
