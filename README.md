# Hasna Notes

A simple, beautiful native macOS notes app built with **SwiftUI** and Apple's **2026
Liquid Glass** design language (macOS 26). Notes are stored as plain Markdown files
with YAML frontmatter, so they stay forward-compatible with the planned
`@hasna/notes` catalog/CLI.

![narrow purple sidebar · continuous white canvas · rich-text editor]

## What it is

- A clean, Apple-Notes-style UI: a narrow **purple Liquid-Glass sidebar**
  (Library / Folders / Labels / Machines) beside ONE continuous **white canvas** —
  a compact header line ("12 notes · Updated 3m ago"), a searchable **note list**,
  and a **rich-text editor** — separated only by subtle hairline dividers, no boxed
  panels.
- **Markdown editing** with stable commands for bold, italic, code, links, headings,
  lists, quotes, code blocks, checklists, and dividers. Markdown on disk is the
  contract.
- **Agentic Chat contracts** for tool-capable note search, summarization,
  organization, consolidation, and safe write previews. Claude owns the visual
  Chat UI; this repo exposes the state/events/tools.
- Per-note **status / labels / folder** live behind a subtle settings popover, keeping
  the editor surface clean.
- **Folders** (persisted to `folders.json`, empty folders survive) and **fleet sync**:
  bidirectional, newest-wins `rsync`/`ssh` synchronization of the notes directory across
  the macOS fleet, surfaced in the Machines section.
- Liquid Glass on the sidebar (`.glassEffect`, interactive) over an "infinity purple"
  gradient, with light/dark and reduce-transparency support.

## Data format — the contract

The Markdown files are the **source of truth**. Hasna Notes reads and writes them so any
other tool (the future `@hasna/notes` catalog/CLI) can index the same directory.

- Data root: `~/.hasna/apps/notes/`
- Notes: `~/.hasna/apps/notes/notes/<id>.md` (id is a lowercased UUID)
- Writes are **atomic** (temp file in the same dir, then `rename`).
- A missing/empty directory is created automatically.
- Files without frontmatter are treated as a body with a title derived from the first line.
- The closing `---` is followed by a single newline and then the body **immediately**
  (no blank separator line); the body is preserved byte-for-byte on round-trip.
- Scalar fields (title/author/machine) are double-quoted when they contain special
  characters, with `\\`, `\"`, and `\n` escaped; labels that contain a comma, bracket,
  quote, or surrounding space are double-quoted in the `[...]` list.

Each file looks like:

```markdown
---
id: 4a4e04bd-d838-4ac6-962a-0d074c90f001
title: My Note
labels: [ideas, macos]
status: active          # inbox | active | reviewed | promoted | archived | trash | stale
folder: Work            # optional; empty string = no folder (back-compat: absent on old notes)
contentFormat: markdown # canonical body format; legacy plain text is Markdown-compatible
titleLocked: false      # true means the user manually named the note
titleSource: generated  # default | generated | manual
titleContentFingerprint: 7a9f2d
createdAt: 2026-06-22T09:00:00Z
updatedAt: 2026-06-22T09:00:00Z
author: hasna
agent: hasna-notes-app  # legacy `open-notes-app` still parses
machine: Mac
---
The markdown body goes here.
```

Frontmatter key order is fixed: `id, title, labels, status, folder,
contentFormat, title metadata, createdAt, updatedAt, author, agent, machine`,
followed by provenance and lifecycle fields. Notes written by older versions
(`tags`, no `folder` key, no `contentFormat` key, `agent: open-notes-app`) still
parse — unknown/missing keys are tolerated. The user's folder list is persisted separately in
`~/.hasna/apps/notes/folders.json`; labels can also be persisted in
`~/.hasna/apps/notes/labels.json` so empty labels survive.

AI-generated titles are concise, capped to 3-4 words, and use the local sidecar's
cheap OpenAI title model by default (`HASNA_NOTES_TITLE_MODEL`, default
`gpt-4o-mini`). Title generation reads Markdown as plain text so syntax and raw
HTML do not leak into titles. Manual titles are locked and are not overwritten
unless a caller explicitly forces generation.

