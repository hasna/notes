import Foundation
import OpenNotesCore

// CLI smoke test for the markdown store. Exits 0 on success, 1 on failure.
// Used as the verification harness because XCTest / swift-testing are unavailable
// under macOS Command Line Tools (no Xcode).

final class Counter { var failures = 0 }
let counter = Counter()

@MainActor
func check(_ condition: Bool, _ message: String) {
    if condition {
        print("  ok: \(message)")
    } else {
        print("  FAIL: \(message)")
        counter.failures += 1
    }
}

// Optional live-engine mode: drive the real FleetSync engine (spawns rsync/ssh) against
// a fleet supplied via env, to verify process spawning + skip/sync classification on a
// real machine. Triggered with FLEETSYNC_LIVE=1; not part of the default smoke run.
if ProcessInfo.processInfo.environment["FLEETSYNC_LIVE"] == "1" {
    let env = ProcessInfo.processInfo.environment
    let dir = URL(fileURLWithPath: env["FLEETSYNC_LOCAL"] ?? "/tmp/synctest/local/notes")
    let localID = env["FLEETSYNC_SELF"] ?? "machine001"
    // FLEETSYNC_FLEET = "id:ssh:platform,id:ssh:platform"
    let spec = env["FLEETSYNC_FLEET"] ?? ""
    let fleet = spec.split(separator: ",").compactMap { part -> FleetMachine? in
        let f = part.split(separator: ":", maxSplits: 2).map(String.init)
        guard f.count == 3 else { return nil }
        return FleetMachine(id: f[0], sshAddress: f[1], platform: f[2])
    }
    let sync = FleetSync(localNotesDir: dir, localMachineID: localID)
    print("FLEETSYNC targets:", sync.syncTargets(from: fleet).map { $0.id })
    let result = sync.sync(fleet: fleet)
    print("FLEETSYNC synced:", result.syncedMachines)
    print("FLEETSYNC skipped:", result.skipped)
    print("FLEETSYNC errors:", result.errors)
    exit(0)
}

let tempRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("opennotes-smoke-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: tempRoot) }

let store = MarkdownStore(root: tempRoot)

do {
    print("== save / reload round-trip ==")
    let note = Note(
        title: "Colons: brackets [x], commas, #hash",
        labels: ["ideas", "macos"],
        status: .reviewed,
        folder: "Work",
        titleLocked: false,
        titleSource: .generated,
        titleContentFingerprint: "abc123",
        createdByActorType: "agent",
        createdByName: "Codewith",
        sourceMachine: "spark02",
        sourceMachineFriendlyName: "Spark",
        originMachine: "apple03",
        originMachineFriendlyName: "Apple",
        previousMachine: "apple02",
        openedFrom: "mcp",
        sourceContext: "ticket-123",
        archivedAt: MarkdownStore.parseDate("2026-06-20T09:00:00Z"),
        trashedAt: MarkdownStore.parseDate("2026-06-21T09:00:00Z"),
        trashMachine: "apple03",
        trashExpiresAt: MarkdownStore.parseDate("2026-07-21T09:00:00Z"),
        movedAt: MarkdownStore.parseDate("2026-06-22T09:00:00Z"),
        body: "# Hello\n\nThis is the body with **markdown**.\n"
    )
    try store.save(note)

    // File written to the expected path.
    let expected = tempRoot
        .appendingPathComponent("notes")
        .appendingPathComponent("\(note.id.uuidString.lowercased()).md")
    check(FileManager.default.fileExists(atPath: expected.path),
          "file written to \(expected.lastPathComponent)")

    // Inspect raw file format.
    let raw = try String(contentsOf: expected, encoding: .utf8)
    check(raw.hasPrefix("---\n"), "file starts with YAML frontmatter")
    check(raw.contains("id: \(note.id.uuidString.lowercased())"), "frontmatter has lowercased id")
    check(raw.contains("status: reviewed"), "frontmatter has status")
    check(raw.contains("labels: [ideas, macos]"), "frontmatter has label list")
    check(raw.contains("folder: Work"), "frontmatter has folder")
    check(raw.contains("contentFormat: markdown"), "frontmatter has markdown content format")
    check(raw.contains("titleLocked: false"), "frontmatter has title lock metadata")
    check(raw.contains("titleSource: generated"), "frontmatter has title source metadata")
    check(raw.contains("titleContentFingerprint: abc123"), "frontmatter has title fingerprint metadata")
    check(raw.contains("createdByActorType: agent"), "frontmatter has actor provenance")
    check(raw.contains("createdByName: Codewith"), "frontmatter has friendly actor name")
    check(raw.contains("sourceMachine: spark02"), "frontmatter has source machine")
    check(raw.contains("originMachine: apple03"), "frontmatter has origin machine")
    check(raw.contains(#"trashExpiresAt: "2026-07-21T09:00:00Z""#), "frontmatter has trash retention expiry")
    check(raw.contains("agent: hasna-notes-app"), "frontmatter has new agent default")
    // Key order: id, title, labels, status, folder, content format, title metadata,
    // createdAt, updatedAt, author, agent, machine.
    if let labelsIdx = raw.range(of: "labels:"), let statusIdx = raw.range(of: "status:"),
       let folderIdx = raw.range(of: "folder:"), let contentFormatIdx = raw.range(of: "contentFormat:"),
       let titleSourceIdx = raw.range(of: "titleSource:"),
       let createdIdx = raw.range(of: "createdAt:") {
        check(labelsIdx.lowerBound < statusIdx.lowerBound &&
              statusIdx.lowerBound < folderIdx.lowerBound &&
              folderIdx.lowerBound < contentFormatIdx.lowerBound &&
              contentFormatIdx.lowerBound < titleSourceIdx.lowerBound &&
              titleSourceIdx.lowerBound < createdIdx.lowerBound,
              "labels/folder/content format/title metadata keys sit in fixed order")
    } else {
        check(false, "frontmatter has labels/status/folder/content format/title metadata/createdAt keys")
    }

    // Reload and compare.
    let loaded = try store.loadAll()
    check(loaded.count == 1, "exactly one note loaded")
    let reloaded = loaded[0]
    check(reloaded.id == note.id, "id round-trips")
    check(reloaded.title == note.title, "title (with special chars) round-trips")
    check(reloaded.labels == note.labels, "labels round-trip")
    check(reloaded.status == note.status, "status round-trips")
    check(reloaded.folder == note.folder, "folder round-trips")
    check(reloaded.contentFormat == "markdown", "content format round-trips as markdown")
    check(reloaded.titleLocked == note.titleLocked, "title lock metadata round-trips")
    check(reloaded.titleSource == note.titleSource, "title source metadata round-trips")
    check(reloaded.titleContentFingerprint == note.titleContentFingerprint, "title fingerprint round-trips")
    check(reloaded.createdByActorType == "agent", "actor type round-trips")
    check(reloaded.createdByName == "Codewith", "actor name round-trips")
    check(reloaded.sourceMachine == "spark02", "source machine round-trips")
    check(reloaded.originMachine == "apple03", "origin machine round-trips")
    check(reloaded.previousMachine == "apple02", "previous machine round-trips")
    check(reloaded.openedFrom == "mcp", "opened-from context round-trips")
    check(reloaded.trashMachine == "apple03", "trash machine round-trips")
    check(reloaded.trashExpiresAt.map(MarkdownStore.iso8601) == "2026-07-21T09:00:00Z", "trash expiry round-trips")
    check(reloaded.body == note.body, "body round-trips identically")

    print("== update overwrites file ==")
    var edited = reloaded
    edited.title = "Edited Title"
    edited.body = "v2 body"
    try store.save(edited)
    let afterEdit = try store.loadAll()
    check(afterEdit.count == 1, "still one note after edit")
    check(afterEdit.first?.title == "Edited Title", "edited title persisted")

    print("== bare file without frontmatter ==")
    let bare = MarkdownStore.parse("# Plain Heading\n\nNo frontmatter here.")
    check(bare?.title == "Plain Heading", "title derived from first line")
    check(bare?.contentFormat == "markdown", "bare file defaults to markdown content format")

    print("== markdown plain text extraction ==")
    do {
        let readable = Note.markdownPlainText("""
        # Roadmap **Planning**
        - [ ] Renewal [brief](https://example.com)
        <script>alert(1)</script>
        ```swift
        let x = "<unsafe>"
        ```
        """)
        check(readable == #"Roadmap Planning Renewal brief let x = " ""#,
              "markdown title text strips syntax and unsafe raw HTML (got: \(readable))")
    }

    print("== date round-trip ==")
    let parsed = MarkdownStore.parseDate("2026-06-22T09:00:00Z")
    check(parsed != nil, "ISO8601 date parses")
    check(MarkdownStore.iso8601(parsed ?? Date()) == "2026-06-22T09:00:00Z", "date serializes back identically")

    print("== delete removes file ==")
    try store.delete(edited)
    check(try store.loadAll().isEmpty, "note deleted")

    // ---------------------------------------------------------------------
    // Regression coverage for confirmed data-integrity defects.
    // ---------------------------------------------------------------------

    print("== #1 quotes in scalar fields survive repeated save/reload ==")
    do {
        var n = Note(title: #"Say "hi""#, body: "quote body\n")
        n.author = #"O'"Brien" \backslash"#
        n.machine = #"Mac "Pro""#
        // Save + reload 3 times; values must not accumulate escapes.
        for cycle in 1...3 {
            try store.save(n)
            let back = try store.loadAll().first { $0.id == n.id }
            check(back?.title == #"Say "hi""#, "title unchanged after cycle \(cycle)")
            check(back?.author == #"O'"Brien" \backslash"#, "author unchanged after cycle \(cycle)")
            check(back?.machine == #"Mac "Pro""#, "machine unchanged after cycle \(cycle)")
            if let back { n = back }
        }
        try store.delete(n)
    }

    print("== #2 labels with comma / ] / quote round-trip ==")
    do {
        let labels = [#"a,b"#, #"c]d"#, "plain", #"has "quote""#, "  spaced  "]
        let n = Note(title: "label test", labels: labels, body: "b\n")
        try store.save(n)
        let back = try store.loadAll().first { $0.id == n.id }
        check(back?.labels == labels, "labels with comma/bracket/quote/space round-trip exactly")
        try store.delete(n)
    }

    print("== #3 newline in scalar fields round-trips ==")
    do {
        var n = Note(title: "line1\nline2", body: "body\n")
        n.author = "auth\nor"
        n.machine = "mac\nhine"
        try store.save(n)
        let back = try store.loadAll().first { $0.id == n.id }
        check(back?.title == "line1\nline2", "title with newline round-trips")
        check(back?.author == "auth\nor", "author with newline round-trips")
        check(back?.machine == "mac\nhine", "machine with newline round-trips")
        // The frontmatter must remain parseable (other fields intact).
        check(back?.body == "body\n", "body intact despite newline in title")
        try store.delete(n)
    }

    print("== #4 body round-trips byte-for-byte (no spurious trailing newline) ==")
    do {
        // Body without trailing newline.
        let n1 = Note(title: "no trailing nl", body: "line without newline")
        try store.save(n1)
        let raw1 = try String(contentsOf: store.fileURL(for: n1.id), encoding: .utf8)
        check(raw1.hasSuffix("line without newline"), "no trailing newline appended to body on disk")
        let back1 = try store.loadAll().first { $0.id == n1.id }
        check(back1?.body == "line without newline", "body w/o trailing newline round-trips exactly")
        try store.delete(n1)

        // Empty body.
        let n2 = Note(title: "empty body", body: "")
        try store.save(n2)
        let back2 = try store.loadAll().first { $0.id == n2.id }
        check(back2?.body == "", "empty body round-trips exactly")
        try store.delete(n2)

        // Body WITH a trailing newline must keep exactly one.
        let n3 = Note(title: "with trailing nl", body: "has newline\n")
        try store.save(n3)
        let back3 = try store.loadAll().first { $0.id == n3.id }
        check(back3?.body == "has newline\n", "body w/ trailing newline round-trips exactly")
        try store.delete(n3)
    }

    print("== regression guard: body lines equal to '---' round-trip ==")
    do {
        let n = Note(title: "dashes in body", body: "before\n---\nafter\n")
        try store.save(n)
        let back = try store.loadAll().first { $0.id == n.id }
        check(back?.body == "before\n---\nafter\n", "body containing a '---' line round-trips")
        try store.delete(n)
    }

    print("== back-compat: legacy note (open-notes-app agent, no folder key) still parses ==")
    do {
        let id = UUID()
        let legacy = """
        ---
        id: \(id.uuidString.lowercased())
        title: Legacy Note
        tags: [old]
        status: active
        createdAt: 2026-01-01T00:00:00Z
        updatedAt: 2026-01-01T00:00:00Z
        author: someone
        agent: open-notes-app
        machine: OldMac
        ---
        legacy body
        """
        let parsed = MarkdownStore.parse(legacy, fallbackID: id)
        check(parsed?.agent == "open-notes-app", "legacy agent value preserved verbatim")
        check(parsed?.folder == "", "missing folder key defaults to empty")
        check(parsed?.contentFormat == "markdown", "missing contentFormat defaults to markdown")
        check(parsed?.labels == ["old"], "legacy tags parse as labels")
        check(parsed?.machine == "OldMac", "machine parsed from legacy note")
    }

    print("== back-compat: legacy contentType aliases contentFormat ==")
    do {
        let id = UUID()
        let legacy = """
        ---
        id: \(id.uuidString.lowercased())
        title: Legacy Content Type
        labels: []
        status: active
        folder: ""
        contentType: markdown
        createdAt: 2026-01-01T00:00:00Z
        updatedAt: 2026-01-01T00:00:00Z
        author: someone
        agent: hasna-notes-app
        machine: OldMac
        ---
        legacy body
        """
        let parsed = MarkdownStore.parse(legacy, fallbackID: id)
        check(parsed?.contentFormat == "markdown", "legacy contentType parses as markdown contentFormat")
    }

    print("== rich text ↔ markdown round-trip ==")
    do {
        let samples = [
            "# Title here",
            "## A heading",
            "plain body line",
            "- a bullet",
            "text with **bold** and *italic* words",
            "***bold and italic***",
            "# Title\nbody\n## Heading\n- one\n- two\nplain **end**",
        ]
        for s in samples {
            let back = RichTextMarkdown.roundTrip(s)
            check(back == s, "round-trips: \(s.replacingOccurrences(of: "\n", with: "\\n"))")
        }
        // Structural parse checks.
        let doc = RichTextMarkdown.parse(markdown: "# T\n- b\nplain")
        check(doc.blocks.count == 3, "three blocks parsed")
        check(doc.blocks[0].kind == .title, "first block is title")
        check(doc.blocks[1].kind == .bullet, "second block is bullet")
        check(doc.blocks[2].kind == .body, "third block is body")
        let runs = RichTextMarkdown.parseInline("a **b** c *d*")
        check(runs.contains(where: { $0.text == "b" && $0.bold }), "bold run detected")
        check(runs.contains(where: { $0.text == "d" && $0.italic }), "italic run detected")
    }

    print("== fleet manifest parsing ==")
    do {
        let json = """
        {"machines":[
          {"id":"m1","slug":"studio","sshAddress":"m1.local","platform":"macos","friendlyName":"Studio","online":true,"status":"online","source":"open-machines","origin":"fleet","lastSeenAt":"2026-06-20T10:00:00Z","syncedAt":"2026-06-20T10:05:00Z","capabilities":["notes-sync"],"metadata":{"location":"desk","nested":{"rack":"A"}},"provenance":{"importedBy":"test"},"sync":{"notes":"ok"}},
          {"id":"m2","platform":"linux"},
          {"name":"m3","host":"10.0.0.3"}
        ]}
        """
        let machines = FleetManifest.parse(jsonData: Data(json.utf8))
        check(machines.count == 3, "three machines parsed")
        check(machines[0].sshAddress == "m1.local", "explicit sshAddress used")
        check(machines[0].slug == "studio", "slug parsed")
        check(machines[0].friendlyName == "Studio", "friendlyName parsed")
        check(machines[0].online == true && machines[0].status == "online", "online/status parsed")
        check(machines[0].source == "open-machines" && machines[0].origin == "fleet", "source/origin parsed")
        check(machines[0].capabilities == ["notes-sync"], "capabilities parsed")
        check(machines[0].metadata["location"] as? String == "desk", "metadata parsed")
        check((machines[0].metadata["nested"] as? [String: Any])?["rack"] as? String == "A", "nested metadata parsed")
        check(machines[0].provenance["importedBy"] as? String == "test", "provenance parsed")
        check(machines[0].sync["notes"] as? String == "ok", "sync parsed")
        check(machines[0].lastSeenAt != nil && machines[0].syncedAt != nil, "activity timestamps parsed")
        check(machines[1].sshAddress == "m2", "missing sshAddress defaults to id")
        check(machines[1].isMac == false, "linux machine flagged non-mac")
        check(machines[1].isLinux == true, "linux machine flagged linux")
        check(machines[1].isSyncEligible == true, "linux machine is sync-eligible")
        check(machines[0].isSyncEligible == true, "mac machine is sync-eligible")
        check(machines[2].id == "m3" && machines[2].sshAddress == "10.0.0.3", "name/host aliases honored")
        check(FleetManifest.parse(jsonData: Data("{}".utf8)).isEmpty, "empty manifest parses to []")
    }

    print("== FleetSync target selection + rsync argv ==")
    do {
        let fleet = [
            FleetMachine(id: "self", sshAddress: "self", platform: "macos"),
            FleetMachine(id: "macA", sshAddress: "macA.local", platform: "macos"),
            FleetMachine(id: "linuxB", sshAddress: "linuxB", platform: "linux"),
        ]
        let sync = FleetSync(localNotesDir: URL(fileURLWithPath: "/tmp/n"), localMachineID: "self")
        let targets = sync.syncTargets(from: fleet)
        check(targets.count == 1, "only one eligible target (mac, not self)")
        check(targets.first?.id == "macA", "macA selected; self and linux excluded")
        let pull = sync.pullArguments(remote: targets[0])
        check(pull.contains("-au"), "pull uses -au newest-wins")
        check(pull.contains("macA.local:.hasna/apps/notes/notes/"), "pull pulls remote notes dir")
        check(pull.last == "/tmp/n/", "pull target is local notes dir with trailing slash")
        let push = sync.pushArguments(remote: targets[0])
        check(push.contains("macA.local:.hasna/apps/notes/notes/"), "push pushes to remote notes dir")
        check(push.contains("/tmp/n/"), "push source is local notes dir")
    }

    print("== #4 FleetSync self-exclusion is robust to id/ssh aliasing ==")
    do {
        // The manifest lists THIS box under an id/ssh that differs from the cosmetic
        // Computer Name (localMachineID). Self must STILL be excluded so we never rsync
        // to ourselves. We inject the manifest's alias as a known local alias.
        let fleet = [
            // self listed under a tailscale-style id + fqdn ssh, with user@ + port.
            FleetMachine(id: "selfbox-ts", sshAddress: "andrei@selfbox.tail.ts.net:22", platform: "macos"),
            FleetMachine(id: "macA", sshAddress: "macA.local", platform: "macos"),
        ]
        var sync = FleetSync(localNotesDir: URL(fileURLWithPath: "/tmp/n"), localMachineID: "Cosmetic Name")
        // The robust resolver must recognize this box's real aliases; inject them as the OS
        // would supply (hostname + tailscale short name).
        sync.extraLocalAliases = ["selfbox-ts", "selfbox"]
        let targets = sync.syncTargets(from: fleet)
        check(targets.map(\.id) == ["macA"],
              "self excluded via id/ssh alias; only macA targeted (got: \(targets.map(\.id)))")

        // Sanity: ssh host extraction strips user@ and :port and the domain.
        check(FleetSync.normalizeHost("andrei@machine001.local:22") == "machine001",
              "normalizeHost strips user@, :port, domain")
        check(FleetSync.normalizeHost("MACHINE001") == "machine001", "normalizeHost lowercases")
    }

    print("== FolderStore persists folder list ==")
    do {
        let fs = FolderStore(root: tempRoot)
        try fs.save(["Work", "Personal", "Work", ""])  // dupes + empty pruned
        check(fs.load() == ["Work", "Personal"], "folders persist, de-duped, empty removed")
    }

    print("== SettingsStore persists trash retention ==")
    do {
        let ss = SettingsStore(root: tempRoot)
        check(ss.load().trashRetentionDays == NotesSettings.defaultTrashRetentionDays,
              "settings default trash retention is available")
        try ss.save(NotesSettings(trashRetentionDays: 14))
        check(ss.load().trashRetentionDays == 14, "trash retention setting persists")
    }

    // ---------------------------------------------------------------------
    // Regression coverage for the rich-text ↔ markdown inline-emphasis defects.
    //
    // Defect #1 (BLOCKER): stray / unbalanced `*` markers must be LITERAL and
    //   round-trip byte-exact (no data loss, no injected markers).
    // Defect #2 (MAJOR): overlapping/nested emphasis must serialize to VALID
    //   markdown — minimal correct delimiters, never 4+/5+ asterisk runs.
    // ---------------------------------------------------------------------

    print("== #inline-1 stray / unbalanced markers are literal & byte-exact ==")
    do {
        // Each must round-trip UNCHANGED (lone/unbalanced `*` is literal text).
        let literals: [String] = [
            "5 * 3 = 15",            // multiplication: lone `*` is literal
            #"C:\*.txt"#,            // glob pattern
            "**bold",                // unclosed `**`
            "end with *",            // trailing lone `*`
            "*",                     // lone single
            "**",                    // lone double
            "***",                   // lone triple
            "****",                  // lone quad
            "a * b * c * d",         // odd count of singles -> all literal
            "mid *typing unclosed",  // mid-typing
            "price: 3 ** 2 power",   // `**` with no closer
        ]
        for s in literals {
            let back = RichTextMarkdown.roundTrip(s)
            check(back == s, "literal round-trips byte-exact: \(s)")
            // And it must be byte-stable across >=3 cycles.
            var cur = s
            for _ in 0..<3 { cur = RichTextMarkdown.roundTrip(cur) }
            check(cur == s, "literal stable after 3 cycles: \(s)")
        }
        // A lone-`*` line must NOT collapse to empty.
        check(!RichTextMarkdown.roundTrip("*").isEmpty, "lone * does not vanish")
        check(RichTextMarkdown.parse(markdown: "5 * 3 = 15").blocks[0].plainText == "5 * 3 = 15",
              "plain text of `5 * 3 = 15` keeps both asterisks")
    }

    print("== #inline-2 overlapping/nested emphasis emits VALID markdown, stable ==")
    do {
        // Cases where naive toggling produced 4-5 asterisk runs.
        let overlapping = ["**a *b* c**", "*a **b** c*"]
        for s in overlapping {
            let once = RichTextMarkdown.roundTrip(s)
            // Output must be VALID markdown: no run of 4 or more asterisks.
            check(!once.contains("****"), "no 4+ asterisk run for: \(s) (got: \(once))")
            // And stable across cycles (no drift).
            var cur = once
            for _ in 0..<3 { cur = RichTextMarkdown.roundTrip(cur) }
            check(cur == once, "stable after 3 cycles: \(s) (got: \(cur))")
            // The visible plain text must be preserved (no character loss).
            check(RichTextMarkdown.parse(markdown: s).blocks[0].plainText
                  == RichTextMarkdown.parse(markdown: once).blocks[0].plainText,
                  "plain text preserved through normalization: \(s)")
        }
    }

    print("== #inline-3 well-formed emphasis still works & round-trips ==")
    do {
        // These are already-valid and must be byte-stable.
        let valid = ["**b** *i* ***both***", "text with **bold** and *italic* words", "***bold and italic***"]
        for s in valid {
            check(RichTextMarkdown.roundTrip(s) == s, "well-formed round-trips: \(s)")
        }
        // Bold/italic runs still detected.
        let runs = RichTextMarkdown.parseInline("**b** *i* ***x***")
        check(runs.contains { $0.text == "b" && $0.bold && !$0.italic }, "bold run b detected")
        check(runs.contains { $0.text == "i" && $0.italic && !$0.bold }, "italic run i detected")
        check(runs.contains { $0.text == "x" && $0.bold && $0.italic }, "bold+italic run x detected")
        // Headings + bullets with inline emphasis still parse to the right kinds.
        let doc = RichTextMarkdown.parse(markdown: "# *T*\n## **H**\n- a *b* c\nplain")
        check(doc.blocks[0].kind == .title, "title with italic still title")
        check(doc.blocks[1].kind == .heading, "heading with bold still heading")
        check(doc.blocks[2].kind == .bullet, "bullet with italic still bullet")
        check(RichTextMarkdown.roundTrip("# *T*\n## **H**\n- a *b* c\nplain") == "# *T*\n## **H**\n- a *b* c\nplain",
              "headings/bullets with emphasis round-trip")
    }

    print("== legacy tags empty element is pruned ==")
    do {
        // Simulate a legacy frontmatter `tags` list that contains an empty quoted element.
        let id = UUID()
        let withEmpty = """
        ---
        id: \(id.uuidString.lowercased())
        title: empty tag test
        tags: ["", real, "", another]
        status: active
        createdAt: 2026-01-01T00:00:00Z
        updatedAt: 2026-01-01T00:00:00Z
        author: a
        agent: hasna-notes-app
        machine: M
        ---
        body
        """
        let parsed = MarkdownStore.parse(withEmpty, fallbackID: id)
        check(parsed?.labels == ["real", "another"], "empty legacy tag element pruned into labels (got: \(parsed?.labels ?? []))")
    }

} catch {
    print("  FAIL: threw error: \(error)")
    counter.failures += 1
}

print("")
if counter.failures == 0 {
    print("SMOKE OK — all checks passed")
    exit(0)
} else {
    print("SMOKE FAILED — \(counter.failures) check(s) failed")
    exit(1)
}
