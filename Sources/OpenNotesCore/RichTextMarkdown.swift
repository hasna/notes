import Foundation

/// A minimal, faithful bridge between the on-disk Markdown body and an in-memory
/// rich-text document. The data contract requires note bodies to stay Markdown on
/// disk (`# Heading`, `**bold**`, `*italic*`, `- bullet`), so the editor edits a
/// structured document and we convert to/from Markdown on load/save.
///
/// This intentionally supports only the handful of constructs an Apple-Notes-style
/// editor needs — it is NOT a general Markdown engine. It is pure (no UI / AppKit)
/// so it can be unit-tested in `OpenNotesSmoke`.
public enum RichTextMarkdown {

    /// Block-level kind of a line in the document.
    public enum BlockKind: String, Equatable, Sendable {
        case title      // `# `
        case heading    // `## `
        case body       // plain paragraph text
        case bullet     // `- `
    }

    /// An inline run of text with bold/italic attributes.
    public struct InlineRun: Equatable, Sendable {
        public var text: String
        public var bold: Bool
        public var italic: Bool

        public init(text: String, bold: Bool = false, italic: Bool = false) {
            self.text = text
            self.bold = bold
            self.italic = italic
        }
    }

    /// One logical line / block of the document.
    public struct Block: Equatable, Sendable {
        public var kind: BlockKind
        public var runs: [InlineRun]

        public init(kind: BlockKind, runs: [InlineRun]) {
            self.kind = kind
            self.runs = runs
        }

        /// Plain text of the block with inline markers stripped.
        public var plainText: String {
            runs.map(\.text).joined()
        }
    }

    /// A parsed document: an ordered list of blocks.
    public struct Document: Equatable, Sendable {
        public var blocks: [Block]
        public init(blocks: [Block]) { self.blocks = blocks }
    }

    // MARK: - Markdown -> Document

    /// Parse a Markdown body into a structured document. Each source line becomes one
    /// block; the block kind is inferred from a leading `# `, `## `, or `- ` marker.
    public static func parse(markdown: String) -> Document {
        let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        var blocks: [Block] = []
        for line in lines {
            blocks.append(parseLine(line))
        }
        return Document(blocks: blocks)
    }

    private static func parseLine(_ line: String) -> Block {
        if line.hasPrefix("# ") {
            return Block(kind: .title, runs: parseInline(String(line.dropFirst(2))))
        }
        if line.hasPrefix("## ") {
            return Block(kind: .heading, runs: parseInline(String(line.dropFirst(3))))
        }
        if line.hasPrefix("- ") {
            return Block(kind: .bullet, runs: parseInline(String(line.dropFirst(2))))
        }
        return Block(kind: .body, runs: parseInline(line))
    }

    /// Parse inline `**bold**`, `*italic*`, and `***bold italic***` markers into runs.
    ///
    /// EMPHASIS SEMANTICS (chosen approach — see also `markdownInline`):
    /// A delimiter run of `*` / `**` / `***` opens emphasis ONLY when a matching closing
    /// delimiter of the SAME length appears later on the same line. We resolve this with a
    /// balanced multi-pass scan:
    ///   1. Tokenize the line into asterisk-delimiter tokens and literal characters. A run
    ///      of 1–3 asterisks is a *candidate* delimiter; any run of 4+ asterisks is wholly
    ///      literal (so a lone `****` survives byte-exact).
    ///   2. Pair candidate delimiters left-to-right, each opener with the nearest later
    ///      delimiter of the SAME length (a stack per length, so nesting such as
    ///      `**a *b* c**` pairs correctly). Any delimiter left unpaired is demoted to
    ///      LITERAL asterisks.
    ///   3. Emit runs, toggling emphasis only across matched pairs.
    ///
    /// Consequences: stray `*`, unclosed `**bold`, multiplication (`5 * 3`), globs
    /// (`C:\*.txt`), and mid-typing markers survive byte-exact (defect #1). Overlapping /
    /// nested matched pairs are flattened into NON-OVERLAPPING runs — each run carries the
    /// union of the emphasis active over it — so `markdownInline` always emits minimal,
    /// VALID markdown with no 4+/5+ asterisk runs (defect #2).
    public static func parseInline(_ text: String) -> [InlineRun] {
        // --- Pass 1: tokenize into delimiter tokens and literal characters. ---
        enum Token { case delim(length: Int, index: Int); case text(Character) }
        let chars = Array(text)
        var tokens: [Token] = []
        var i = 0
        var delimCount = 0
        while i < chars.count {
            if chars[i] == "*" {
                var len = 0
                while i < chars.count && chars[i] == "*" { len += 1; i += 1 }
                if len >= 1 && len <= 3 {
                    tokens.append(.delim(length: len, index: delimCount))
                    delimCount += 1
                } else {
                    // 4+ asterisks: never a delimiter, keep all of them literal.
                    for _ in 0..<len { tokens.append(.text("*")) }
                }
            } else {
                tokens.append(.text(chars[i]))
                i += 1
            }
        }

        // --- Pass 2: pair delimiters of equal length (nearest later match, stack/length). ---
        var isMatched = [Bool](repeating: false, count: delimCount)
        var openStacks: [Int: [Int]] = [1: [], 2: [], 3: []]   // length -> [token position of opener]
        for (pos, tok) in tokens.enumerated() {
            guard case let .delim(length, idx) = tok else { continue }
            if let openPos = openStacks[length]?.last {
                // A matching opener of the same length appeared earlier -> this is its closer.
                openStacks[length]?.removeLast()
                if case let .delim(_, openIdx) = tokens[openPos] { isMatched[openIdx] = true }
                isMatched[idx] = true
            } else {
                openStacks[length, default: []].append(pos)
            }
        }

        // --- Pass 3: build non-overlapping runs; unmatched delimiters become literal `*`. ---
        var runs: [InlineRun] = []
        var current = ""
        var boldDepth = 0
        var italicDepth = 0

        func flush() {
            if !current.isEmpty {
                runs.append(InlineRun(text: current, bold: boldDepth > 0, italic: italicDepth > 0))
                current = ""
            }
        }

        for tok in tokens {
            switch tok {
            case let .delim(length, idx):
                if isMatched[idx] {
                    flush()
                    // Matched delimiters toggle; with balanced pairing the depth is 0/1 each.
                    switch length {
                    case 1: italicDepth += italicDepth > 0 ? -1 : 1
                    case 2: boldDepth += boldDepth > 0 ? -1 : 1
                    default: // 3 == bold + italic
                        boldDepth += boldDepth > 0 ? -1 : 1
                        italicDepth += italicDepth > 0 ? -1 : 1
                    }
                } else {
                    current += String(repeating: "*", count: length)
                }
            case let .text(c):
                current.append(c)
            }
        }
        flush()

        // Merge adjacent runs with identical attributes (keeps output minimal/canonical).
        var merged: [InlineRun] = []
        for run in runs {
            if var last = merged.last, last.bold == run.bold, last.italic == run.italic {
                last.text += run.text
                merged[merged.count - 1] = last
            } else {
                merged.append(run)
            }
        }
        if merged.isEmpty { merged = [InlineRun(text: "")] }
        return merged
    }