Markdown rendering is intentionally restricted. CLI, MCP, and web bridge helpers
escape raw HTML, drop unsafe links, and expose plain-text extraction for titles
and search:

```bash
node cli/hasna-notes.mjs markdown commands
node cli/hasna-notes.mjs markdown render <note-id>
node cli/hasna-notes.mjs markdown plain-text <note-id>
node cli/hasna-notes.mjs markdown apply-command bold --text hello --selection-start 0 --selection-end 5
```

Archive and Trash are first-class note states. Normal Delete moves a note to
per-machine Trash; deleting a note already in Trash, or calling an explicit purge,
permanently removes the file. Trash retention defaults to 30 days and is stored in
`~/.hasna/apps/notes/settings.json`. Notes also carry provenance metadata for
agent-created notes and synced notes: actor type/name, source machine, origin/current
machine, previous machine, opened-from/source context, and lifecycle timestamps.

## Project layout

```
Package.swift                       SwiftPM manifest (platform .macOS("26.0"))
Sources/OpenNotesCore/              Pure, UI-free logic (a library product)
  Note.swift                        Note model + NoteStatus enum (+ folder field)
  MarkdownStore.swift               Markdown + YAML-frontmatter read/write (atomic)
  RichTextMarkdown.swift            Pure Markdown ↔ rich-text document bridge (tested)
  FolderStore.swift                 folders.json persistence (empty folders survive)
  LabelStore.swift                  labels.json persistence + normalization
  FleetSync.swift                   Fleet manifest + bidirectional rsync/ssh sync engine
Sources/OpenNotes/                  SwiftUI app (executable target name kept as OpenNotes)
  OpenNotesApp.swift                @main App entry (hidden title bar, "Hasna Notes")
  NotesStore.swift                  @MainActor ObservableObject store (+ folders/sync)
  ContentView.swift                 Purple sidebar + continuous white canvas + header
  SidebarView.swift                 Library / Folders / Labels / Machines + add-folder + Sync
  NoteListView.swift                Continuous list, hairline dividers, context menus
  EditorView.swift                  Title + formatting toolbar + settings popover
  RichTextEditor.swift              NSTextView rich editor bridged to Markdown
  MarkdownStyling.swift             Markdown ↔ NSAttributedString styling bridge
  Theme.swift                       Design tokens + Liquid Glass helpers (with fallbacks)
Sources/OpenNotesSmoke/             CLI smoke test for the store + bridges (no Xcode needed)
scripts/build_app.sh                SwiftPM build + assembled "Hasna Notes.app" + codesign
scripts/build_hasnanotes.sh         WKWebView app build with bundled web UI + sidecar
scripts/run_on_apple03.sh           rsync to a Mac and build there
cli/hasna-notes.mjs                 CLI for notes, labels, pagination, and titles
mcp/hasna-notes-mcp.mjs             MCP stdio server exposing the same functionality
```

## Build & run

This project builds with **SwiftPM only** — no Xcode required. It targets macOS 26
(Liquid Glass APIs) and has been built and launched on a Mac with Command Line Tools.

### On the Mac (macOS 26)

```bash
bash scripts/build_hasnanotes.sh   # swift build -c release + bundle web UI/sidecar + codesign
open "dist/Hasna Notes.app"
```

### From a Linux box (writes here, builds on the Mac)

```bash
bash scripts/run_on_apple03.sh     # rsync to the Mac and run build_hasnanotes.sh there
```

Override the host/path with `REMOTE_HOST` / `REMOTE_PATH` env vars.

### Verify the store logic

```bash
swift run -c release OpenNotesSmoke   # round-trips a note through the markdown store
node --test test/notes-functionality.test.mjs
```

### CLI / MCP

