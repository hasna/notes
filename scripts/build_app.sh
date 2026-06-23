#!/usr/bin/env bash
# Build Hasna Notes with SwiftPM and hand-assemble a launchable .app bundle.
# Run this ON a macOS 26 Mac (Command Line Tools only — no Xcode) inside the repo.
#
# The SwiftPM executable target is still named `OpenNotes` (renaming it is risky), but
# the assembled bundle is "Hasna Notes.app" with CFBundleName "Hasna Notes".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# SwiftPM executable target name (unchanged) vs. the user-facing app name.
TARGET_NAME="OpenNotes"
APP_NAME="Hasna Notes"
EXEC_NAME="HasnaNotes"
BUNDLE_ID="com.hasna.notes"
DIST="$REPO_ROOT/dist"
APP="$DIST/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

echo "==> swift build -c release"
swift build -c release

BIN_PATH="$(swift build -c release --show-bin-path)"
BUILT_BINARY="$BIN_PATH/$TARGET_NAME"
if [[ ! -f "$BUILT_BINARY" ]]; then
  echo "ERROR: built binary not found at $BUILT_BINARY" >&2
  exit 1
fi

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$RESOURCES"
cp "$BUILT_BINARY" "$MACOS_DIR/$EXEC_NAME"
chmod +x "$MACOS_DIR/$EXEC_NAME"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>
    <key>CFBundleExecutable</key>
    <string>$EXEC_NAME</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>26.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
</dict>
</plist>
PLIST

# Generate a simple app icon if iconutil/sips are available (bonus, non-fatal).
if command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  echo "==> Generating AppIcon.icns"
  ICONSET="$DIST/AppIcon.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  # Solid-tint base PNG via sips from a generated raw image using printf is hard;
  # instead derive from a system template if present, else skip gracefully.
  if /usr/bin/python3 - "$ICONSET" <<'PY' 2>/dev/null; then
import sys, struct, zlib, os
iconset = sys.argv[1]
def png(path, size, rgba):
    w = h = size
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            # subtle diagonal gradient on the accent color
            t = (x + y) / (2.0 * size)
            r = int(rgba[0] * (0.75 + 0.25 * t))
            g = int(rgba[1] * (0.75 + 0.25 * t))
            b = int(rgba[2] * (0.85 + 0.15 * (1 - t)))
            raw += bytes((min(r,255), min(g,255), min(b,255), 255))
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))
accent = (115, 140, 255)
for size in (16, 32, 64, 128, 256, 512, 1024):
    png(os.path.join(iconset, f"icon_{size}x{size}.png"), size, accent)
    png(os.path.join(iconset, f"icon_{size//2}x{size//2}@2x.png"), size, accent)
PY
    iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns" 2>/dev/null || echo "   (iconutil failed; continuing without icon)"
    rm -rf "$ICONSET"
  else
    echo "   (icon generation skipped; continuing without icon)"
  fi
else
  echo "==> sips/iconutil unavailable; skipping app icon"
fi

# Rewrite Info.plist icon key now that we know whether the icns exists.
if [[ -f "$RESOURCES/AppIcon.icns" ]]; then
  /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon" "$CONTENTS/Info.plist" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile AppIcon" "$CONTENTS/Info.plist" 2>/dev/null || true
fi

echo "==> Ad-hoc codesign"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP" && echo "   signature OK"

echo ""
echo "BUILT: $APP"
echo "       (CFBundleName=\"$APP_NAME\", bundle id=$BUNDLE_ID, exec=$EXEC_NAME)"
