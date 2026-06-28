// Hasna Notes — native macOS shell hosting the bundled web UI in a WKWebView.
//
// The UI itself lives in `web/` (copied into the app bundle at
// Contents/Resources/web). This shell:
//   1. opens a hidden-titlebar window and loads index.html offline (file://),
//   2. tags the document with the `native` body class so the web UI drops its
//      desktop-frame chrome and fills the OS window edge-to-edge, and
//   3. bridges REAL notes data between the on-disk Markdown store
//      (`OpenNotesCore.MarkdownStore`) and the web UI:
//        - reads the store + the fleet manifest at launch and injects
//          `window.__BOOT__ = { notes, machines, thisMachine }` as a
//          document-start user script (available before the page's JS runs),
//        - receives `{action, note}` messages on the `notes` message handler
//          (save / create / delete), writes them to disk, then pushes fresh
//          data back into the page via `window.HasnaNotes.hydrate(...)`.
import AppKit
import WebKit
import OpenNotesCore
import Foundation

// MARK: - AI sidecar

/// Spawns and supervises the bundled Node AI sidecar (`Resources/ai-sidecar/server.mjs`).
///
/// The sidecar provides note auto-titling (`/title`) and voice-note transcription
/// (`/transcribe`) via the Vercel AI SDK + OpenAI. The host:
///   - finds a `node` binary,
///   - picks a free loopback TCP port,
///   - reads the OpenAI key from `~/.secrets/hasnaxyz/openai/live.env` (or `OPENAI_API_KEY`),
///   - launches the child with `OPENAI_API_KEY`, `PORT`, and a per-run sidecar token,
///   - pipes child stdout/stderr to `NSLog` (prefix `Sidecar:`).
///
/// If node or the key is missing it simply doesn't spawn; `available` stays false and the
/// renderer disables AI features (it never crashes the app).
final class AISidecar {
    private(set) var port: Int = 0
    private(set) var running: Bool = false
    private(set) var available: Bool = false
    private(set) var realtimeAvailable: Bool = false
    private(set) var realtimeProvider: String = "openai"
    private(set) var token: String = UUID().uuidString + "-" + UUID().uuidString
    private var process: Process?

    /// Durable log file for sidecar output (port, request errors). NSLog visibility in the
    /// unified log is inconsistent across macOS releases, so we ALSO append here so the
    /// port and health are always recoverable: `~/Library/Logs/HasnaNotes/sidecar.log`.
    private static let logFileURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/HasnaNotes", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("sidecar.log")
    }()

    /// Append a line to both NSLog (prefixed `Sidecar:`) and the durable log file.
    private static func logLine(_ line: String) {
        let str = line.hasPrefix("Sidecar:") ? line : "Sidecar: " + line
        NSLog("%@", str)
        let stamped = ISO8601DateFormatter().string(from: Date()) + " " + str + "\n"
        if let data = stamped.data(using: .utf8) {
            if let handle = try? FileHandle(forWritingTo: logFileURL) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: logFileURL)
            }
        }
    }

    /// Candidate absolute node paths, then a PATH lookup via `/usr/bin/env`.
    private static func findNode() -> String? {
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        for p in candidates where FileManager.default.isExecutableFile(atPath: p) {
            return p
        }
        // Fall back to `env node` resolution.
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        which.arguments = ["node", "--version"]
        which.standardOutput = Pipe()
        which.standardError = Pipe()
        do {
            try which.run()
            which.waitUntilExit()
            if which.terminationStatus == 0 { return "/usr/bin/env" } // launch via env node
        } catch { /* not found */ }
        return nil
    }

    /// Read the OpenAI `sk-...` key from the canonical secrets env file, else the process env.
    private static func readKey() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let envFile = home.appendingPathComponent(".secrets/hasnaxyz/openai/live.env")
        if let text = try? String(contentsOf: envFile, encoding: .utf8) {
            // Match an sk-... token anywhere (handles KEY=value, quotes, export prefixes).
            if let range = text.range(of: "sk-[A-Za-z0-9_-]+", options: .regularExpression) {
                let key = String(text[range])
                if key.count > 20 { return key }
            }
        }
        if let env = ProcessInfo.processInfo.environment["OPENAI_API_KEY"], env.hasPrefix("sk-") {
            return env
        }
        return nil
    }

    private static func readElevenLabsKey() -> String? {
        if let env = ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"], !env.isEmpty {
            return env
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let envFile = home.appendingPathComponent(".secrets/hasnaxyz/elevenlabs/live.env")
        if let text = try? String(contentsOf: envFile, encoding: .utf8) {
            if let range = text.range(of: "[A-Za-z0-9_-]{20,}", options: .regularExpression) {
                return String(text[range])
            }
        }
        return nil
    }

    /// Bind a socket to port 0, read the OS-assigned port, close it, and return the number.
    /// There is an inherent (tiny) race between close and the child binding, acceptable here.
    private static func freePort() -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        let bound = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return nil }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        var assigned = sockaddr_in()
        let got = withUnsafeMutablePointer(to: &assigned) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.getsockname(fd, sa, &len)
            }
        }
        guard got == 0 else { return nil }
        return Int(UInt16(bigEndian: assigned.sin_port))
    }

    /// Locate `Resources/ai-sidecar/server.mjs` in the bundle.
    private static func serverScript() -> URL? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let script = res.appendingPathComponent("ai-sidecar/server.mjs")
        return FileManager.default.fileExists(atPath: script.path) ? script : nil
    }

    /// Start the sidecar. Returns immediately; sets `available`/`port` as a side effect.
    func start() {
        guard let script = AISidecar.serverScript() else {
            AISidecar.logLine("server.mjs not found in bundle — AI features disabled")
            available = false
            return
        }
        guard let node = AISidecar.findNode() else {
            AISidecar.logLine("no node binary found — AI features disabled")
            available = false
            return
        }
        let openAIKey = AISidecar.readKey()
        let elevenLabsKey = AISidecar.readElevenLabsKey()
        guard openAIKey != nil || elevenLabsKey != nil else {
            AISidecar.logLine("no OpenAI or ElevenLabs key found — AI features disabled")
            available = false
            realtimeAvailable = false
            return
        }
        guard let chosen = AISidecar.freePort() else {
            AISidecar.logLine("could not allocate a free port — AI features disabled")
            available = false
            return
        }
        self.port = chosen

        let proc = Process()
        if node == "/usr/bin/env" {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = ["node", script.path]
        } else {
            proc.executableURL = URL(fileURLWithPath: node)
            proc.arguments = [script.path]
        }
        var env = ProcessInfo.processInfo.environment
        if let openAIKey { env["OPENAI_API_KEY"] = openAIKey }
        if let elevenLabsKey { env["ELEVENLABS_API_KEY"] = elevenLabsKey }
        env["PORT"] = String(chosen)
        env["HASNA_NOTES_SIDECAR_TOKEN"] = token
        proc.environment = env
        let requestedProvider = (env["HASNA_NOTES_TRANSCRIPTION_PROVIDER"] ?? "").lowercased()
        let chosenRealtimeProvider: String
        if requestedProvider == "elevenlabs", elevenLabsKey != nil {
            chosenRealtimeProvider = "elevenlabs"
        } else if requestedProvider == "openai", openAIKey != nil {
            chosenRealtimeProvider = "openai"
        } else {
            chosenRealtimeProvider = openAIKey != nil ? "openai" : "elevenlabs"
        }

        // Pipe child stdout/stderr to NSLog + the durable log file (prefix `Sidecar:`).
        // The child never prints the key, so these logs are safe. The handler is @Sendable
        // (touches only its argument + the static logger) to satisfy Swift 6 concurrency.
        let out = Pipe(), err = Pipe()
        proc.standardOutput = out
        proc.standardError = err
        let logHandler: @Sendable (FileHandle) -> Void = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8) else { return }
            for line in s.split(separator: "\n") where !line.isEmpty {
                AISidecar.logLine(String(line))
            }
        }
        out.fileHandleForReading.readabilityHandler = logHandler
        err.fileHandleForReading.readabilityHandler = logHandler

        do {
            try proc.run()
            self.process = proc
            self.running = true
            self.available = openAIKey != nil
            self.realtimeAvailable = openAIKey != nil || elevenLabsKey != nil
            self.realtimeProvider = chosenRealtimeProvider
            AISidecar.logLine("spawned node pid=\(proc.processIdentifier) port=\(chosen) script=\(script.path) openai=\(openAIKey != nil) elevenlabs=\(elevenLabsKey != nil)")
        } catch {
            AISidecar.logLine("failed to launch node: \(error.localizedDescription)")
            self.running = false
            self.available = false
            self.realtimeAvailable = false
        }
    }

    /// Terminate the child (called on app terminate).
    func stop() {
        process?.terminate()
        process = nil
        running = false
    }
}

