import OpenNotesCore
import Foundation
import SwiftUI

/// Sidebar filter selection. Status filtering is intentionally NOT here — the sidebar
/// surfaces Library / Folders / Labels / Machines. Status is edited per-note in the
/// editor settings popover.
enum Filter: Hashable {
    case all
    case archive
    case trash
    case folder(String)
    case label(String)
    case machine(String)     // a specific machine id
    case allMachines
    case thisMachine
}

/// Sync activity state surfaced to the UI.
enum SyncState: Equatable {
    case idle
    case syncing
    case synced(Date)
    case failed(String)
}

struct MachineDisplay: Identifiable {
    var id: String
    var slug: String?
    var displayName: String
    var friendlyName: String?
    var sshAddress: String?
    var platform: String?
    var status: String?
    var online: Bool?
    var source: String?
    var origin: String?
    var noteCount: Int
    var activeNoteCount: Int
    var archivedNoteCount: Int
    var trashNoteCount: Int
    var totalNoteCount: Int
    var updatedAt: Date?
    var lastSeenAt: Date?
    var syncedAt: Date?
    var recentActivityAt: Date?
    var latestNoteUpdatedAt: Date?
    var capabilities: [String]
    var metadata: [String: Any]
    var provenance: [String: Any]
    var sync: [String: Any]
}

struct ListPage<Element> {
    var items: [Element]
    var limit: Int
    var total: Int
    var hasMore: Bool { items.count < total }
}

/// Observable application state. Owns the in-memory notes and bridges to `MarkdownStore`,
/// `FolderStore`, the fleet manifest, and `FleetSync`.
@MainActor
final class NotesStore: ObservableObject {
    static let defaultListLimit = 10

    @Published private(set) var notes: [Note] = []
    @Published var selection: UUID?
    @Published var filter: Filter = .all {
        didSet {
            guard oldValue != filter else { return }
            visibleNoteLimit = NotesStore.defaultListLimit
            normalizeSelectionForCurrentFilter()
        }
    }
    @Published var searchText: String = "" {
        didSet {
            guard oldValue != searchText else { return }
            visibleNoteLimit = NotesStore.defaultListLimit
            normalizeSelectionForCurrentFilter()
        }
    }
    @Published var loadError: String?
    @Published private(set) var visibleNoteLimit = NotesStore.defaultListLimit
    @Published private(set) var visibleMachineLimit = NotesStore.defaultListLimit

    /// User-managed folder list (persisted), independent of which notes reference them.
    @Published private(set) var folders: [String] = []
    /// User-managed label list (persisted), independent of which notes reference them.
    @Published private(set) var labels: [String] = []
    /// Fleet machines (for the Machines sidebar section + sync).
    @Published private(set) var fleet: [FleetMachine] = []
    @Published private(set) var settings: NotesSettings = NotesSettings()
    @Published var syncState: SyncState = .idle

    private let store: MarkdownStore
    private let folderStore: FolderStore
    private let labelStore: LabelStore
    private let settingsStore: SettingsStore
    let localMachineID: String

    init(store: MarkdownStore = MarkdownStore(), folderStore: FolderStore? = nil, labelStore: LabelStore? = nil, settingsStore: SettingsStore? = nil) {
        self.store = store
        self.folderStore = folderStore ?? FolderStore(root: store.rootURL)
        self.labelStore = labelStore ?? LabelStore(root: store.rootURL)
        self.settingsStore = settingsStore ?? SettingsStore(root: store.rootURL)
        self.localMachineID = Note.currentMachine
        load()
        folders = self.folderStore.load()
        labels = self.labelStore.load()
        settings = self.settingsStore.load()
        fleet = FleetManifest.load()
    }

    // MARK: - Loading

    func load() {
        do {
            notes = try store.loadAll()
            loadError = nil
            normalizeSelectionForCurrentFilter()
        } catch {
            loadError = error.localizedDescription
            notes = []
            selection = nil
        }
    }

    // MARK: - Derived collections

