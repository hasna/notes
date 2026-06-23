import AppKit
import OpenNotesCore
import SwiftUI

/// An Apple-Notes-style rich-text editor backed by `NSTextView`, bridged to Markdown.
///
/// The binding is the note's Markdown body (the on-disk contract). On load we render the
/// Markdown to an `NSAttributedString`; on edit we walk the attributed string back to
/// Markdown and push it through the binding. Supported constructs: Title (`# `),
/// Heading (`## `), Body, bullet (`- `), plus inline **bold** / *italic*.
struct RichTextEditor: NSViewRepresentable {
    @Binding var markdown: String
    /// Bumped by the toolbar to request a formatting command on the current selection.
    var command: EditorCommand?
    var onCommandHandled: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        guard let textView = scroll.documentView as? NSTextView else { return scroll }

        textView.delegate = context.coordinator
        textView.isRichText = true
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 14, height: 16)
        textView.font = MarkdownStyling.bodyFont
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true

        context.coordinator.textView = textView
        context.coordinator.apply(markdown: markdown)
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        guard let textView = coordinator.textView else { return }

        // If the markdown changed externally (e.g. switching notes), re-render.
        if coordinator.lastEmittedMarkdown != markdown && !coordinator.isEditing {
            coordinator.apply(markdown: markdown)
        }

        // Handle a pending toolbar command.
        if let command {
            coordinator.perform(command: command, on: textView)
            DispatchQueue.main.async { onCommandHandled() }
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        let parent: RichTextEditor
        weak var textView: NSTextView?
        var lastEmittedMarkdown: String?
        var isEditing = false

        init(_ parent: RichTextEditor) { self.parent = parent }

        /// Render Markdown into the text view as styled attributed text.
        func apply(markdown: String) {
            guard let textView else { return }
            let attributed = MarkdownStyling.attributedString(from: markdown)
            textView.textStorage?.setAttributedString(attributed)
            textView.typingAttributes = MarkdownStyling.bodyAttributes
            lastEmittedMarkdown = markdown
        }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            isEditing = true
            let md = MarkdownStyling.markdown(from: textView.attributedString())
            lastEmittedMarkdown = md
            parent.markdown = md
            DispatchQueue.main.async { self.isEditing = false }
        }

        // MARK: - Formatting commands

        func perform(command: EditorCommand, on textView: NSTextView) {
            switch command {
            case .bold: toggleTrait(.boldFontMask, on: textView)
            case .italic: toggleTrait(.italicFontMask, on: textView)
            case .title: applyBlockStyle(.title, on: textView)
            case .heading: applyBlockStyle(.heading, on: textView)
            case .body: applyBlockStyle(.body, on: textView)
            case .bullet: toggleBullet(on: textView)
            }
            // Emit updated markdown after a structural change.
            let md = MarkdownStyling.markdown(from: textView.attributedString())
            lastEmittedMarkdown = md
            parent.markdown = md
        }

        private func toggleTrait(_ trait: NSFontTraitMask, on textView: NSTextView) {
            let range = textView.selectedRange()
            guard range.length > 0, let storage = textView.textStorage else {
                // Toggle typing attribute for zero-length selection.
                let fm = NSFontManager.shared
                let current = (textView.typingAttributes[.font] as? NSFont) ?? MarkdownStyling.bodyFont
                let newFont = fm.convert(current, toHaveTrait: trait)
                var attrs = textView.typingAttributes
                attrs[.font] = newFont
                textView.typingAttributes = attrs
                return
            }
            let fm = NSFontManager.shared
            storage.beginEditing()
            storage.enumerateAttribute(.font, in: range) { value, subRange, _ in
                let font = (value as? NSFont) ?? MarkdownStyling.bodyFont
                let hasTrait = fm.traits(of: font).contains(trait)
                let newFont = hasTrait
                    ? fm.convert(font, toNotHaveTrait: trait)
                    : fm.convert(font, toHaveTrait: trait)
                storage.addAttribute(.font, value: newFont, range: subRange)
            }
            storage.endEditing()
        }

        private func applyBlockStyle(_ kind: RichTextMarkdown.BlockKind, on textView: NSTextView) {
            guard let storage = textView.textStorage else { return }
            let lineRange = (textView.string as NSString).lineRange(for: textView.selectedRange())
            let font: NSFont
            switch kind {
            case .title: font = MarkdownStyling.titleFont
            case .heading: font = MarkdownStyling.headingFont
            default: font = MarkdownStyling.bodyFont
            }
            storage.addAttribute(.font, value: font, range: lineRange)
            storage.addAttribute(MarkdownStyling.blockKindKey, value: kind.rawValue, range: lineRange)
        }

        private func toggleBullet(on textView: NSTextView) {
            guard let storage = textView.textStorage else { return }
            let ns = textView.string as NSString
            let lineRange = ns.lineRange(for: textView.selectedRange())
            let line = ns.substring(with: lineRange)
            if line.hasPrefix("• ") {
                storage.replaceCharacters(in: NSRange(location: lineRange.location, length: 2), with: "")
            } else {
                storage.replaceCharacters(in: NSRange(location: lineRange.location, length: 0), with: "• ")
            }
        }
    }
}

/// Toolbar commands the SwiftUI layer can request.
enum EditorCommand: Equatable {
    case bold, italic, title, heading, body, bullet
}
