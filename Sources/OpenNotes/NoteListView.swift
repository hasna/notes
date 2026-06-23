import OpenNotesCore
import SwiftUI

/// Middle pane: searchable list of notes. One continuous surface on the white canvas —
/// a plain search row, a hairline divider, then the rows. No glass boxes, no margins
/// between sub-panels.
struct NoteListView: View {
    @ObservedObject var store: NotesStore
    @State private var confirmDelete: Note?

    var body: some View {
        VStack(spacing: 0) {
            searchBar
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            Divider().opacity(0.5)

            if store.visibleNotes.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(store.visibleNotes) { note in
                            NoteRow(note: note, selected: note.id == store.selection)
                                .contentShape(Rectangle())
                                .onTapGesture { store.selection = note.id }
                                .contextMenu {
                                    Button("Open") { store.selection = note.id }
                                    Button("Duplicate") { store.duplicate(id: note.id) }
                                    Divider()
                                    Button(note.status == .trash ? "Delete Permanently" : "Move to Trash", role: .destructive) { confirmDelete = note }
                                }
                            Divider().opacity(0.35).padding(.leading, 16)
                        }
                        if store.visibleNotesPage.hasMore {
                            Button("View more") { store.loadMoreNotes() }
                                .buttonStyle(.plain)
                                .font(.subheadline)
                                .foregroundStyle(Theme.accent)
                                .padding(.vertical, 12)
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            }
        }
        .contextMenu {
            Button("New Note") { store.createNote() }
        }
        .confirmationDialog(
            confirmDelete?.status == .trash ? "Delete permanently?" : "Move note to Trash?",
            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
            presenting: confirmDelete
        ) { note in
            Button(note.status == .trash ? "Delete Permanently" : "Move to Trash", role: .destructive) { store.delete(id: note.id); confirmDelete = nil }
            Button("Cancel", role: .cancel) { confirmDelete = nil }
        } message: { note in
            if note.status == .trash {
                Text("\"\(note.title)\" will be permanently deleted. This cannot be undone.")
            } else {
                Text("\"\(note.title)\" can be restored from Trash.")
            }
        }
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .font(.system(size: 13, weight: .medium))
            TextField("Search notes", text: $store.searchText)
                .textFieldStyle(.plain)
                .font(.system(.body, design: .rounded))
            if !store.searchText.isEmpty {
                Button {
                    store.searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: store.searchText.isEmpty ? "note.text" : "magnifyingglass")
                .font(.system(size: 38, weight: .light))
                .foregroundStyle(.tertiary)
            Text(store.searchText.isEmpty ? "No notes here yet" : "No matches")
                .font(.system(.headline, design: .rounded))
                .foregroundStyle(.secondary)
            Text(store.searchText.isEmpty ? "Press the pencil to create a note" : "Try a different search")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

private struct NoteRow: View {
    let note: Note
    let selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(note.title.isEmpty ? "Untitled Note" : note.title)
                .font(.system(.headline, design: .rounded))
                .lineLimit(1)
                .foregroundStyle(.primary)
            Text(note.snippet)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            HStack(spacing: 6) {
                Text(note.updatedAt.relativeDescription)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if !note.labels.isEmpty {
                    Text("·").foregroundStyle(.tertiary).font(.caption2)
                    Text(note.labels.prefix(3).map { "#\($0)" }.joined(separator: " "))
                        .font(.caption2)
                        .foregroundStyle(Theme.accent.opacity(0.9))
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            if selected {
                Theme.accent.opacity(0.12)
            }
        }
    }
}