```bash
node cli/hasna-notes.mjs list --limit 10
node cli/hasna-notes.mjs labels assign <note-id> research
node cli/hasna-notes.mjs move <note-id> apple04
node cli/hasna-notes.mjs archive <note-id>
node cli/hasna-notes.mjs delete <note-id>          # moves to Trash
node cli/hasna-notes.mjs purge <note-id>           # permanent delete
node cli/hasna-notes.mjs settings set-trash-retention 30
node cli/hasna-notes.mjs title <note-id> --apply
node cli/hasna-notes.mjs markdown commands
node cli/hasna-notes.mjs agent "summarize notes" --json
node cli/hasna-notes.mjs agent "consolidate notes" --json       # preview
node cli/hasna-notes.mjs agent "consolidate notes" --yes --json # write
node mcp/hasna-notes-mcp.mjs
```

The CLI and MCP both default lists to the latest 10 notes and return pagination
metadata in JSON/MCP responses. CLI/MCP creation supports agent provenance fields
such as `actorType`, `actorName`, `sourceMachine`, `targetMachine`, `openedFrom`,
and `sourceContext`. Machine details are available through `hasna-notes machines
list`, `hasna-notes machines details <id>`, and MCP `machines_list` /
`machines_details`; details combine open-machines fields with notes-derived
fallback counts and activity timestamps.
Markdown helpers are available in MCP as `markdown_commands`, `markdown_render`,
`markdown_plain_text`, and `markdown_apply_command`.

Agentic note operations are available through `hasna-notes agent ...` and MCP
`agent_tools`, `agent_run`, and `agent_tool_call`. The shared tool registry
supports list/search/read, friendly provenance metadata, create/update/append,
label/unlabel, archive/trash/restore, summarize, related-note discovery, and
consolidation into a larger note. Destructive or broad writes return a preview
unless confirmed (`--yes` in CLI or `confirm: true` in MCP). Agent-created notes
write provenance metadata (`createdByActorType: agent`, friendly actor name,
opened-from/source context).
Direct CLI/MCP deletion paths are also gated: `delete`, `trash`,
`cleanup-trash`, `notes_delete`, `notes_trash`, and `trash_cleanup` preview
unless confirmed, while permanent `purge` / `notes_purge` require `--yes` /
`--force` or `confirm: true`.

The web bridge exposes `window.HasnaNotes.chat.state/tools/send/approve/clear`
and dispatches `hasna:chat-*` events for state, messages, deltas, tool calls,
tool results, source references, confirmations, finish, and errors. The local
sidecar also exposes `POST /chat` as an optional AI SDK streaming endpoint over a
provided note snapshot; disk writes remain in the app/CLI/MCP tool layer.

### Recording and transcription

The native app keeps recording as app-level state. The web bridge exposes
`window.HasnaNotes.recording.state/start/pause/resume/stop` and dispatches
`hasna:recording-state`, `hasna:recording-progress`,
`hasna:transcript-delta`, and `hasna:transcript-complete` events. Exposed
states are `idle`, `recording`, `paused`, `stopping`, `transcribing`,
`complete`, and `error`, so stop-to-transcribing is observable. Realtime
transcription uses OpenAI realtime
transcription when `OPENAI_API_KEY` is available, with ElevenLabs Scribe v2
Realtime as an optional fallback when `ELEVENLABS_API_KEY` is present. Bounded
OpenAI transcription remains the fallback and defaults to `gpt-4o-transcribe`.
For OpenAI realtime, the sidecar uses the transcription-session WebSocket
endpoint (`/v1/realtime?intent=transcription`) and sends
`HASNA_NOTES_OPENAI_REALTIME_TRANSCRIPTION_MODEL` (default
`gpt-realtime-whisper`) as `audio.input.transcription.model`. No `model=` query
parameter is sent on that WebSocket. Transcription-only models are rejected from
the legacy realtime session-model slot; if an override puts
`gpt-realtime-whisper`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, or
`whisper-1` there, the sidecar falls back to `gpt-realtime` and reports a
`configWarnings` entry from `/health`. `HASNA_NOTES_TRANSCRIBE_MODEL=
gpt-realtime-whisper` is also ignored, because bounded transcription uses
request/response speech-to-text models.

## Requirements

- macOS 26 (Liquid Glass). Older systems fall back to `.ultraThinMaterial`.
- Swift 6.x toolchain (Xcode or Command Line Tools).
