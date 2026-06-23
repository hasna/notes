import Foundation

/// Lifecycle status of a note. Mirrors the open-notes / @hasna/notes catalog vocabulary.
public enum NoteStatus: String, CaseIterable, Identifiable, Codable {
    case inbox
    case active
    case reviewed
    case promoted
    case archived
    case trash
    case stale

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .inbox: return "Inbox"
        case .active: return "Active"
        case .reviewed: return "Reviewed"
        case .promoted: return "Promoted"
        case .archived: return "Archived"
        case .trash: return "Trash"
        case .stale: return "Stale"
        }
    }

    public var symbol: String {
        switch self {
        case .inbox: return "tray"
        case .active: return "bolt"
        case .reviewed: return "checkmark.seal"
        case .promoted: return "star"
        case .archived: return "archivebox"
        case .trash: return "trash"
        case .stale: return "hourglass"
        }
    }
}

/// How the current title was chosen. Stored in frontmatter so generated titles can be
/// refreshed when the note body changes without overwriting explicit user names.
public enum NoteTitleSource: String, Codable {
    case defaultTitle = "default"
    case generated
    case manual
}

/// A single note. The markdown file on disk is the source of truth.
public struct Note: Identifiable, Equatable {
    /// Provenance marker written into every note's `agent` frontmatter field for notes
    /// created/edited by this app. Old files carrying the legacy `open-notes-app` value
    /// still parse — see `MarkdownStore.parse`.
    public static let appAgent = "hasna-notes-app"

    public var id: UUID
    public var title: String
    /// User-facing labels. Legacy `tags` frontmatter still parses into this field.
    public var labels: [String]
    public var status: NoteStatus
    /// Optional folder assignment. Empty string means "no folder" (the default).
    public var folder: String
    /// Canonical body format. Existing plain-text bodies remain valid Markdown.
    public var contentFormat: String
    public var titleLocked: Bool
    public var titleSource: NoteTitleSource
    /// Stable fingerprint of the body/transcript prefix used for the last generated title.
    public var titleContentFingerprint: String
    public var createdAt: Date
    public var updatedAt: Date
    public var author: String
    public var agent: String
    public var machine: String
    public var createdByActorType: String
    public var createdByName: String
    public var sourceMachine: String
    public var sourceMachineFriendlyName: String
    public var originMachine: String
    public var originMachineFriendlyName: String
    public var targetMachineFriendlyName: String
    public var previousMachine: String
    public var openedFrom: String
    public var sourceContext: String
    public var archivedAt: Date?
    public var trashedAt: Date?
    public var trashMachine: String
    public var trashExpiresAt: Date?
    public var restoredAt: Date?
    public var movedAt: Date?
    public var body: String

    public init(
        id: UUID = UUID(),
        title: String = "Untitled Note",
        labels: [String] = [],
        status: NoteStatus = .active,
        folder: String = "",
        contentFormat: String = "markdown",
        titleLocked: Bool = false,
        titleSource: NoteTitleSource? = nil,
        titleContentFingerprint: String = "",
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        author: String = Note.currentAuthor,
        agent: String = Note.appAgent,
        machine: String = Note.currentMachine,
        createdByActorType: String = "human",
        createdByName: String = Note.currentAuthor,
        sourceMachine: String = Note.currentMachine,
        sourceMachineFriendlyName: String = "",
        originMachine: String? = nil,
        originMachineFriendlyName: String = "",
        targetMachineFriendlyName: String = "",
        previousMachine: String = "",
        openedFrom: String = "",
        sourceContext: String = "",
        archivedAt: Date? = nil,
        trashedAt: Date? = nil,
        trashMachine: String = "",
        trashExpiresAt: Date? = nil,
        restoredAt: Date? = nil,
        movedAt: Date? = nil,
        body: String = ""
    ) {
        self.id = id
        self.title = title
        self.labels = labels
        self.status = status
        self.folder = folder
        self.contentFormat = "markdown"
        self.titleLocked = titleLocked
        self.titleSource = titleSource ?? (Note.isDefaultTitle(title) ? .defaultTitle : .manual)
        self.titleContentFingerprint = titleContentFingerprint
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.author = author
        self.agent = agent
        self.machine = machine
        self.createdByActorType = createdByActorType
        self.createdByName = createdByName
        self.sourceMachine = sourceMachine
        self.sourceMachineFriendlyName = sourceMachineFriendlyName
        self.originMachine = originMachine ?? machine
        self.originMachineFriendlyName = originMachineFriendlyName
        self.targetMachineFriendlyName = targetMachineFriendlyName
        self.previousMachine = previousMachine
        self.openedFrom = openedFrom
        self.sourceContext = sourceContext
        self.archivedAt = archivedAt
        self.trashedAt = trashedAt
        self.trashMachine = trashMachine
        self.trashExpiresAt = trashExpiresAt
        self.restoredAt = restoredAt
        self.movedAt = movedAt
        self.body = body
    }

