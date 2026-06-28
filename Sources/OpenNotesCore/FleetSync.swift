import Foundation

/// One machine in the fleet manifest.
public struct FleetMachine: Identifiable, @unchecked Sendable {
    public var id: String
    public var slug: String?
    public var sshAddress: String
    public var platform: String
    public var friendlyName: String?
    public var status: String?
    public var online: Bool?
    public var source: String?
    public var origin: String?
    public var updatedAt: Date?
    public var lastSeenAt: Date?
    public var syncedAt: Date?
    public var recentActivityAt: Date?
    public var capabilities: [String]
    public var metadata: [String: Any]
    public var provenance: [String: Any]
    public var sync: [String: Any]

    public init(
        id: String,
        sshAddress: String,
        platform: String,
        friendlyName: String? = nil,
        updatedAt: Date? = nil,
        slug: String? = nil,
        status: String? = nil,
        online: Bool? = nil,
        source: String? = nil,
        origin: String? = nil,
        lastSeenAt: Date? = nil,
        syncedAt: Date? = nil,
        recentActivityAt: Date? = nil,
        capabilities: [String] = [],
        metadata: [String: Any] = [:],
        provenance: [String: Any] = [:],
        sync: [String: Any] = [:]
    ) {
        self.id = id
        self.slug = slug?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.sshAddress = sshAddress
        self.platform = platform
        self.friendlyName = friendlyName?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.status = status?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.online = online
        self.source = source?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.origin = origin?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.updatedAt = updatedAt
        self.lastSeenAt = lastSeenAt
        self.syncedAt = syncedAt
        self.recentActivityAt = recentActivityAt
        self.capabilities = capabilities
        self.metadata = metadata
        self.provenance = provenance
        self.sync = sync
    }

    public var displayName: String {
        if let friendlyName, !friendlyName.isEmpty { return friendlyName }
        if let slug, !slug.isEmpty { return slug }
        return id
    }

    public var isMac: Bool {
        let p = platform.lowercased()
        return p.contains("mac") || p == "darwin" || p == "osx"
    }

    public var isLinux: Bool {
        let p = platform.lowercased()
        return p.contains("linux") || p.contains("ubuntu") || p.contains("debian")
    }

    /// A machine FleetSync can rsync notes with. Macs and Linux boxes (e.g. the Spark
    /// servers) both run the same `~/.hasna/apps/notes/notes/` flat-file store over
    /// `rsync`/`ssh`, so both are eligible; genuinely unknown platforms are excluded.
    public var isSyncEligible: Bool { isMac || isLinux }
}

/// Reads the fleet manifest from, in priority order:
///   1. `~/.hasna/machines/machines.json`           (JSON: { "machines": [ {id, sshAddress, platform} ] })
///   2. `machines manifest list --json`             (the `machines` CLI fleet manifest)
///   3. a built-in fallback (machine001 / machine002)
///
/// Manifest reading is pure-ish (it shells out to the CLI as a fallback), and the
/// returned list is used both for the Machines sidebar section and for FleetSync.
public enum FleetManifest {