    // MARK: - Document -> Markdown

    /// Serialize a document back to Markdown. The inverse of `parse(markdown:)` for the
    /// supported construct set; round-trips faithfully for title/heading/body/bullet and
    /// bold/italic inline runs.
    public static func markdown(from document: Document) -> String {
        document.blocks.map(markdownLine(for:)).joined(separator: "\n")
    }

    private static func markdownLine(for block: Block) -> String {
        let inline = markdownInline(block.runs)
        switch block.kind {
        case .title: return "# " + inline
        case .heading: return "## " + inline
        case .bullet: return "- " + inline
        case .body: return inline
        }
    }

    /// Emit inline Markdown for a list of NON-OVERLAPPING attributed runs (defect #2
    /// semantics). A stack-based emitter keeps emphasis open across adjacent runs that
    /// share an attribute and only writes the DELTA at each boundary: it closes attributes
    /// (in LIFO order) that the next run drops and opens attributes the next run adds.
    /// Each attribute is one delimiter — `*` italic, `**` bold — so output is always valid
    /// markdown with minimal, correctly-balanced delimiters and never a 4+/5+ asterisk run.
    /// (A bold+italic run still serializes as `***…***` when isolated.)
    public static func markdownInline(_ runs: [InlineRun]) -> String {
        enum Attr { case bold, italic }
        func delim(_ a: Attr) -> String { a == .bold ? "**" : "*" }

        func key(_ a: Attr) -> Int { a == .bold ? 0 : 1 }

        let visible = runs.filter { !$0.text.isEmpty }
        var out = ""
        var stack: [Attr] = []   // currently-open attributes, in the order they were opened

        for run in visible {
            var want: [Attr] = []
            if run.bold { want.append(.bold) }
            if run.italic { want.append(.italic) }
            let wantSet = Set(want.map(key))

            // If any open attr that the run STILL wants sits below an unwanted attr, we
            // can only close from the top (LIFO). So unwind the stack until everything
            // unwanted is gone, even if that means temporarily closing wanted attrs; the
            // open step re-opens them. This keeps delimiters balanced for any input,
            // including Documents built directly by the editor (not just balanced parses).
            if let deepestUnwanted = stack.firstIndex(where: { !wantSet.contains(key($0)) }) {
                while stack.count > deepestUnwanted {
                    out += delim(stack.removeLast())
                }
            }

            // Open wanted attrs not currently open, bold before italic, so an isolated
            // bold+italic run yields `***…***`.
            for a in want where !stack.contains(where: { $0 == a }) {
                out += delim(a)
                stack.append(a)
            }
            out += run.text
        }
        // Close everything still open at end of line, LIFO.
        while !stack.isEmpty { out += delim(stack.removeLast()) }
        return out
    }

    /// Convenience: normalize a Markdown body through parse → serialize. Useful for tests
    /// and to canonicalize bodies (e.g. collapsing `***x***` ordering).
    public static func roundTrip(_ markdown: String) -> String {
        self.markdown(from: parse(markdown: markdown))
    }
}
