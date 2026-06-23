// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "OpenNotes",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "OpenNotesCore", targets: ["OpenNotesCore"]),
    ],
    targets: [
        .target(
            name: "OpenNotesCore",
            path: "Sources/OpenNotesCore"
        ),
        .executableTarget(
            name: "OpenNotes",
            dependencies: ["OpenNotesCore"],
            path: "Sources/OpenNotes"
        ),
        // CLI smoke test for the markdown store. Used as the verification harness
        // because XCTest / swift-testing are unavailable under Command Line Tools.
        .executableTarget(
            name: "OpenNotesSmoke",
            dependencies: ["OpenNotesCore"],
            path: "Sources/OpenNotesSmoke"
        ),
        // Native macOS shell (WKWebView) hosting the bundled web UI.
        // Depends on OpenNotesCore so it can read/write the on-disk Markdown notes
        // store and bridge real note data into the web UI.
        .executableTarget(
            name: "HasnaNotesApp",
            dependencies: ["OpenNotesCore"],
            path: "Sources/HasnaNotesApp"
        ),
    ]
)