    /// All labels across persisted labels and notes, sorted and de-duplicated.
    var allLabels: [String] {
        var set = Set(notes.flatMap { $0.labels })
        for label in labels where !label.isEmpty { set.insert(label) }
        return set.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    /// Distinct folders that appear in notes, unioned with the persisted folder list so
    /// empty folders still show. Sorted case-insensitively.
    var allFolders: [String] {
        var set = Set(notes.map { $0.folder }.filter { !$0.isEmpty })
        for f in folders where !f.isEmpty { set.insert(f) }
        return set.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    /// Distinct machines that own at least one note (from the `machine` frontmatter).
    var noteMachines: [String] {
        let set = Set(notes.map { $0.machine }.filter { !$0.isEmpty })
        return set.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    var machineDisplays: [MachineDisplay] {
        var byID: [String: MachineDisplay] = [:]
        var aliasToID: [String: String] = [:]
        for machine in fleet {
            byID[machine.id] = MachineDisplay(
                id: machine.id,
                slug: machine.slug,
                displayName: machine.displayName,
                friendlyName: machine.friendlyName,
                sshAddress: machine.sshAddress,
                platform: machine.platform,
                status: machine.status ?? (machine.online == true ? "online" : (machine.online == false ? "offline" : "unknown")),
                online: machine.online,
                source: machine.source,
                origin: machine.origin,
                noteCount: 0,
                activeNoteCount: 0,
                archivedNoteCount: 0,
                trashNoteCount: 0,
                totalNoteCount: 0,
                updatedAt: machine.updatedAt,
                lastSeenAt: machine.lastSeenAt,
                syncedAt: machine.syncedAt,
                recentActivityAt: machine.recentActivityAt,
                latestNoteUpdatedAt: nil,
                capabilities: machine.capabilities,
                metadata: machine.metadata,
                provenance: machine.provenance,
                sync: machine.sync
            )
            aliasToID[machine.id] = machine.id
            if let slug = machine.slug, !slug.isEmpty {
                aliasToID[slug] = machine.id
            }
            if let friendlyName = machine.friendlyName, !friendlyName.isEmpty {
                aliasToID[friendlyName] = machine.id
            }
            if !machine.displayName.isEmpty {
                aliasToID[machine.displayName] = machine.id
            }
        }
        for note in notes where !note.machine.isEmpty {
            let canonicalID = aliasToID[note.machine] ?? note.machine
            var current = byID[canonicalID] ?? MachineDisplay(
                id: canonicalID,
                slug: canonicalID,
                displayName: canonicalID,
                friendlyName: nil,
                sshAddress: nil,
                platform: nil,
                status: "unknown",
                online: nil,
                source: "notes",
                origin: nil,
                noteCount: 0,
                activeNoteCount: 0,
                archivedNoteCount: 0,
                trashNoteCount: 0,
                totalNoteCount: 0,
                updatedAt: nil,
                lastSeenAt: nil,
                syncedAt: nil,
                recentActivityAt: nil,
                latestNoteUpdatedAt: nil,
                capabilities: [],
                metadata: [:],
                provenance: [:],
                sync: [:]
            )
            current.totalNoteCount += 1
            switch note.status {
            case .archived:
                current.archivedNoteCount += 1
            case .trash:
                current.trashNoteCount += 1
            default:
                current.noteCount += 1
                current.activeNoteCount += 1
            }
            if current.updatedAt == nil || note.updatedAt > (current.updatedAt ?? .distantPast) {
                current.updatedAt = note.updatedAt
            }
            if current.latestNoteUpdatedAt == nil || note.updatedAt > (current.latestNoteUpdatedAt ?? .distantPast) {
                current.latestNoteUpdatedAt = note.updatedAt
            }
            current.recentActivityAt = [current.recentActivityAt, current.syncedAt, current.lastSeenAt, current.updatedAt, current.latestNoteUpdatedAt]
                .compactMap { $0 }
                .max()
            byID[canonicalID] = current
            aliasToID[note.machine] = canonicalID
        }
        let localCanonicalID = aliasToID[localMachineID] ?? localMachineID
        if byID[localCanonicalID] == nil {
            byID[localCanonicalID] = MachineDisplay(
                id: localCanonicalID,
                slug: localCanonicalID,
                displayName: localCanonicalID,
                friendlyName: nil,
                sshAddress: nil,
                platform: nil,
                status: "unknown",
                online: nil,
                source: "notes",
                origin: nil,
                noteCount: 0,
                activeNoteCount: 0,
                archivedNoteCount: 0,
                trashNoteCount: 0,
                totalNoteCount: 0,
                updatedAt: nil,
                lastSeenAt: nil,
                syncedAt: nil,
                recentActivityAt: nil,
                latestNoteUpdatedAt: nil,
                capabilities: [],
                metadata: [:],
                provenance: [:],
                sync: [:]
            )
        }
        return byID.values.sorted {
            let lhs = $0.recentActivityAt ?? $0.updatedAt ?? .distantPast
            let rhs = $1.recentActivityAt ?? $1.updatedAt ?? .distantPast
            if lhs != rhs { return lhs > rhs }
            return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    /// The most-recently-updated note's timestamp, for the header line.
    var lastUpdated: Date? {
        notes.map(\.updatedAt).max()
    }

    /// Notes matching the active filter and search query, before pagination.
    var filteredNotes: [Note] {
        notes.filter { matchesFilter($0) && matchesSearch($0) }
    }

    /// Notes matching the active filter and search query, latest 10 by default.
    var visibleNotes: [Note] {
        Array(filteredNotes.prefix(visibleNoteLimit))
    }

    var visibleNotesPage: ListPage<Note> {
        ListPage(items: visibleNotes, limit: visibleNoteLimit, total: filteredNotes.count)
    }

    var visibleMachinesPage: ListPage<MachineDisplay> {
        ListPage(
            items: Array(machineDisplays.prefix(visibleMachineLimit)),
            limit: visibleMachineLimit,
            total: machineDisplays.count
        )
    }

    func machineDetails(id: String) -> MachineDisplay? {
        let needle = id.trimmingCharacters(in: .whitespacesAndNewlines)
        return machineDisplays.first {
            $0.id == needle ||
            $0.slug == needle ||
            $0.friendlyName == needle ||
            $0.displayName == needle
        }
    }

    private func matchesFilter(_ note: Note) -> Bool {
        switch filter {
        case .all: return note.status != .archived && note.status != .trash
        case .archive: return note.status == .archived
        case .trash: return note.status == .trash
        case .folder(let f): return note.folder == f
        case .label(let t): return note.labels.contains(t)
        case .machine(let m): return noteMatchesMachine(note, machineID: m) && note.status != .archived && note.status != .trash
        case .allMachines: return note.status != .archived && note.status != .trash
        case .thisMachine: return noteMatchesMachine(note, machineID: localMachineID) && note.status != .archived && note.status != .trash
        }
    }

    private func matchesSearch(_ note: Note) -> Bool {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return true }
        if note.title.localizedCaseInsensitiveContains(q) { return true }
        if note.body.localizedCaseInsensitiveContains(q) { return true }
        if note.labels.contains(where: { $0.localizedCaseInsensitiveContains(q) }) { return true }
        return false
    }

    var selectedNote: Note? {
        guard let id = selection else { return nil }
        guard let note = notes.first(where: { $0.id == id }) else { return nil }
        return matchesFilter(note) && matchesSearch(note) ? note : nil
    }

    func count(for filter: Filter) -> Int {
        notes.filter {
            switch filter {
            case .all: return $0.status != .archived && $0.status != .trash
            case .archive: return $0.status == .archived
            case .trash: return $0.status == .trash
            case .folder(let f): return $0.folder == f
            case .label(let t): return $0.labels.contains(t)
            case .machine(let m): return noteMatchesMachine($0, machineID: m) && $0.status != .archived && $0.status != .trash
            case .allMachines: return $0.status != .archived && $0.status != .trash
            case .thisMachine: return noteMatchesMachine($0, machineID: localMachineID) && $0.status != .archived && $0.status != .trash
            }
        }.count
    }

    private func canonicalMachineID(for machineID: String) -> String {
        let trimmed = machineID.trimmingCharacters(in: .whitespacesAndNewlines)
        return machineDetails(id: trimmed)?.id ?? trimmed
    }

    private func machineAliases(for machineID: String) -> Set<String> {
        let trimmed = machineID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        guard let machine = machineDetails(id: trimmed) else { return [trimmed] }
        return Set([trimmed, machine.id, machine.slug, machine.friendlyName, machine.displayName]
            .compactMap { $0 }
            .filter { !$0.isEmpty })
    }

    private func noteMatchesMachine(_ note: Note, machineID: String) -> Bool {
        machineAliases(for: machineID).contains(note.machine)
    }

    private func normalizeSelectionForCurrentFilter(preferred preferredID: UUID? = nil) {
        let matching = filteredNotes
        if let preferredID, matching.contains(where: { $0.id == preferredID }) {
            selection = preferredID
            return
        }
        if let selection, matching.contains(where: { $0.id == selection }) {
            return
        }
        selection = matching.first?.id
    }

    func selectMachine(_ machineID: String, preferredNoteID: UUID? = nil) {
        let target = canonicalMachineID(for: machineID)
        guard !target.isEmpty else { return }
        filter = .machine(target)
        searchText = ""
        visibleNoteLimit = NotesStore.defaultListLimit
        normalizeSelectionForCurrentFilter(preferred: preferredNoteID)
    }

    func selectThisMachine(preferredNoteID: UUID? = nil) {
        filter = .thisMachine
        searchText = ""
        visibleNoteLimit = NotesStore.defaultListLimit
        normalizeSelectionForCurrentFilter(preferred: preferredNoteID)
    }

    func selectAllMachines(preferredNoteID: UUID? = nil) {
        filter = .allMachines
        searchText = ""
        visibleNoteLimit = NotesStore.defaultListLimit
        normalizeSelectionForCurrentFilter(preferred: preferredNoteID)
    }

    func isLocalMachine(_ machine: MachineDisplay) -> Bool {
        let aliases = machineAliases(for: localMachineID)
        return aliases.contains(machine.id) ||
            aliases.contains(machine.slug ?? "") ||
            aliases.contains(machine.friendlyName ?? "") ||
            aliases.contains(machine.displayName)
    }

    func loadMoreNotes() {
        visibleNoteLimit += NotesStore.defaultListLimit
    }

    func loadMoreMachines() {
        visibleMachineLimit += NotesStore.defaultListLimit
    }

    // MARK: - Mutations

    @discardableResult
    func createNote() -> Note {
        // Inherit the current folder filter so a note made while viewing a folder lands in it.
        var folder = ""
        if case .folder(let f) = filter { folder = f }
        let note = Note(title: "New Note", status: .active, folder: folder, body: "")
        do {
            try store.save(note)
        } catch {
            loadError = error.localizedDescription
        }
        notes.insert(note, at: 0)
        selection = note.id
        if !matchesFilter(note) { filter = .all }
        searchText = ""
        return note
    }

    @discardableResult
    func duplicate(id: UUID) -> Note? {
        guard let original = notes.first(where: { $0.id == id }) else { return nil }
        var copy = original
        copy.id = UUID()
        copy.title = original.title.isEmpty ? "Untitled Note copy" : original.title + " copy"
        copy.createdAt = Date()
        copy.updatedAt = Date()
        copy.agent = Note.appAgent
        copy.machine = localMachineID
        do {
            try store.save(copy)
        } catch {
            loadError = error.localizedDescription
        }
        notes.insert(copy, at: 0)
        notes.sort { $0.updatedAt > $1.updatedAt }
        selection = copy.id
        return copy
    }

    /// Apply edited fields to the note with the given id, bump `updatedAt`, persist.
    func update(id: UUID, mutate: (inout Note) -> Void) {
        guard let index = notes.firstIndex(where: { $0.id == id }) else { return }
        var note = notes[index]
        mutate(&note)
        note.updatedAt = Date()
        notes[index] = note
        do {
            try store.save(note)
        } catch {
            loadError = error.localizedDescription
        }
        notes.sort { $0.updatedAt > $1.updatedAt }
        normalizeSelectionForCurrentFilter()
    }

    func delete(id: UUID) {
        guard let note = notes.first(where: { $0.id == id }) else { return }
        if note.status != .trash {
            trash(id: id)
            return
        }
        purge(id: id)
    }

    func purge(id: UUID) {
        guard let note = notes.first(where: { $0.id == id }) else { return }
        do {
            try store.delete(note)
        } catch {
            loadError = error.localizedDescription
        }
        notes.removeAll { $0.id == id }
        if selection == id {
            selection = visibleNotes.first?.id
        }
    }

    func archive(id: UUID) {
        update(id: id) {
            $0.status = .archived
            $0.archivedAt = Date()
            $0.trashedAt = nil
            $0.trashMachine = ""
            $0.trashExpiresAt = nil
        }
    }

    func trash(id: UUID) {
        update(id: id) {
            let now = Date()
            $0.status = .trash
            $0.trashedAt = now
            $0.trashMachine = $0.machine.isEmpty ? localMachineID : $0.machine
            $0.trashExpiresAt = Calendar.current.date(byAdding: .day, value: settings.trashRetentionDays, to: now)
        }
    }

    func restore(id: UUID) {
        update(id: id) {
            $0.status = .active
            $0.archivedAt = nil
            $0.trashedAt = nil
            $0.trashMachine = ""
            $0.trashExpiresAt = nil
            $0.restoredAt = Date()
        }
    }

    func move(id: UUID, toMachine machine: String, friendlyName: String? = nil) {
        let target = canonicalMachineID(for: machine)
        guard !target.isEmpty else { return }
        update(id: id) {
            if $0.originMachine.isEmpty { $0.originMachine = $0.machine }
            $0.previousMachine = $0.machine
            $0.machine = target
            $0.targetMachineFriendlyName = friendlyName ?? ""
            $0.movedAt = Date()
        }
        selectMachine(target, preferredNoteID: id)
    }

    func setStatus(id: UUID, to status: NoteStatus) {
        switch status {
        case .archived:
            archive(id: id)
        case .trash:
            trash(id: id)
        case .active:
            restore(id: id)
        default:
            update(id: id) {
                $0.status = status
                if $0.archivedAt != nil || $0.trashedAt != nil {
                    $0.archivedAt = nil
                    $0.trashedAt = nil
                    $0.trashMachine = ""
                    $0.trashExpiresAt = nil
                    $0.restoredAt = Date()
                }
            }
        }
    }

    func cleanupExpiredTrash(referenceDate: Date = Date()) {
        for note in notes where note.isTrashExpired(referenceDate: referenceDate) {
            purge(id: note.id)
        }
    }

    func setTrashRetentionDays(_ days: Int) {
        settings.trashRetentionDays = max(1, days)
        persistSettings()
    }

    private func persistSettings() {
        do { try settingsStore.save(settings) }
        catch { loadError = error.localizedDescription }
    }

    // MARK: - Folders

    func addFolder(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !folders.contains(trimmed) else { return }
        folders.append(trimmed)
        persistFolders()
    }

    func renameFolder(_ old: String, to new: String) {
        let trimmed = new.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, old != trimmed else { return }
        if let idx = folders.firstIndex(of: old) { folders[idx] = trimmed }
        else { folders.append(trimmed) }
        persistFolders()
        // Re-assign every note in the old folder.
        for note in notes where note.folder == old {
            update(id: note.id) { $0.folder = trimmed }
        }
        if case .folder(old) = filter { filter = .folder(trimmed) }
    }

    func deleteFolder(_ name: String) {
        folders.removeAll { $0 == name }
        persistFolders()
        // Notes in the deleted folder become folder-less (kept, not deleted).
        for note in notes where note.folder == name {
            update(id: note.id) { $0.folder = "" }
        }
        if case .folder(name) = filter { filter = .all }
    }

    private func persistFolders() {
        do { try folderStore.save(folders) }
        catch { loadError = error.localizedDescription }
    }

    // MARK: - Labels

    func addLabel(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !labels.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) else { return }
        labels.append(trimmed)
        persistLabels()
    }

    func renameLabel(_ old: String, to new: String) {
        let trimmed = new.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, old.caseInsensitiveCompare(trimmed) != .orderedSame else { return }
        if let idx = labels.firstIndex(where: { $0.caseInsensitiveCompare(old) == .orderedSame }) {
            labels[idx] = trimmed
        } else {
            labels.append(trimmed)
        }
        persistLabels()
        for note in notes where note.labels.contains(old) {
            update(id: note.id) {
                $0.labels = LabelStore.normalized($0.labels.map { $0 == old ? trimmed : $0 })
            }
        }
        if case .label(let current) = filter, current == old { filter = .label(trimmed) }
    }

    func deleteLabel(_ name: String) {
        labels.removeAll { $0.caseInsensitiveCompare(name) == .orderedSame }
        persistLabels()
        for note in notes where note.labels.contains(name) {
            update(id: note.id) { $0.labels.removeAll { $0 == name } }
        }
        if case .label(let current) = filter, current == name { filter = .all }
    }

    func assignLabel(_ label: String, to noteID: UUID) {
        addLabel(label)
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        update(id: noteID) {
            if !$0.labels.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
                $0.labels.append(trimmed)
            }
        }
    }

    func unassignLabel(_ label: String, from noteID: UUID) {
        update(id: noteID) {
            $0.labels.removeAll { $0.caseInsensitiveCompare(label) == .orderedSame }
        }
    }

    private func persistLabels() {
        do { try labelStore.save(labels) }
        catch { loadError = error.localizedDescription }
    }

    // MARK: - Sync

    /// Run a bidirectional fleet sync on a background queue, then reload the store so
    /// other machines' notes appear. Never blocks the UI.
    func syncFleet() {
        guard syncState != .syncing else { return }
        syncState = .syncing
        let snapshot = fleet
        let sync = FleetSync(localNotesDir: store.notesURL, localMachineID: localMachineID)
        Task.detached(priority: .utility) {
            let result = sync.sync(fleet: snapshot)
            await MainActor.run {
                self.load()
                self.fleet = FleetManifest.load()
                if result.errors.isEmpty {
                    self.syncState = .synced(Date())
                } else {
                    self.syncState = .failed(result.errors.joined(separator: "; "))
                }
            }
        }
    }
}
