import AppKit
import OpenNotesCore

/// Bridges Markdown text ↔ a styled `NSAttributedString` for the rich-text editor.
///
/// Block structure (title/heading/body/bullet) and inline emphasis (bold/italic) are
/// parsed by the pure `RichTextMarkdown` type; this file only maps those to AppKit fonts
/// and back. A custom attribute key records each line's block kind so a line that is a
/// heading-with-default-size still serializes correctly.
@MainActor
enum MarkdownStyling {
    static let blockKindKey = NSAttributedString.Key("hasnaNotesBlockKind")

    static let bodyFont = NSFont.systemFont(ofSize: 14)
    static let titleFont = NSFont.boldSystemFont(ofSize: 22)
    static let headingFont = NSFont.boldSystemFont(ofSize: 17)

    static var bodyAttributes: [NSAttributedString.Key: Any] {
        [.font: bodyFont, .foregroundColor: NSColor.labelColor]
    }

    // MARK: - Markdown -> AttributedString

    static func attributedString(from markdown: String) -> NSAttributedString {
        let doc = RichTextMarkdown.parse(markdown: markdown)
        let result = NSMutableAttributedString()
        for (index, block) in doc.blocks.enumerated() {
            let blockFont: NSFont
            switch block.kind {
            case .title: blockFont = titleFont
            case .heading: blockFont = headingFont
            case .body, .bullet: blockFont = bodyFont
            }
            if block.kind == .bullet {
                result.append(NSAttributedString(
                    string: "• ",
                    attributes: [.font: blockFont, .foregroundColor: NSColor.labelColor,
                                 blockKindKey: block.kind.rawValue]))
            }
            for run in block.runs {
                let fm = NSFontManager.shared
                var font = blockFont
                if run.bold { font = fm.convert(font, toHaveTrait: .boldFontMask) }
                if run.italic { font = fm.convert(font, toHaveTrait: .italicFontMask) }
                result.append(NSAttributedString(
                    string: run.text,
                    attributes: [.font: font, .foregroundColor: NSColor.labelColor,
                                 blockKindKey: block.kind.rawValue]))
            }
            if index < doc.blocks.count - 1 {
                result.append(NSAttributedString(
                    string: "\n",
                    attributes: [.font: bodyFont, blockKindKey: block.kind.rawValue]))
            }
        }
        return result
    }

    // MARK: - AttributedString -> Markdown

    static func markdown(from attributed: NSAttributedString) -> String {
        let full = attributed.string as NSString
        var blocks: [RichTextMarkdown.Block] = []
        var lineStart = 0
        let length = full.length

        func emitLine(_ range: NSRange) {
            let lineStr = full.substring(with: range)
            // Determine block kind from the dominant attribute / font in the line.
            var kind = blockKind(in: attributed, lineRange: range, lineString: lineStr)
            var content = lineStr
            // A bullet line stores a literal "• " prefix; strip it for markdown emission.
            if content.hasPrefix("• ") {
                content = String(content.dropFirst(2))
                kind = .bullet
            }
            let runs = inlineRuns(in: attributed, lineString: content, lineRange: range)
            blocks.append(RichTextMarkdown.Block(kind: kind, runs: runs))
        }

        while lineStart < length {
            let lineRange = full.lineRange(for: NSRange(location: lineStart, length: 0))
            // Exclude the trailing newline from the content range.
            var contentRange = lineRange
            if contentRange.length > 0,
               full.substring(with: NSRange(location: NSMaxRange(contentRange) - 1, length: 1)) == "\n" {
                contentRange.length -= 1
            }
            emitLine(contentRange)
            lineStart = NSMaxRange(lineRange)
            if lineRange.length == 0 { break }
        }
        // Handle a trailing empty final line (string ending in "\n").
        if length > 0, full.substring(with: NSRange(location: length - 1, length: 1)) == "\n" {
            blocks.append(RichTextMarkdown.Block(kind: .body, runs: [RichTextMarkdown.InlineRun(text: "")]))
        }
        if blocks.isEmpty {
            blocks = [RichTextMarkdown.Block(kind: .body, runs: [RichTextMarkdown.InlineRun(text: "")])]
        }
        return RichTextMarkdown.markdown(from: RichTextMarkdown.Document(blocks: blocks))
    }

    private static func blockKind(in attributed: NSAttributedString, lineRange: NSRange, lineString: String) -> RichTextMarkdown.BlockKind {
        guard lineRange.length > 0 else { return .body }
        // Prefer the explicit stored block kind (set by block-style commands).
        if let raw = attributed.attribute(blockKindKey, at: lineRange.location, effectiveRange: nil) as? String,
           let kind = RichTextMarkdown.BlockKind(rawValue: raw) {
            return kind
        }
        // Else infer from font size at line start.
        if let font = attributed.attribute(.font, at: lineRange.location, effectiveRange: nil) as? NSFont {
            if font.pointSize >= titleFont.pointSize { return .title }
            if font.pointSize >= headingFont.pointSize { return .heading }
        }
        return .body
    }

    /// Walk the attributed substring for one line and build bold/italic runs.
    private static func inlineRuns(in attributed: NSAttributedString, lineString: String, lineRange: NSRange) -> [RichTextMarkdown.InlineRun] {
        guard lineRange.length > 0 else {
            return [RichTextMarkdown.InlineRun(text: "")]
        }
        // The content range may be offset by a stripped bullet prefix; re-derive by
        // locating lineString within the original line. Simpler: enumerate attributes over
        // the content portion of the line by walking the same characters.
        let fm = NSFontManager.shared
        var runs: [RichTextMarkdown.InlineRun] = []
        // Determine offset of content within the original line (for the bullet case).
        let fullLine = (attributed.string as NSString).substring(with: lineRange)
        let bulletOffset = fullLine.hasPrefix("• ") ? 2 : 0

        let contentNSRange = NSRange(location: lineRange.location + bulletOffset,
                                     length: max(0, lineRange.length - bulletOffset))
        if contentNSRange.length == 0 {
            return [RichTextMarkdown.InlineRun(text: "")]
        }
        attributed.enumerateAttribute(.font, in: contentNSRange) { value, subRange, _ in
            let font = (value as? NSFont) ?? bodyFont
            let traits = fm.traits(of: font)
            let bold = traits.contains(.boldFontMask)
            // Titles/headings are bold by font but shouldn't emit **; detect via size.
            let isStructuralBold = font.pointSize >= headingFont.pointSize
            let italic = traits.contains(.italicFontMask)
            let text = (attributed.string as NSString).substring(with: subRange)
            runs.append(RichTextMarkdown.InlineRun(
                text: text,
                bold: bold && !isStructuralBold,
                italic: italic))
        }
        if runs.isEmpty { runs = [RichTextMarkdown.InlineRun(text: "")] }
        return runs
    }
}