// MARK: - JSON helpers

/// Encode a Swift value graph (dictionaries/arrays/strings/numbers) into a compact
/// JSON string suitable for embedding in `window.__BOOT__ = <json>` and in
/// `evaluateJavaScript` arguments. Falls back to `null` on failure.
private func jsonString(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value) else {
        // Top-level scalars aren't valid JSON objects for JSONSerialization; wrap+unwrap.
        if let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
           let s = String(data: data, encoding: .utf8) {
            // strip the surrounding [ ]
            return String(s.dropFirst().dropLast())
        }
        return "null"
    }
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: []),
          let s = String(data: data, encoding: .utf8) else {
        return "null"
    }
    return s
}

/// Map a `Note` to the JSON-shaped dictionary the web UI consumes.
private func noteJSON(_ note: Note) -> [String: Any] {
    let contentPreview = note.body
        .replacingOccurrences(of: "\n", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return [
        "id": note.id.uuidString.lowercased(),
        "title": note.title,
        "body": note.body,
        "content": note.body,
        "contentFormat": note.contentFormat,
        "contentPreview": String(contentPreview.prefix(500)),
        "labels": note.labels,
        "tags": note.labels, // migration alias; user-facing name is labels
        "status": note.status.rawValue,
        "folder": note.folder,
        "machine": note.machine,
        "createdByActorType": note.createdByActorType,
        "createdByName": note.createdByName,
        "sourceMachine": note.sourceMachine,
        "sourceMachineFriendlyName": note.sourceMachineFriendlyName,
        "originMachine": note.originMachine,
        "originMachineFriendlyName": note.originMachineFriendlyName,
        "targetMachineFriendlyName": note.targetMachineFriendlyName,
        "previousMachine": note.previousMachine,
        "openedFrom": note.openedFrom,
        "sourceContext": note.sourceContext,
        "archivedAt": note.archivedAt.map(MarkdownStore.iso8601) ?? "",
        "trashedAt": note.trashedAt.map(MarkdownStore.iso8601) ?? "",
        "trashMachine": note.trashMachine,
        "trashExpiresAt": note.trashExpiresAt.map(MarkdownStore.iso8601) ?? "",
        "restoredAt": note.restoredAt.map(MarkdownStore.iso8601) ?? "",
        "movedAt": note.movedAt.map(MarkdownStore.iso8601) ?? "",
        "info": [
            "createdBy": note.createdByName.isEmpty ? note.author : note.createdByName,
            "createdByActorType": note.createdByActorType,
            "createdAt": MarkdownStore.iso8601(note.createdAt),
            "sourceMachine": note.sourceMachine.isEmpty ? note.machine : note.sourceMachine,
            "sourceMachineFriendlyName": note.sourceMachineFriendlyName,
            "originMachine": note.originMachine.isEmpty ? note.machine : note.originMachine,
            "originMachineFriendlyName": note.originMachineFriendlyName,
            "currentMachine": note.machine,
            "openedFrom": note.openedFrom,
            "sourceContext": note.sourceContext,
        ],
        "titleLocked": note.titleLocked,
        "titleSource": note.titleSource.rawValue,
        "titleContentFingerprint": note.titleContentFingerprint,
        "updatedAt": MarkdownStore.iso8601(note.updatedAt),
        "createdAt": MarkdownStore.iso8601(note.createdAt),
    ]
}

private func machineAliases(_ machine: FleetMachine, fallbackID: String? = nil) -> Set<String> {
    var aliases = Set<String>()
    let id = fallbackID ?? machine.id
    if !id.isEmpty { aliases.insert(id) }
    if !machine.id.isEmpty { aliases.insert(machine.id) }
    if let slug = machine.slug, !slug.isEmpty { aliases.insert(slug) }
    return aliases
}

private func machineJSON(_ machine: FleetMachine, notes: [Note], fallbackID: String? = nil) -> [String: Any] {
    let id = fallbackID ?? machine.id
    let aliases = machineAliases(machine, fallbackID: fallbackID)
    let machineNotes = notes.filter { aliases.contains($0.machine) }
    let activeNotes = machineNotes.filter { $0.status != .archived && $0.status != .trash }
    let latestNoteDate = machineNotes
        .map(\.updatedAt)
        .max()
    let updatedAt = machine.updatedAt ?? latestNoteDate
    let recentActivityAt = [machine.recentActivityAt, machine.syncedAt, machine.lastSeenAt, updatedAt, latestNoteDate]
        .compactMap { $0 }
        .max()
    var obj: [String: Any] = [
        "id": id,
        "slug": machine.slug ?? id,
        "displayName": machine.displayName,
        "sshAddress": machine.sshAddress,
        "platform": machine.platform,
        "status": machine.status ?? (machine.online == true ? "online" : (machine.online == false ? "offline" : "unknown")),
        "noteCount": activeNotes.count,
        "activeNoteCount": activeNotes.count,
        "archivedNoteCount": machineNotes.filter { $0.status == .archived }.count,
        "trashNoteCount": machineNotes.filter { $0.status == .trash }.count,
        "totalNoteCount": machineNotes.count,
        "capabilities": machine.capabilities,
        "metadata": machine.metadata,
        "provenance": machine.provenance,
        "sync": machine.sync,
    ]
    if let friendlyName = machine.friendlyName, !friendlyName.isEmpty {
        obj["friendlyName"] = friendlyName
    }
    if let online = machine.online {
        obj["online"] = online
    }
    if let source = machine.source, !source.isEmpty {
        obj["source"] = source
    }
    if let origin = machine.origin, !origin.isEmpty {
        obj["origin"] = origin
    }
    if let updatedAt {
        obj["updatedAt"] = MarkdownStore.iso8601(updatedAt)
    }
    if let latestNoteDate {
        obj["latestNoteUpdatedAt"] = MarkdownStore.iso8601(latestNoteDate)
    }
    if let lastSeenAt = machine.lastSeenAt {
        obj["lastSeenAt"] = MarkdownStore.iso8601(lastSeenAt)
    }
    if let syncedAt = machine.syncedAt {
        obj["syncedAt"] = MarkdownStore.iso8601(syncedAt)
    }
    if let recentActivityAt {
        obj["recentActivityAt"] = MarkdownStore.iso8601(recentActivityAt)
    }
    return obj
}

// MARK: - Notes bridge

/// Owns the on-disk store and the boot/hydrate/save/delete round-trip. Kept separate
/// from the message-handler object so the WKWebView retain graph (see WeakScriptProxy)
/// stays clean.
final class NotesBridge {
    let store = MarkdownStore()
    let labelStore: LabelStore
    let settingsStore: SettingsStore
    let thisMachine: String

    init() {
        self.labelStore = LabelStore(root: store.rootURL)
        self.settingsStore = SettingsStore(root: store.rootURL)
        // The note's own `machine` field uses the cosmetic Computer Name; the BOOT
        // payload's `thisMachine` must match that so new notes land under the right
        // machine row. Prefer the manifest-style short hostname, fall back to Note's.
        self.thisMachine = NotesBridge.resolveThisMachine()
    }

    /// Short hostname (pre-first-dot), matching how notes record `machine:`.
    static func resolveThisMachine() -> String {
        let raw = Host.current().localizedName
            ?? ProcessInfo.processInfo.hostName
        let short = raw.split(separator: ".", maxSplits: 1).first.map(String.init) ?? raw
        return short.isEmpty ? Note.currentMachine : short
    }

    /// Load all notes from disk (newest first). Never throws to the caller — a broken
    /// store yields an empty list and the UI falls back gracefully.
    func loadNotes() -> [Note] {
        (try? store.loadAll()) ?? []
    }

    /// Build the machine list: manifest first, then any machine ids seen in notes
    /// (so a note from a machine missing from the manifest still gets a row), then
    /// guarantee `thisMachine` is present.
    func machinePayloads(notes: [Note], includeManifestCLI: Bool = true) -> [[String: Any]] {
        var machinesByID: [String: FleetMachine] = [:]
        var aliases = Set<String>()
        let manifestCLI: (() -> Data?)? = includeManifestCLI ? nil : { nil }
        let fallback = includeManifestCLI ? FleetManifest.builtInFallback : []
        let manifest = FleetManifest.load(
            runCLI: manifestCLI,
            fallback: fallback
        )
        for m in manifest {
            machinesByID[m.id] = m
            aliases.formUnion(machineAliases(m))
        }
        for n in notes where !n.machine.isEmpty && !aliases.contains(n.machine) && machinesByID[n.machine] == nil {
            machinesByID[n.machine] = FleetMachine(id: n.machine, sshAddress: n.machine, platform: "macos")
            aliases.insert(n.machine)
        }
        if !thisMachine.isEmpty && !aliases.contains(thisMachine) && machinesByID[thisMachine] == nil {
            machinesByID[thisMachine] = FleetMachine(id: thisMachine, sshAddress: thisMachine, platform: "macos")
        }
        return machinesByID.values
            .sorted { a, b in
                let lhsAliases = machineAliases(a)
                let rhsAliases = machineAliases(b)
                let lhs = (a.recentActivityAt ?? a.syncedAt ?? a.lastSeenAt ?? a.updatedAt ?? notes.filter { note in lhsAliases.contains(note.machine) }.map(\.updatedAt).max()) ?? .distantPast
                let rhs = (b.recentActivityAt ?? b.syncedAt ?? b.lastSeenAt ?? b.updatedAt ?? notes.filter { note in rhsAliases.contains(note.machine) }.map(\.updatedAt).max()) ?? .distantPast
                if lhs != rhs { return lhs > rhs }
                return a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
            }
            .map { machineJSON($0, notes: notes) }
    }

    func machineDetails(id rawID: String, includeManifestCLI: Bool = true) -> [String: Any] {
        let id = rawID.trimmingCharacters(in: .whitespacesAndNewlines)
        let notes = loadNotes()
        let machines = machinePayloads(notes: notes, includeManifestCLI: includeManifestCLI)
        if let match = machines.first(where: { ($0["id"] as? String) == id || ($0["slug"] as? String) == id }) {
            return match
        }
        return machineJSON(FleetMachine(id: id, sshAddress: id, platform: "unknown"), notes: notes)
    }

    /// The `{notes, machines, thisMachine}` boot payload as a JSON string.
    func bootJSON() -> String {
        let notes = loadNotes()
        let payload: [String: Any] = [
            "notes": notes.map(noteJSON),
            "machines": machinePayloads(notes: notes),
            "labels": labelStore.load(),
            "thisMachine": thisMachine,
            "settings": ["trashRetentionDays": settingsStore.load().trashRetentionDays],
            "listDefaults": ["limit": 10],
        ]
        return jsonString(payload)
    }

    // MARK: mutations

    /// Build a `Note` from a JS message payload. New notes (create) get a fresh UUID,
    /// `machine = thisMachine`, and `agent = Note.appAgent`. Saves preserve the id and
    /// (for existing notes) the original createdAt/machine on disk.
    private func note(from dict: [String: Any], isCreate: Bool, allowMachineChange: Bool = false) -> Note {
        let id = (dict["id"] as? String).flatMap { UUID(uuidString: $0) } ?? UUID()
        let title = (dict["title"] as? String) ?? ""
        let body = (dict["body"] as? String) ?? ""
        let labels = (dict["labels"] as? [String]) ?? (dict["tags"] as? [String]) ?? []
        let status = (dict["status"] as? String).flatMap { NoteStatus(rawValue: $0) } ?? .active
        let folder = (dict["folder"] as? String) ?? ""
        let contentFormat = (dict["contentFormat"] as? String) ?? (dict["contentType"] as? String) ?? "markdown"
        let titleSource = (dict["titleSource"] as? String).flatMap(NoteTitleSource.init(rawValue:))
        let titleLocked = (dict["titleLocked"] as? Bool)
            ?? (titleSource == .manual && !Note.isDefaultTitle(title))
        let titleContentFingerprint = (dict["titleContentFingerprint"] as? String) ?? ""

        // Preserve the existing on-disk createdAt + machine when saving an existing note,
        // except for the explicit move-to-machine action.
        let existing: Note? = isCreate ? nil : loadNotes().first(where: { $0.id == id })
        let createdAt = existing?.createdAt
            ?? (dict["createdAt"] as? String).flatMap(MarkdownStore.parseDate)
            ?? Date()
        let machine = allowMachineChange
            ? ((dict["machine"] as? String) ?? existing?.machine ?? thisMachine)
            : (existing?.machine ?? (dict["machine"] as? String) ?? thisMachine)
        let author = (dict["author"] as? String) ?? existing?.author ?? Note.currentAuthor
        let agent = (dict["agent"] as? String) ?? existing?.agent ?? Note.appAgent
        let createdByActorType = (dict["createdByActorType"] as? String) ?? existing?.createdByActorType ?? "human"
        let createdByName = (dict["createdByName"] as? String) ?? existing?.createdByName ?? author
        let sourceMachine = (dict["sourceMachine"] as? String) ?? existing?.sourceMachine ?? thisMachine
        let sourceMachineFriendlyName = (dict["sourceMachineFriendlyName"] as? String) ?? existing?.sourceMachineFriendlyName ?? ""
        let originMachine = (dict["originMachine"] as? String) ?? existing?.originMachine ?? machine
        let originMachineFriendlyName = (dict["originMachineFriendlyName"] as? String) ?? existing?.originMachineFriendlyName ?? sourceMachineFriendlyName
        let targetMachineFriendlyName = (dict["targetMachineFriendlyName"] as? String) ?? existing?.targetMachineFriendlyName ?? ""
        let previousMachine = (dict["previousMachine"] as? String) ?? existing?.previousMachine ?? ""
        let openedFrom = (dict["openedFrom"] as? String) ?? existing?.openedFrom ?? ""
        let sourceContext = (dict["sourceContext"] as? String) ?? existing?.sourceContext ?? ""
        let archivedAt = (dict["archivedAt"] as? String).flatMap(MarkdownStore.parseDate) ?? existing?.archivedAt
        let trashedAt = (dict["trashedAt"] as? String).flatMap(MarkdownStore.parseDate) ?? existing?.trashedAt
        let trashMachine = (dict["trashMachine"] as? String) ?? existing?.trashMachine ?? ""
        let trashExpiresAt = (dict["trashExpiresAt"] as? String).flatMap(MarkdownStore.parseDate) ?? existing?.trashExpiresAt
        let restoredAt = (dict["restoredAt"] as? String).flatMap(MarkdownStore.parseDate) ?? existing?.restoredAt
        let movedAt = (dict["movedAt"] as? String).flatMap(MarkdownStore.parseDate) ?? existing?.movedAt

        return Note(
            id: id,
            title: title.isEmpty ? "Untitled Note" : title,
            labels: labels,
            status: status,
            folder: folder,
            contentFormat: contentFormat,
            titleLocked: titleLocked,
            titleSource: titleSource,
            titleContentFingerprint: titleContentFingerprint,
            createdAt: createdAt,
            updatedAt: Date(),
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

    /// Persist a create/save. Returns true on success.
    @discardableResult
    func save(_ dict: [String: Any], isCreate: Bool) -> Bool {
        let n = note(from: dict, isCreate: isCreate)
        do { try store.save(n); return true }
        catch { NSLog("HasnaNotes: save failed: \(error.localizedDescription)"); return false }
    }

    @discardableResult
    func move(_ dict: [String: Any]) -> Bool {
        guard let idStr = dict["id"] as? String,
              let id = UUID(uuidString: idStr),
              var existing = loadNotes().first(where: { $0.id == id }) else { return false }
        let target = (dict["machine"] as? String) ?? (dict["targetMachine"] as? String) ?? ""
        guard !target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if existing.originMachine.isEmpty { existing.originMachine = existing.machine }
        existing.previousMachine = existing.machine
        existing.machine = target
        existing.targetMachineFriendlyName = (dict["targetMachineFriendlyName"] as? String) ?? ""
        existing.movedAt = Date()
        existing.updatedAt = Date()
        do { try store.save(existing); return true }
        catch { NSLog("HasnaNotes: move failed: \(error.localizedDescription)"); return false }
    }

    @discardableResult
    func archive(_ dict: [String: Any]) -> Bool {
        guard let idStr = dict["id"] as? String,
              let id = UUID(uuidString: idStr),
              var existing = loadNotes().first(where: { $0.id == id }) else { return false }
        existing.status = .archived
        existing.archivedAt = Date()
        existing.trashedAt = nil
        existing.trashMachine = ""
        existing.trashExpiresAt = nil
        existing.updatedAt = Date()
        do { try store.save(existing); return true }
        catch { NSLog("HasnaNotes: archive failed: \(error.localizedDescription)"); return false }
    }

    @discardableResult
    func trash(_ dict: [String: Any]) -> Bool {
        guard let idStr = dict["id"] as? String,
              let id = UUID(uuidString: idStr),
              var existing = loadNotes().first(where: { $0.id == id }) else { return false }
        let now = Date()
        let retention = settingsStore.load().trashRetentionDays
        existing.status = .trash
        existing.trashedAt = now
        existing.trashMachine = (dict["trashMachine"] as? String) ?? existing.machine
        existing.trashExpiresAt = Calendar.current.date(byAdding: .day, value: retention, to: now)
        existing.updatedAt = now
        do { try store.save(existing); return true }
        catch { NSLog("HasnaNotes: trash failed: \(error.localizedDescription)"); return false }
    }

    @discardableResult
    func restore(_ dict: [String: Any]) -> Bool {
        guard let idStr = dict["id"] as? String,
              let id = UUID(uuidString: idStr),
              var existing = loadNotes().first(where: { $0.id == id }) else { return false }
        existing.status = .active
        existing.archivedAt = nil
        existing.trashedAt = nil
        existing.trashMachine = ""
        existing.trashExpiresAt = nil
        existing.restoredAt = Date()
        existing.updatedAt = Date()
        do { try store.save(existing); return true }
        catch { NSLog("HasnaNotes: restore failed: \(error.localizedDescription)"); return false }
    }

    /// Delete the note identified by the payload's id.
    @discardableResult
    func delete(_ dict: [String: Any]) -> Bool {
        guard let idStr = dict["id"] as? String, let id = UUID(uuidString: idStr) else { return false }
        if let existing = loadNotes().first(where: { $0.id == id }), existing.status != .trash {
            return trash(dict)
        }
        return purge(dict)
    }

    @discardableResult
    func purge(_ dict: [String: Any]) -> Bool {
        guard let idStr = dict["id"] as? String, let id = UUID(uuidString: idStr) else { return false }
        // delete only needs the id; build a minimal Note for the path.
        let n = Note(id: id)
        do { try store.delete(n); return true }
        catch { NSLog("HasnaNotes: delete failed: \(error.localizedDescription)"); return false }
    }

    @discardableResult
    func updateSettings(_ dict: [String: Any]) -> Bool {
        let days = (dict["trashRetentionDays"] as? Int)
            ?? (dict["trashRetentionDays"] as? NSNumber)?.intValue
            ?? NotesSettings.defaultTrashRetentionDays
        do { try settingsStore.save(NotesSettings(trashRetentionDays: days)); return true }
        catch { NSLog("HasnaNotes: settings save failed: \(error.localizedDescription)"); return false }
    }

    @discardableResult
    func updateLabels(_ dict: [String: Any]) -> Bool {
        let labels = (dict["labels"] as? [String]) ?? (dict["tags"] as? [String]) ?? []
        do { try labelStore.save(labels); return true }
        catch { NSLog("HasnaNotes: labels save failed: \(error.localizedDescription)"); return false }
    }
}

// MARK: - Weak message-handler proxy (leak-safety)

/// `WKUserContentController` RETAINS its script message handlers. If the AppDelegate
/// registered itself directly, the controller (owned by the configuration, owned by the
/// web view, owned by the window, owned by the delegate) would form a retain cycle and
/// the delegate/web view could never deallocate on a view teardown/reload.
///
/// This thin proxy is what the controller retains; it holds the real target WEAKLY and
/// forwards messages. On teardown the app removes the handler by name, but even if it
/// did not, the proxy's weak reference breaks the cycle. (This is the documented
/// Apple-recommended pattern for the WKScriptMessageHandler retain cycle.)
final class WeakScriptProxy: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}

// MARK: - Window drag strip

/// A transparent strip pinned to the top of the window that the user can grab to MOVE
/// the window. The window has a hidden titlebar fully covered by the WKWebView, and a
/// WKWebView swallows mouse drags — so without this the window is immovable. This view
/// overlays the empty native top-inset region and reports `mouseDownCanMoveWindow`, so a
/// drag there moves the window like a normal title bar (the traffic-light buttons, which
/// float above the content, keep working).
final class WindowDragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // AppKit supplies `point` in this view's coordinate space. Keep the
        // overlay hit-testable only inside its strip, without stealing events
        // from the web controls below it.
        return bounds.contains(point) ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let bridge = NotesBridge()
    let sidecar = AISidecar()
    private let notesHandlerName = "notes"
    private let windowHandlerName = "window"
    private let recordingHandlerName = "recording"
    private var recordingStatus: String = "idle"
    private var recordingMenuTitleItem: NSMenuItem?
    private var recordingStartItem: NSMenuItem?
    private var recordingPauseItem: NSMenuItem?
    private var recordingResumeItem: NSMenuItem?
    private var recordingStopItem: NSMenuItem?

    // Menu-bar status item (NSStatusItem) — created lazily when recording starts and shown
    // only while recording is active. Its menu carries the elapsed timer (disabled title),
    // Pause/Resume, Stop, and Open Hasna Notes. The title timer ticks from a lightweight
    // local NSTimer kept in sync by the web's periodic `recording` tick messages.
    private var statusItem: NSStatusItem?
    private var statusTimerItem: NSMenuItem?
    private var statusPauseItem: NSMenuItem?
    private var statusResumeItem: NSMenuItem?
    private var statusStopItem: NSMenuItem?
    private var statusTicker: Timer?
    private var recordingElapsedMs: Double = 0      // last elapsed reported by the web
    private var recordingElapsedSyncedAt: Date = Date()
    private var recordingPaused: Bool = false
    private var recordingLifecycleStatus: String = "idle"

    // Compact / quick-note window mode state.
    private var savedFrame: NSRect?
    private var savedLevel: NSWindow.Level = .normal
    private var savedCollectionBehavior: NSWindow.CollectionBehavior = []
    private var savedMinSize: NSSize = NSSize(width: 920, height: 640)
    private var isCompact = false

    func applicationDidFinishLaunching(_ note: Notification) {
        // Spawn the AI sidecar first so we know its port + availability before injecting
        // the `__AI__` boot flag below. Never blocks UI; failure just disables AI features.
        sidecar.start()

        let frame = NSRect(x: 0, y: 0, width: 1280, height: 820)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Hasna Notes"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.backgroundColor = .white
        window.minSize = NSSize(width: 920, height: 640)
        window.center()

        let cfg = WKWebViewConfiguration()

        // 1. Inject the `native` class as early as possible (avoid a flash of the
        //    desktop-frame layout), and again on DOMContentLoaded for certainty.
        let nativeJS = """
        document.documentElement.classList.add('native');
        document.addEventListener('DOMContentLoaded', function () {
          document.body.classList.add('native');
        }, { once: true });
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: nativeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        // 2. Inject REAL notes data as `window.__BOOT__` BEFORE the page's JS runs, so
        //    app.js renders from disk on first paint (no sample fallback in the app).
        let boot = bridge.bootJSON()
        let bootJS = "window.__BOOT__ = \(boot);"
        cfg.userContentController.addUserScript(
            WKUserScript(source: bootJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        // 2b. Inject the AI sidecar boot flag so the renderer knows the port + whether AI
        //     features (auto-title, voice transcription) are available.
        let aiPayload: [String: Any] = [
            "port": sidecar.port,
            "available": sidecar.available,
            "running": sidecar.running,
            "realtime": sidecar.realtimeAvailable,
            "realtimeProvider": sidecar.realtimeProvider,
            "token": sidecar.token,
        ]
        let aiJS = "window.__AI__ = \(jsonString(aiPayload));"
        cfg.userContentController.addUserScript(
            WKUserScript(source: aiJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        // 3. Register the `notes` + `window` + `recording` message handlers via a WEAK proxy (see
        //    WeakScriptProxy) so the controller→handler retain does not leak the web view.
        cfg.userContentController.add(WeakScriptProxy(self), name: notesHandlerName)
        cfg.userContentController.add(WeakScriptProxy(self), name: windowHandlerName)
        cfg.userContentController.add(WeakScriptProxy(self), name: recordingHandlerName)

        web = WKWebView(frame: frame, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        // uiDelegate lets us grant the microphone capture permission for voice notes
        // (the renderer calls getUserMedia({audio:true})).
        web.uiDelegate = self

        // Host the web view in a container and overlay a draggable top strip so the
        // hidden-titlebar window can be moved (the WKWebView alone swallows drags).
        let container = NSView(frame: frame)
        container.autoresizingMask = [.width, .height]
        web.frame = container.bounds
        container.addSubview(web)
        let dragStrip = WindowDragStrip(frame: NSRect(x: 0, y: frame.height - 30, width: frame.width, height: 30))
        dragStrip.identifier = NSUserInterfaceItemIdentifier("window-drag-strip")
        dragStrip.autoresizingMask = [.width, .minYMargin]
        container.addSubview(dragStrip)
        window.contentView = container

        guard let webDir = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true) else {
            NSLog("HasnaNotes: resourceURL is nil — cannot locate bundled web UI")
            return
        }
        let index = webDir.appendingPathComponent("index.html")
        NSLog("HasnaNotes: loading \(index.path) exists=\(FileManager.default.fileExists(atPath: index.path))")
        NSLog("HasnaNotes: boot payload bytes=\(boot.utf8.count) thisMachine=\(bridge.thisMachine)")
        web.loadFileURL(index, allowingReadAccessTo: webDir)

        buildMenu()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("HasnaNotes: didFinish navigation")
        webView.evaluateJavaScript("document.body && document.body.classList.add('native')", completionHandler: nil)

        // Diagnostic: count how many note rows the page actually rendered. Proves REAL
        // notes (not the browser sample) reached the DOM. The class is `.note-row`.
        webView.evaluateJavaScript("document.querySelectorAll('.note-row').length") { result, _ in
            let count = (result as? Int) ?? (result as? NSNumber)?.intValue ?? -1
            NSLog("HasnaNotes: rendered \(count) note rows")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("HasnaNotes: didFail navigation: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("HasnaNotes: didFailProvisionalNavigation: \(error.localizedDescription)")
    }

    // MARK: notes bridge (JS → Swift)

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any],
              let action = payload["action"] as? String else {
            return
        }

        // The `window` handler controls native window state (compact/quick-note mode) and,
        // per the recording contract, reflects the recording lifecycle into the menu-bar.
        if message.name == windowHandlerName {
            if action == "setCompact" {
                let on = (payload["on"] as? Bool) ?? false
                DispatchQueue.main.async { [weak self] in self?.setCompact(on) }
            } else if action == "recording" {
                // Contract: { action:"recording", state:'started'|'paused'|'resumed'|'stopping'|'transcribing'|'complete'|'error'|'stopped'|'tick', elapsedMs, status }
                let state = (payload["state"] as? String) ?? "stopped"
                let elapsedMs = (payload["elapsedMs"] as? Double)
                    ?? (payload["elapsedMs"] as? NSNumber)?.doubleValue ?? 0
                DispatchQueue.main.async { [weak self] in
                    self?.handleRecordingLifecycle(state: state, elapsedMs: elapsedMs)
                }
            }
            return
        }

        if message.name == recordingHandlerName {
            if action == "state", let state = payload["state"] as? [String: Any] {
                let status = (state["status"] as? String) ?? recordingStatus
                DispatchQueue.main.async { [weak self] in self?.updateRecordingMenu(state: status) }
            }
            return
        }

        guard message.name == notesHandlerName else { return }
        if action == "machineDetails" {
            let machineID = (payload["machine"] as? String) ?? (payload["id"] as? String) ?? bridge.thisMachine
            let requestID = (payload["requestId"] as? String) ?? ""
            let immediate = jsonString([
                "requestId": requestID,
                "machine": bridge.machineDetails(id: machineID, includeManifestCLI: false),
            ])
            DispatchQueue.main.async { [weak self] in
                self?.web.evaluateJavaScript("window.HasnaNotes && window.HasnaNotes.machines && window.HasnaNotes.machines.receiveDetails(\(immediate))", completionHandler: nil)
            }
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard self != nil else { return }
                let backgroundBridge = NotesBridge()
                let refreshed = jsonString([
                    "requestId": requestID,
                    "machine": backgroundBridge.machineDetails(id: machineID, includeManifestCLI: true),
                ])
                DispatchQueue.main.async { [weak self] in
                    self?.web.evaluateJavaScript("window.HasnaNotes && window.HasnaNotes.machines && window.HasnaNotes.machines.receiveDetails(\(refreshed))", completionHandler: nil)
                }
            }
            return
        }
        let noteDict = (payload["note"] as? [String: Any]) ?? [:]
        let destructiveConfirmed = (payload["confirmed"] as? Bool) == true || (noteDict["confirmed"] as? Bool) == true
        func allowDestructive(_ action: String) -> Bool {
            if destructiveConfirmed { return true }
            NSLog("HasnaNotes: ignored unconfirmed destructive notes action '\(action)'")
            return false
        }

        var changed = false
        switch action {
        case "create": changed = bridge.save(noteDict, isCreate: true)
        case "save":   changed = bridge.save(noteDict, isCreate: false)
        case "move":   changed = bridge.move(noteDict)
        case "archive": changed = bridge.archive(noteDict)
        case "trash":
            guard allowDestructive(action) else { return }
            changed = bridge.trash(noteDict)
        case "restore": changed = bridge.restore(noteDict)
        case "purge":
            guard allowDestructive(action) else { return }
            changed = bridge.purge(noteDict)
        case "settings": changed = bridge.updateSettings(noteDict)
        case "labels": changed = bridge.updateLabels(noteDict)
        case "delete":
            guard allowDestructive(action) else { return }
            changed = bridge.delete(noteDict)
        default:
            NSLog("HasnaNotes: unknown notes action '\(action)'")
        }

        guard changed else { return }
        // After any mutation, reload from disk and push fresh data back into the page.
        let fresh = bridge.bootJSON()
        DispatchQueue.main.async { [weak self] in
            self?.web.evaluateJavaScript("window.HasnaNotes && window.HasnaNotes.hydrate(\(fresh))", completionHandler: nil)
        }
    }

    // MARK: compact / quick-note window mode

    /// Shrink to a small floating quick-note window (on=true) or restore the full window
    /// (on=false). The same app/web view is reused — only the native window changes.
    private func setCompact(_ on: Bool) {
        guard let window = window else { return }
        if on {
            guard !isCompact else { return }
            // Remember where we were so we can restore exactly.
            savedFrame = window.frame
            savedLevel = window.level
            savedCollectionBehavior = window.collectionBehavior
            isCompact = true

            let size = NSSize(width: 380, height: 220)
            // The full-app minSize (920×640) would clamp the shrink, so relax it for the
            // quick-note window and restore it on exit.
            savedMinSize = window.minSize
            window.minSize = size
            // Position near the top-right of the screen with the visible window.
            let screen = window.screen ?? NSScreen.main
            var origin = NSPoint(x: 200, y: 200)
            if let vf = screen?.visibleFrame {
                origin = NSPoint(x: vf.maxX - size.width - 24, y: vf.maxY - size.height - 24)
            }
            window.level = .floating
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.setFrame(NSRect(origin: origin, size: size), display: true, animate: true)
            window.makeKeyAndOrderFront(nil)
        } else {
            guard isCompact else { return }
            isCompact = false
            window.level = savedLevel
            window.collectionBehavior = savedCollectionBehavior
            window.minSize = savedMinSize
            if let f = savedFrame {
                window.setFrame(f, display: true, animate: true)
            }
            window.makeKeyAndOrderFront(nil)
        }
    }

    // MARK: WKUIDelegate — media capture (microphone) permission

    /// Grant the renderer microphone access for voice notes. The app's
    /// NSMicrophoneUsageDescription drives the one-time macOS TCC prompt; once granted by
    /// the OS, this hands the in-page getUserMedia request the go-ahead.
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // MARK: teardown

    func applicationWillTerminate(_ notification: Notification) {
        // Remove the menu-bar status item (and its ticker) so it never outlives the app.
        hideStatusItem()
        // Stop the AI sidecar child so it doesn't outlive the app.
        sidecar.stop()
        // Remove the message handlers so the proxies (and thus the controller→delegate
        // edge) are released cleanly. Belt-and-suspenders alongside the weak proxy.
        web?.configuration.userContentController.removeScriptMessageHandler(forName: notesHandlerName)
        web?.configuration.userContentController.removeScriptMessageHandler(forName: windowHandlerName)
        web?.configuration.userContentController.removeScriptMessageHandler(forName: recordingHandlerName)
        web?.evaluateJavaScript("window.HasnaNotes && window.HasnaNotes.destroy()", completionHandler: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide Hasna Notes", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Hasna Notes", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let winItem = NSMenuItem()
        main.addItem(winItem)
        let winMenu = NSMenu(title: "Window")
        winMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        winItem.submenu = winMenu

        let recItem = NSMenuItem()
        main.addItem(recItem)
        let recMenu = NSMenu(title: "Recording")
        let title = NSMenuItem(title: "Recorder Idle", action: nil, keyEquivalent: "")
        title.isEnabled = false
        recordingMenuTitleItem = title
        recMenu.addItem(title)
        recMenu.addItem(NSMenuItem.separator())
        recordingStartItem = recMenu.addItem(withTitle: "Start Recording", action: #selector(recordingStart(_:)), keyEquivalent: "r")
        recordingStartItem?.keyEquivalentModifierMask = [.command, .shift]
        recordingPauseItem = recMenu.addItem(withTitle: "Pause Recording", action: #selector(recordingPause(_:)), keyEquivalent: "")
        recordingResumeItem = recMenu.addItem(withTitle: "Resume Recording", action: #selector(recordingResume(_:)), keyEquivalent: "")
        recordingStopItem = recMenu.addItem(withTitle: "Stop Recording", action: #selector(recordingStop(_:)), keyEquivalent: ".")
        recordingStopItem?.keyEquivalentModifierMask = [.command, .shift]
        recItem.submenu = recMenu
        updateRecordingMenu(state: recordingStatus)
        NSApp.mainMenu = main
    }

    private func callRecordingJS(_ action: String) {
        let js = "window.HasnaNotes && window.HasnaNotes.recording && window.HasnaNotes.recording.\(action) && window.HasnaNotes.recording.\(action)()"
        web?.evaluateJavaScript(js, completionHandler: nil)
    }

    private func updateRecordingMenu(state: String) {
        recordingStatus = state
        recordingMenuTitleItem?.title = "Recorder \(state.capitalized)"
        let active = state == "recording" || state == "paused" || state == "stopping" || state == "transcribing"
        recordingStartItem?.isEnabled = !active
        recordingPauseItem?.isEnabled = state == "recording"
        recordingResumeItem?.isEnabled = state == "paused"
        recordingStopItem?.isEnabled = state == "recording" || state == "paused"
    }

    @objc private func recordingStart(_ sender: Any?) { callRecordingJS("start") }
    @objc private func recordingPause(_ sender: Any?) { callRecordingJS("pause") }
    @objc private func recordingResume(_ sender: Any?) { callRecordingJS("resume") }
    @objc private func recordingStop(_ sender: Any?) { callRecordingJS("stop") }

    // MARK: - Menu-bar status item (NSStatusItem) — recording control

    /// Drive both the in-app Recording menu (existing) and the menu-bar status item from a
    /// single contract lifecycle message.
    private func handleRecordingLifecycle(state: String, elapsedMs: Double) {
        // Keep the in-app menu's coarse status in sync (map verbs → status it understands).
        switch state {
        case "started", "resumed", "tick": updateRecordingMenu(state: "recording")
        case "paused":                      updateRecordingMenu(state: "paused")
        case "stopping":                    updateRecordingMenu(state: "stopping")
        case "transcribing":                updateRecordingMenu(state: "transcribing")
        case "complete", "error", "stopped": updateRecordingMenu(state: state == "error" ? "error" : "idle")
        default: break
        }
        recordingLifecycleStatus = recordingStatus

        recordingElapsedMs = elapsedMs
        recordingElapsedSyncedAt = Date()

        switch state {
        case "started", "resumed", "tick":
            recordingPaused = false
            showStatusItem()
            startStatusTicker()
        case "paused":
            recordingPaused = true
            showStatusItem()
            stopStatusTicker()          // hold the displayed time while paused
            refreshStatusTitle()
        case "stopping", "transcribing":
            recordingPaused = false
            showStatusItem()
            stopStatusTicker()
            refreshStatusTitle()
        case "complete", "error", "stopped":
            recordingPaused = false
            hideStatusItem()
        default:
            break
        }
        refreshStatusMenuEnabled()
    }

    /// Create (once) and reveal the menu-bar status item, building its menu lazily.
    private func showStatusItem() {
        if statusItem == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            if let button = item.button {
                button.title = "● REC"
                button.font = NSFont.menuBarFont(ofSize: 0)
                button.contentTintColor = NSColor.systemRed
            }
            let menu = NSMenu()
            let timer = NSMenuItem(title: "Recording 0:00", action: nil, keyEquivalent: "")
            timer.isEnabled = false
            menu.addItem(timer)
            statusTimerItem = timer
            menu.addItem(NSMenuItem.separator())
            statusPauseItem = menu.addItem(withTitle: "Pause", action: #selector(recordingPause(_:)), keyEquivalent: "")
            statusPauseItem?.target = self
            statusResumeItem = menu.addItem(withTitle: "Resume", action: #selector(recordingResume(_:)), keyEquivalent: "")
            statusResumeItem?.target = self
            statusStopItem = menu.addItem(withTitle: "Stop", action: #selector(recordingStop(_:)), keyEquivalent: "")
            statusStopItem?.target = self
            menu.addItem(NSMenuItem.separator())
            let open = menu.addItem(withTitle: "Open Hasna Notes", action: #selector(openMainWindow(_:)), keyEquivalent: "")
            open.target = self
            item.menu = menu
            statusItem = item
        }
        statusItem?.isVisible = true
        refreshStatusTitle()
    }

    /// Hide and tear down the status item when recording stops (or the app terminates).
    private func hideStatusItem() {
        stopStatusTicker()
        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
        }
        statusItem = nil
        statusTimerItem = nil
        statusPauseItem = nil
        statusResumeItem = nil
        statusStopItem = nil
    }

    /// A lightweight 1s NSTimer ticks the menu title between the web's periodic syncs so the
    /// elapsed clock stays current even if the web tick cadence is coarse.
    private func startStatusTicker() {
        guard statusTicker == nil else { return }
        let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            DispatchQueue.main.async { self?.refreshStatusTitle() }
        }
        RunLoop.main.add(t, forMode: .common)
        statusTicker = t
    }

    private func stopStatusTicker() {
        statusTicker?.invalidate()
        statusTicker = nil
    }

    /// Compute the current elapsed (last web-reported value + wall-clock drift while running)
    /// and format it as m:ss for the status-item title.
    private func refreshStatusTitle() {
        if recordingLifecycleStatus == "transcribing" {
            statusTimerItem?.title = "Transcribing"
            statusItem?.button?.title = "TRANS"
            statusItem?.button?.contentTintColor = NSColor.systemPurple
            return
        }
        if recordingLifecycleStatus == "stopping" {
            statusTimerItem?.title = "Stopping"
            statusItem?.button?.title = "STOP"
            statusItem?.button?.contentTintColor = NSColor.systemPurple
            return
        }
        var ms = recordingElapsedMs
        if !recordingPaused {
            ms += Date().timeIntervalSince(recordingElapsedSyncedAt) * 1000.0
        }
        let total = Int(max(0, ms) / 1000.0)
        let label = String(format: "%d:%02d", total / 60, total % 60)
        statusTimerItem?.title = "Recording \(label)"
        statusItem?.button?.title = recordingPaused ? "❚❚ REC" : "● REC"
        statusItem?.button?.contentTintColor = recordingPaused ? NSColor.secondaryLabelColor : NSColor.systemRed
    }

    private func refreshStatusMenuEnabled() {
        statusPauseItem?.isHidden = recordingPaused
        statusResumeItem?.isHidden = !recordingPaused
        if recordingLifecycleStatus == "stopping" || recordingLifecycleStatus == "transcribing" {
            statusPauseItem?.isHidden = true
            statusResumeItem?.isHidden = true
            statusStopItem?.isEnabled = false
        } else {
            statusStopItem?.isEnabled = recordingStatus == "recording" || recordingStatus == "paused"
        }
    }

    /// Bring the main app window forward (status-item "Open Hasna Notes").
    @objc private func openMainWindow(_ sender: Any?) {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