    public init(
        id: UUID = UUID(),
        title: String = "Untitled Note",
        tags: [String],
        status: NoteStatus = .active,
        folder: String = "",
        contentFormat: String = "markdown",
        titleLocked: Bool = false,
        titleSource: NoteTitleSource? = nil,
        titleContentFingerprint: String = "",
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        author: String = Note.currentAuthor,
        agent: String = Note.appAgent,
        machine: String = Note.currentMachine,
        createdByActorType: String = "human",
        createdByName: String = Note.currentAuthor,
        sourceMachine: String = Note.currentMachine,
        sourceMachineFriendlyName: String = "",
        originMachine: String? = nil,
        originMachineFriendlyName: String = "",
        targetMachineFriendlyName: String = "",
        previousMachine: String = "",
        openedFrom: String = "",
        sourceContext: String = "",
        archivedAt: Date? = nil,
        trashedAt: Date? = nil,
        trashMachine: String = "",
        trashExpiresAt: Date? = nil,
        restoredAt: Date? = nil,
        movedAt: Date? = nil,
        body: String = ""
    ) {
        self.init(
            id: id,
            title: title,
            labels: tags,
            status: status,
            folder: folder,
            contentFormat: contentFormat,
            titleLocked: titleLocked,
            titleSource: titleSource,
            titleContentFingerprint: titleContentFingerprint,
            createdAt: createdAt,
            updatedAt: updatedAt,
            author: author,
            agent: agent,
            machine: machine,
            createdByActorType: createdByActorType,
            createdByName: createdByName,
            sourceMachine: sourceMachine,
            sourceMachineFriendlyName: sourceMachineFriendlyName,
            originMachine: originMachine,
            originMachineFriendlyName: originMachineFriendlyName,
            targetMachineFriendlyName: targetMachineFriendlyName,
            previousMachine: previousMachine,
            openedFrom: openedFrom,
            sourceContext: sourceContext,
            archivedAt: archivedAt,
            trashedAt: trashedAt,
            trashMachine: trashMachine,
            trashExpiresAt: trashExpiresAt,
            restoredAt: restoredAt,
            movedAt: movedAt,
            body: body
        )
    }

    /// Temporary source/back-compat alias for older call sites and bridge payloads.
    public var tags: [String] {
        get { labels }
        set { labels = newValue }
    }

    /// A short snippet derived from the body, for the list view.
    public var snippet: String {
        let trimmed = body
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "No additional text" }
        return String(trimmed.prefix(120))
    }

    public static var currentAuthor: String {
        NSUserName().isEmpty ? "unknown" : NSUserName()
    }

    public static var currentMachine: String {
        let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        return name.isEmpty ? "unknown" : name
    }

    public static let defaultTitles: Set<String> = ["", "New Note", "Untitled Note"]

    public static func isDefaultTitle(_ value: String) -> Bool {
        defaultTitles.contains(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Text used by the title generator. A prefix is enough for short titles and keeps
    /// request cost bounded for long recordings.
    public var titleCandidateText: String {
        Note.markdownPlainText(body)
    }

    public var currentTitleFingerprint: String {
        Note.contentFingerprint(titleCandidateText)
    }

    public var isInTrash: Bool { status == .trash }

    public func isTrashExpired(referenceDate: Date = Date()) -> Bool {
        guard status == .trash, let trashExpiresAt else { return false }
        return trashExpiresAt <= referenceDate
    }

    public var shouldGenerateTitle: Bool {
        guard !titleLocked else { return false }
        guard !titleCandidateText.isEmpty else { return false }
        if Note.isDefaultTitle(title) { return true }
        return titleSource == .generated && titleContentFingerprint != currentTitleFingerprint
    }

    /// Stable FNV-1a fingerprint over the first part of the source text.
    public static func contentFingerprint(_ text: String, maxScalars: Int = 4000) -> String {
        let limited = String(text.unicodeScalars.prefix(maxScalars))
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in limited.utf8 {
            hash ^= UInt64(byte)
            hash &*= 0x100000001b3
        }
        return String(hash, radix: 16)
    }

    public static func markdownPlainText(_ markdown: String) -> String {
        var text = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        text = text.replacingOccurrences(
            of: #"```[^\n]*\n?([\s\S]*?)\n?```"#,
            with: "$1",
            options: .regularExpression
        )
        text = text.replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"!\[([^\]]*)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?is)<(script|style)\b[^>]*>[\s\S]*?</\1>"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"<!--[\s\S]*?-->"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"<[^>\n]+>"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^#{1,6}\s+"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^\s{0,3}>\s?"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^\s*[-*+]\s+\[[ xX]\]\s+"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^\s*[-*+]\s+"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^\s*\d+[.)]\s+"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^\s*---+\s*$"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"[*_~#]+"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\\([\\`*_{}\[\]()#+\-.!>|])"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
