import OpenNotesCore
import SwiftUI

/// Root layout: a narrow purple Liquid-Glass sidebar on the left, and ONE continuous
/// white canvas (header + note list + editor) on the right — no boxed panels, separated
/// only by subtle hairline dividers.
struct ContentView: View {
    @ObservedObject var store: NotesStore
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 0) {
            // Purple sidebar (the only colored region).
            SidebarView(store: store)
                .frame(width: Theme.sidebarWidth)
                .background(sidebarBackground)

            // Continuous white canvas: header, then list | editor split.
            VStack(spacing: 0) {
                HeaderBar(store: store)
                Divider().opacity(0.5)

                HSplitView {
                    NoteListView(store: store)
                        .frame(minWidth: 260, idealWidth: 320)
                    EditorView(store: store)
                        .frame(minWidth: 380)
                }
            }
            .background(Theme.canvas(colorScheme))
        }
        .frame(minWidth: 900, minHeight: 600)
        .ignoresSafeArea(.container, edges: .top)
        .onAppear {
            // Kick a sync shortly after launch so other machines' notes appear.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                store.syncFleet()
            }
        }
    }

    /// Purple gradient behind Liquid Glass. Honors reduce-transparency via glassSurface's
    /// own fallback; here the gradient itself is the colored base.
    @ViewBuilder
    private var sidebarBackground: some View {
        Theme.sidebarGradient(colorScheme)
            .overlay(.ultraThinMaterial.opacity(0.0)) // keep gradient crisp; glass is on rows
            .ignoresSafeArea()
    }
}

/// The compact header line that replaces the old app-name title:
/// "12 notes · Updated 3m ago". Subtle, no big title, no boxed background.
private struct HeaderBar: View {
    @ObservedObject var store: NotesStore

    var body: some View {
        HStack(spacing: 6) {
            Text("\(store.notes.count) note\(store.notes.count == 1 ? "" : "s")")
            if let updated = store.lastUpdated {
                Text("·")
                Text("Updated \(updated.relativeDescription)")
            }
            Spacer()
            if case .syncing = store.syncState {
                ProgressView().controlSize(.small)
            } else if case .synced = store.syncState {
                Label("Synced", systemImage: "checkmark.circle")
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(.secondary)
            }
            Button {
                store.createNote()
            } label: {
                Image(systemName: "square.and.pencil")
            }
            .buttonStyle(.plain)
            .help("New Note")
        }
        .font(.system(.subheadline, design: .rounded))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 18)
        .padding(.top, 20)
        .padding(.bottom, 10)
    }
}
