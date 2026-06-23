import OpenNotesCore
import SwiftUI

/// Design tokens and reusable Liquid Glass helpers for Hasna Notes.
enum Theme {
    /// Infinity-purple accent used for selection highlights and small affordances.
    static let accent = Color(red: 0.50, green: 0.30, blue: 0.90)
    static let cornerLarge: CGFloat = 22
    static let cornerMedium: CGFloat = 14
    static let cornerSmall: CGFloat = 9

    /// Target sidebar width — deliberately narrow (Apple-Notes-ish).
    static let sidebarWidth: CGFloat = 196

    /// The clean main canvas color. Pure white in light mode (the user's explicit ask);
    /// the system window background in dark mode (don't force white over dark).
    static func canvas(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(NSColor.windowBackgroundColor) : .white
    }

    /// "Infinity purple" sidebar gradient: deep violet → indigo → magenta. Rendered
    /// behind the Liquid Glass sidebar so the glass refracts the color. Darkened a touch
    /// in dark mode so text stays legible.
    static func sidebarGradient(_ scheme: ColorScheme) -> LinearGradient {
        let colors: [Color] = scheme == .dark
            ? [Color(red: 0.18, green: 0.07, blue: 0.34),
               Color(red: 0.22, green: 0.10, blue: 0.42),
               Color(red: 0.34, green: 0.10, blue: 0.40)]
            : [Color(red: 0.34, green: 0.16, blue: 0.64),   // deep violet
               Color(red: 0.30, green: 0.18, blue: 0.72),   // indigo
               Color(red: 0.52, green: 0.16, blue: 0.62)]   // magenta
        return LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom)
    }
}

extension View {
    /// Apply a Liquid Glass surface on macOS 26+, falling back to `.ultraThinMaterial`
    /// (and honoring reduce-transparency) on earlier systems. Used sparingly — chiefly
    /// for the purple sidebar — never as boxed panels in the main canvas.
    @ViewBuilder
    func glassSurface(cornerRadius: CGFloat, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(macOS 26.0, *) {
            self.modifier(GlassSurface(cornerRadius: cornerRadius, tint: tint, interactive: interactive))
        } else {
            self
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(.white.opacity(0.12), lineWidth: 0.5)
                )
        }
    }
}

@available(macOS 26.0, *)
private struct GlassSurface: ViewModifier {
    let cornerRadius: CGFloat
    let tint: Color?
    let interactive: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if reduceTransparency {
            return AnyView(
                content
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .strokeBorder(.white.opacity(0.12), lineWidth: 0.5)
                    )
            )
        } else {
            var glass: Glass = .regular
            if let tint { glass = glass.tint(tint.opacity(0.35)) }
            if interactive { glass = glass.interactive() }
            return AnyView(content.glassEffect(glass, in: .rect(cornerRadius: cornerRadius)))
        }
    }
}

extension Date {
    /// Compact relative description for list rows, e.g. "2h ago", "Yesterday".
    var relativeDescription: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: self, relativeTo: Date())
    }
}
