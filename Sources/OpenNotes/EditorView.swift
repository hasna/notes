import OpenNotesCore
import SwiftUI

/// Right pane: a clean Apple-Notes-style editor. The title sits on the white canvas with
/// a small formatting toolbar and a subtle settings button; status/labels/folder are hidden
/// behind that settings popover. The body is a rich-text editor bridged to Markdown.
struct EditorView: View {
    @ObservedObject var store: NotesStore

    var body: some View {
        Group {
            if let note = store.selectedNote {
                EditorPane(store: store, note: note)
                    .id(note.id)
            } else {
                emptyState
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 46, weight: .light))
                .foregroundStyle(.tertiary)
            Text("Select or create a note")
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(.secondary)
            Text("Your notes are stored as Markdown in ~/.hasna/apps/notes")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

/// The editing surface. Local @State mirrors the note; edits write back through the store.
private struct EditorPane: View {
    @ObservedObject var store: NotesStore
    let note: Note

    @State private var title: String
    @State private var body_: String
    @State private var command: EditorCommand?
    @State private var showSettings = false

    init(store: NotesStore, note: Note) {
        self.store = store
        self.note = note
        _title = State(initialValue: note.title)
        _body_ = State(initialValue: note.body)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Title + toolbar row, on the white canvas (no box).
            HStack(spacing: 10) {
                TextField("Title", text: $title)
                    .textFieldStyle(.plain)
                    .font(.system(.title, design: .rounded).weight(.bold))
                    .onChange(of: title) { _, newValue in
                        store.update(id: note.id) {
                            $0.title = newValue
                            if Note.isDefaultTitle(newValue) {
                                $0.titleLocked = false
                                $0.titleSource = .defaultTitle
                                $0.titleContentFingerprint = ""
                            } else {
                                $0.titleLocked = true
                                $0.titleSource = .manual
                            }
                        }
                    }
                formattingToolbar
                settingsButton
            }
            .padding(.horizontal, 18)
            .padding(.top, 16)
            .padding(.bottom, 8)

            Divider().opacity(0.4)

            RichTextEditor(
                markdown: $body_,
                command: command,
                onCommandHandled: { command = nil }
            )
            .onChange(of: body_) { _, newValue in
                store.update(id: note.id) { $0.body = newValue }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var formattingToolbar: some View {
        HStack(spacing: 4) {
            toolbarButton("bold", help: "Bold (⌘B)") { command = .bold }
                .keyboardShortcut("b", modifiers: .command)
            toolbarButton("italic", help: "Italic (⌘I)") { command = .italic }
                .keyboardShortcut("i", modifiers: .command)
            Menu {
                Button("Title") { command = .title }
                Button("Heading") { command = .heading }
                Button("Body") { command = .body }
            } label: {
                Image(systemName: "textformat.size")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Text style")
            toolbarButton("list.bullet", help: "Bullet list") { command = .bullet }
        }
        .foregroundStyle(.secondary)
    }

    private func toolbarButton(_ icon: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private var settingsButton: some View {
        Button { showSettings.toggle() } label: {
            Image(systemName: "slider.horizontal.3")
                .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("Note settings")
        .popover(isPresented: $showSettings, arrowEdge: .bottom) {
            NoteSettingsPopover(store: store, note: note)
        }
    }
}

/// Popover to edit status, labels, and folder without cluttering the editor surface.
private struct NoteSettingsPopover: View {
    @ObservedObject var store: NotesStore
    let note: Note

    @State private var status: NoteStatus
    @State private var labelsText: String
    @State private var folder: String

    init(store: NotesStore, note: Note) {
        self.store = store
        self.note = note
        _status = State(initialValue: note.status)
        _labelsText = State(initialValue: note.labels.joined(separator: ", "))
        _folder = State(initialValue: note.folder)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Note Settings").font(.headline)

            VStack(alignment: .leading, spacing: 4) {
                Text("Status").font(.caption).foregroundStyle(.secondary)
                Picker("", selection: $status) {
                    ForEach(NoteStatus.allCases) { s in
                        Label(s.label, systemImage: s.symbol).tag(s)
                    }
                }
                .labelsHidden()
                .onChange(of: status) { _, newValue in
                    store.setStatus(id: note.id, to: newValue)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Labels").font(.caption).foregroundStyle(.secondary)
                TextField("comma, separated, labels", text: $labelsText)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: labelsText) { _, newValue in
                        let labels = newValue
                            .components(separatedBy: ",")
                            .map { $0.trimmingCharacters(in: .whitespaces) }
                            .filter { !$0.isEmpty }
                        store.update(id: note.id) { $0.labels = labels }
                    }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Folder").font(.caption).foregroundStyle(.secondary)
                Picker("", selection: $folder) {
                    Text("None").tag("")
                    ForEach(store.allFolders, id: \.self) { f in
                        Text(f).tag(f)
                    }
                }
                .labelsHidden()
                .onChange(of: folder) { _, newValue in
                    store.update(id: note.id) { $0.folder = newValue }
                }
            }

            Divider()
            HStack(spacing: 12) {
                Label(note.author, systemImage: "person")
                Label(note.machine, systemImage: "desktopcomputer")
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(16)
        .frame(width: 260)
    }
}