    public static func defaultManifestURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".hasna", isDirectory: true)
            .appendingPathComponent("machines", isDirectory: true)
            .appendingPathComponent("machines.json")
    }

    private static func string(_ entry: [String: Any], _ keys: [String]) -> String? {
        for key in keys {
            if let value = entry[key], !String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return nil
    }

    private static func bool(_ value: Any?) -> Bool? {
        if let value = value as? Bool { return value }
        guard let raw = value.map({ String(describing: $0).lowercased() }) else { return nil }
        if ["true", "1", "yes", "online"].contains(raw) { return true }
        if ["false", "0", "no", "offline"].contains(raw) { return false }
        return nil
    }

    private static func date(_ entry: [String: Any], _ keys: [String]) -> Date? {
        for key in keys {
            if let raw = string(entry, [key]), let parsed = MarkdownStore.parseDate(raw) { return parsed }
        }
        return nil
    }

    private static func stringArray(_ value: Any?) -> [String] {
        if let arr = value as? [Any] {
            return arr.map { String(describing: $0) }.filter { !$0.isEmpty }
        }
        if let dict = value as? [String: Any] {
            return dict.keys.sorted().filter { bool(dict[$0]) != false }
        }
        if let value, !String(describing: value).isEmpty { return [String(describing: value)] }
        return []
    }

    private static func jsonDictionary(_ value: Any?) -> [String: Any] {
        guard let dict = value as? [String: Any] else { return [:] }
        var out: [String: Any] = [:]
        for (key, value) in dict {
            if JSONSerialization.isValidJSONObject([key: value]) {
                out[key] = value
            }
        }
        return out
    }

    /// Parse a `machines.json` or open-machines-shaped payload. Tolerates extra keys and
    /// entries missing `sshAddress` (defaults to `id`) or `platform` (defaults to "macos").
    public static func parse(jsonData: Data) -> [FleetMachine] {
        guard let parsed = try? JSONSerialization.jsonObject(with: jsonData) else {
            return []
        }
        let arr: [[String: Any]]
        if let direct = parsed as? [[String: Any]] {
            arr = direct
        } else if let root = parsed as? [String: Any] {
            arr = (root["machines"] as? [[String: Any]])
                ?? (root["items"] as? [[String: Any]])
                ?? (root["data"] as? [[String: Any]])
                ?? []
        } else {
            arr = []
        }
        return arr.compactMap { entry in
            guard let id = string(entry, ["id", "slug", "machineId", "name", "hostname"]), !id.isEmpty else {
                return nil
            }
            let ssh = string(entry, ["sshAddress", "ssh", "host", "hostname"]) ?? id
            let platform = string(entry, ["platform", "os"]) ?? "macos"
            let friendlyName = string(entry, ["friendlyName", "displayName", "label", "title"])
            let online = bool(entry["online"] ?? entry["isOnline"] ?? entry["reachable"])
            let status = string(entry, ["status", "state", "availability"])
                ?? (online == true ? "online" : (online == false ? "offline" : nil))
            return FleetMachine(
                id: id,
                sshAddress: ssh,
                platform: platform,
                friendlyName: friendlyName,
                updatedAt: date(entry, ["updatedAt", "lastUpdated", "modifiedAt"]),
                slug: string(entry, ["slug"]),
                status: status,
                online: online,
                source: string(entry, ["source", "sourceMachine", "sourceId"]),
                origin: string(entry, ["origin", "originMachine", "originId"]),
                lastSeenAt: date(entry, ["lastSeenAt", "lastHeartbeatAt", "heartbeatAt", "seenAt"]),
                syncedAt: date(entry, ["syncedAt", "lastSyncedAt", "notesSyncedAt"]),
                recentActivityAt: date(entry, ["recentActivityAt", "lastActivityAt", "activityAt"]),
                capabilities: stringArray(entry["capabilities"]),
                metadata: jsonDictionary(entry["metadata"]),
                provenance: jsonDictionary(entry["provenance"]),
                sync: jsonDictionary(entry["sync"])
            )
        }
    }

    /// Load the fleet using the documented priority order. `runCLI` is injected so tests
    /// can stub the CLI; in production it runs `machines manifest list --json`.
    public static func load(
        manifestURL: URL? = nil,
        runCLI: (() -> Data?)? = nil,
        fallback: [FleetMachine] = builtInFallback
    ) -> [FleetMachine] {
        let url = manifestURL ?? defaultManifestURL()
        if let data = try? Data(contentsOf: url) {
            let machines = parse(jsonData: data)
            if !machines.isEmpty { return machines }
        }
        let cli = runCLI ?? FleetManifest.runMachinesCLI
        if let data = cli() {
            let machines = parse(jsonData: data)
            if !machines.isEmpty { return machines }
        }
        return fallback
    }

    /// Built-in last-resort fleet so the Machines section is never empty on a fresh box.
    public static let builtInFallback: [FleetMachine] = [
        FleetMachine(id: "machine001", sshAddress: "machine001", platform: "macos"),
        FleetMachine(id: "machine002", sshAddress: "machine002", platform: "macos"),
    ]

    /// Shell out to `machines manifest list --json` (best-effort). Returns nil on failure.
    private static func runMachinesCLI() -> Data? {
        for path in ["/Users/\(NSUserName())/.bun/bin/machines", "/usr/local/bin/machines", "/opt/homebrew/bin/machines"] {
            guard FileManager.default.isExecutableFile(atPath: path) else { continue }
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: path)
            proc.arguments = ["manifest", "list", "--json"]
            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = Pipe()
            do {
                try proc.run()
                let timeout = DispatchWorkItem {
                    if proc.isRunning { proc.terminate() }
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + 2.5, execute: timeout)
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                proc.waitUntilExit()
                timeout.cancel()
                if proc.terminationStatus == 0, !data.isEmpty { return data }
            } catch { continue }
        }
        return nil
    }
}

