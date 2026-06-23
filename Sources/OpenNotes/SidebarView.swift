import OpenNotesCore
import SwiftUI

/// Narrow purple sidebar: Library / Folders / Labels / Machines. Status filtering is gone
/// from here (it lives in the editor's settings popover).
struct SidebarView: View {
    @ObservedObject var store: NotesStore
    @Environment(\.colorScheme) private var colorScheme

    @State private var addingFolder = false
    @State private var newFolderName = ""
    @State private var renamingFolder: String?
    @State private var renameText = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                librarySection
                foldersSection
                if !store.allLabels.isEmpty { labelsSection }
                machinesSection
                Spacer(minLength: 8)
            }
            .padding(14)
            .padding(.top, 24)
        }
        .scrollContentBackground(.hidden)
        .foregroundStyle(.white)
        .tint(.white)
    }

    // MARK: - Library

    private var librarySection: some View {
        section(title: "Library") {
            filterRow(.all, icon: "tray.full", label: "All Notes")
            filterRow(.archive, icon: "archivebox", label: "Archive")
            filterRow(.trash, icon: "trash", label: "Trash")
        }
    }

    // MARK: - Folders

    private var foldersSection: some View {
        section(title: "Folders", trailing: {
            Button { addingFolder = true; newFolderName = "" } label: {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.plain)
            .help("Add Folder")
            .popover(isPresented: $addingFolder, arrowEdge: .trailing) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("New Folder").font(.headline)
                    TextField("Folder name", text: $newFolderName)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 200)
                        .onSubmit(commitNewFolder)
                    HStack {
                        Spacer()
                        Button("Cancel") { addingFolder = false }
                        Button("Add") { commitNewFolder() }
                            .keyboardShortcut(.defaultAction)
                            .disabled(newFolderName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                .padding(14)
            }
        }) {
            if store.allFolders.isEmpty {
                Text("No folders")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.5))
                    .padding(.leading, 6)
            }
            ForEach(store.allFolders, id: \.self) { folder in
                filterRow(.folder(folder), icon: "folder", label: folder)
                    .contextMenu {
                        Button("Rename") { renamingFolder = folder; renameText = folder }
                        Button("Delete", role: .destructive) { store.deleteFolder(folder) }
                    }
                    .popover(isPresented: Binding(
                        get: { renamingFolder == folder },
                        set: { if !$0 { renamingFolder = nil } }
                    ), arrowEdge: .trailing) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Rename Folder").font(.headline)
                            TextField("Folder name", text: $renameText)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 200)
                                .onSubmit { commitRename(folder) }
                            HStack {
                                Spacer()
                                Button("Cancel") { renamingFolder = nil }
                                Button("Rename") { commitRename(folder) }
                                    .keyboardShortcut(.defaultAction)
                            }
                        }
                        .padding(14)
                    }
            }
        }
    }

    private func commitNewFolder() {
        store.addFolder(newFolderName)
        addingFolder = false
        newFolderName = ""
    }

    private func commitRename(_ old: String) {
        store.renameFolder(old, to: renameText)
        renamingFolder = nil
    }

    // MARK: - Labels (replaces the old Status section)

    private var labelsSection: some View {
        section(title: "Labels") {
            ForEach(store.allLabels, id: \.self) { label in
                filterRow(.label(label), icon: "tag", label: label)
            }
        }
    }

    // MARK: - Machines

    private var machinesSection: some View {
        section(title: "Machines", trailing: {
            Button { store.syncFleet() } label: {
                if case .syncing = store.syncState {
                    ProgressView().controlSize(.small).tint(.white)
                } else {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.system(size: 11, weight: .semibold))
                }
            }
            .buttonStyle(.plain)
            .help("Sync notes across machines")
        }) {
            filterRow(.thisMachine, icon: "desktopcomputer", label: "This Machine")
            filterRow(.allMachines, icon: "rectangle.stack", label: "All Machines")
            ForEach(otherMachines) { machine in
                filterRow(.machine(machine.id), icon: "macpro.gen3.server", label: machine.displayName)
            }
            if store.visibleMachinesPage.hasMore {
                Button("View more") { store.loadMoreMachines() }
                    .font(.caption)
                    .buttonStyle(.plain)
                    .foregroundStyle(.white.opacity(0.75))
                    .padding(.leading, 34)
                    .padding(.top, 3)
            }
            if case .failed(let msg) = store.syncState {
                Text(msg)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.6))
                    .lineLimit(2)
                    .padding(.leading, 6)
            }
        }
    }

    /// Machines that own notes, excluding the local machine (which has its own row).
    private var otherMachines: [MachineDisplay] {
        store.visibleMachinesPage.items.filter { !store.isLocalMachine($0) }
    }

    // MARK: - Building blocks

    @ViewBuilder
    private func section<Trailing: View, Content: View>(
        title: String,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() },
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.6))
                    .padding(.leading, 6)
                Spacer()
                trailing()
                    .foregroundStyle(.white.opacity(0.8))
                    .padding(.trailing, 6)
            }
            content()
        }
    }

    private func filterRow(_ target: Filter, icon: String, label: String) -> some View {
        let selected = store.filter == target
        let count = store.count(for: target)
        return Button {
            withAnimation(.spring(response: 0.32, dampingFraction: 0.82)) {
                if case .machine(let machineID) = target {
                    store.selectMachine(machineID)
                } else if target == .thisMachine {
                    store.selectThisMachine()
                } else if target == .allMachines {
                    store.selectAllMachines()
                } else {
                    store.filter = target
                }
            }
        } label: {
            HStack(spacing: 9) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 16)
                Text(label)
                    .font(.system(.subheadline, design: .rounded))
                    .lineLimit(1)
                Spacer(minLength: 4)
                if count > 0 {
                    Text("\(count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.white.opacity(0.55))
                }
            }
            .foregroundStyle(.white.opacity(selected ? 1 : 0.85))
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: Theme.cornerSmall, style: .continuous)
                        .fill(.white.opacity(0.22))
                }
            }
        }
        .buttonStyle(.plain)
    }
}
