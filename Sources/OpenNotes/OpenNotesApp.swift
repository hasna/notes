import OpenNotesCore
import SwiftUI

/// Hasna Notes — the SwiftUI app entry point. The executable target keeps the legacy
/// name `OpenNotes` (renaming it is risky), but every user-visible surface reads
/// "Hasna Notes": the window title is hidden in favor of the in-app header, and the
/// built bundle is `Hasna Notes.app` with CFBundleName "Hasna Notes".
@main
struct OpenNotesApp: App {
    @StateObject private var store = NotesStore()

    var body: some Scene {
        WindowGroup("Hasna Notes") {
            ContentView(store: store)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1120, height: 740)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Note") {
                    store.createNote()
                }
                .keyboardShortcut("n", modifiers: .command)
            }
        }
    }
}