/// Result of a fleet sync pass.
public struct FleetSyncResult: Equatable, Sendable {
    public var syncedMachines: [String]
    public var skipped: [String]
    public var errors: [String]

    public init(syncedMachines: [String] = [], skipped: [String] = [], errors: [String] = []) {
        self.syncedMachines = syncedMachines
        self.skipped = skipped
        self.errors = errors
    }
}

/// Bidirectional, newest-wins note synchronization across the fleet (macOS + Linux) over
/// `rsync`/`ssh`.
///
/// Notes are uuid-named flat files, so a union merge with `rsync -au` (update: only copy
/// when source is newer) in BOTH directions is a correct merge: every machine ends up with
/// the newest version of every note. There is no `--delete`, so a sync never destroys notes
/// on either side. Self, unsupported-platform, and unreachable machines are skipped.
public struct FleetSync {
    public let localNotesDir: URL
    public let localMachineID: String
    public let rsyncPath: String
    public let sshPath: String
    public let connectTimeout: Int

    public init(
        localNotesDir: URL,
        localMachineID: String,
        rsyncPath: String = "/usr/bin/rsync",
        sshPath: String = "/usr/bin/ssh",
        connectTimeout: Int = 5
    ) {
        self.localNotesDir = localNotesDir
        self.localMachineID = localMachineID
        self.rsyncPath = rsyncPath
        self.sshPath = sshPath
        self.connectTimeout = connectTimeout
    }

    /// The set of names that identify THIS machine, lowercased. Built defensively from the
    /// explicit `localMachineID` plus every name the OS can give us, so self-exclusion never
    /// depends on the manifest using the same string as the cosmetic Computer Name.
    /// Injectable (`extraLocalAliases`) for testing.
    public var extraLocalAliases: [String] = []

    private func localIdentitySet() -> Set<String> {
        var names: [String] = [localMachineID]
        names.append(contentsOf: extraLocalAliases)
        names.append(FleetSync.shortHost(ProcessInfo.processInfo.hostName))
        names.append(ProcessInfo.processInfo.hostName)
        #if canImport(Foundation)
        if let localized = Host.current().localizedName { names.append(localized) }
        for n in Host.current().names { names.append(n); names.append(FleetSync.shortHost(n)) }
        #endif
        return Set(names
            .map { FleetSync.normalizeHost($0) }
            .filter { !$0.isEmpty })
    }

    /// Strip a `user@host:port` ssh address down to its bare host, then to the unqualified
    /// (pre-first-dot) short name, lowercased — so `andrei@machine001.local:22` and
    /// `machine001` and `MACHINE001.tail.ts.net` all compare equal to `machine001`.
    public static func normalizeHost(_ raw: String) -> String {
        shortHost(sshHost(raw)).lowercased()
    }

    /// Extract the host portion of an ssh address: drop a leading `user@` and a trailing `:port`.
    public static func sshHost(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespaces)
        if let at = s.lastIndex(of: "@") { s = String(s[s.index(after: at)...]) }
        // Only treat a trailing `:digits` as a port (don't break IPv6, which we don't expect here).
        if let colon = s.lastIndex(of: ":") {
            let portPart = s[s.index(after: colon)...]
            if !portPart.isEmpty, portPart.allSatisfy(\.isNumber) { s = String(s[..<colon]) }
        }
        return s
    }

    /// The unqualified hostname: everything before the first dot.
    public static func shortHost(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespaces)
        return s.split(separator: ".", maxSplits: 1).first.map(String.init) ?? s
    }

    /// Decide which machines to sync with: every sync-eligible machine (Mac OR Linux),
    /// excluding self and genuinely unknown platforms.
    ///
    /// Self-exclusion is DEFENSIVE: a manifest entry is dropped if its `id` OR the host of
    /// its `sshAddress` matches ANY name that identifies this machine (the explicit
    /// `localMachineID`, the OS hostnames, or `Host.current().localizedName` / aliases),
    /// compared case-insensitively on the unqualified short name. This prevents the app from
    /// ever rsyncing to itself even when the manifest lists this box under a different
    /// id/ssh than the cosmetic Computer Name.
    public func syncTargets(from fleet: [FleetMachine]) -> [FleetMachine] {
        let selves = localIdentitySet()
        return fleet.filter { m in
            guard m.isSyncEligible else { return false }
            if selves.contains(FleetSync.normalizeHost(m.id)) { return false }
            if selves.contains(FleetSync.normalizeHost(m.sshAddress)) { return false }
            return true
        }
    }

    /// rsync option set used in both directions. `-a` archive, `-u` update (newest-wins),
    /// `-z` compress; ssh carries a short ConnectTimeout + BatchMode so unreachable hosts
    /// fail fast instead of blocking the UI.
    private var sshTransport: String {
        "\(sshPath) -o ConnectTimeout=\(connectTimeout) -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
    }

    /// Build the argv for pulling a remote machine's notes into the local dir.
    public func pullArguments(remote: FleetMachine) -> [String] {
        [
            "-au", "-e", sshTransport,
            "\(remote.sshAddress):.hasna/apps/notes/notes/",
            ensureTrailingSlash(localNotesDir.path),
        ]
    }

    /// Build the argv for pushing the local notes to a remote machine.
    public func pushArguments(remote: FleetMachine) -> [String] {
        [
            "-au", "-e", sshTransport,
            ensureTrailingSlash(localNotesDir.path),
            "\(remote.sshAddress):.hasna/apps/notes/notes/",
        ]
    }

    private func ensureTrailingSlash(_ path: String) -> String {
        path.hasSuffix("/") ? path : path + "/"
    }

    /// Run a full bidirectional sync against every eligible machine in the fleet.
    /// Blocking — callers should invoke this off the main thread.
    @discardableResult
    public func sync(fleet: [FleetMachine]) -> FleetSyncResult {
        var result = FleetSyncResult()
        // Make sure the local notes dir exists so push has a source and pull has a target.
        try? FileManager.default.createDirectory(at: localNotesDir, withIntermediateDirectories: true)

        for remote in syncTargets(from: fleet) {
            // Pull first (bring in remote-newer notes), then push (send local-newer notes).
            let pull = runRsync(pullArguments(remote: remote))
            // A pull that fails because the host is unreachable means skip, not error.
            if pull.exitCode == 255 || isUnreachable(pull.stderr) {
                result.skipped.append(remote.id)
                continue
            }
            let push = runRsync(pushArguments(remote: remote))
            if pull.exitCode == 0 && push.exitCode == 0 {
                result.syncedMachines.append(remote.id)
            } else {
                let detail = [pull.stderr, push.stderr]
                    .filter { !$0.isEmpty }
                    .joined(separator: " | ")
                result.errors.append("\(remote.id): \(detail.isEmpty ? "rsync exit \(pull.exitCode)/\(push.exitCode)" : detail)")
            }
        }
        return result
    }

    private func isUnreachable(_ stderr: String) -> Bool {
        let s = stderr.lowercased()
        return s.contains("connection timed out")
            || s.contains("could not resolve")
            || s.contains("no route to host")
            || s.contains("connection refused")
            || s.contains("operation timed out")
    }

    struct RsyncRun { var exitCode: Int32; var stdout: String; var stderr: String }

    private func runRsync(_ args: [String]) -> RsyncRun {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: rsyncPath)
        proc.arguments = args
        let out = Pipe(), err = Pipe()
        proc.standardOutput = out
        proc.standardError = err
        do {
            try proc.run()
            let oData = out.fileHandleForReading.readDataToEndOfFile()
            let eData = err.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            return RsyncRun(
                exitCode: proc.terminationStatus,
                stdout: String(decoding: oData, as: UTF8.self),
                stderr: String(decoding: eData, as: UTF8.self)
            )
        } catch {
            return RsyncRun(exitCode: -1, stdout: "", stderr: "\(error)")
        }
    }
}
