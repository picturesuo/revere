#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/build/Revere.app"
BUILD_BIN_DIR="$ROOT_DIR/build/bin"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/revere-menubar.XXXXXX")"
STAGE_APP_DIR="$STAGE_DIR/Revere.app"
CONTENTS_DIR="$STAGE_APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

mkdir -p "$BUILD_BIN_DIR"
clang \
  -fobjc-arc \
  "$ROOT_DIR/macos/RevereMenuBar/main.m" \
  -framework Cocoa \
  -framework AVFoundation \
  -framework CoreGraphics \
  -framework UserNotifications \
  -o "$BUILD_BIN_DIR/Revere"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$BUILD_BIN_DIR/Revere" "$MACOS_DIR/Revere"
cp "$ROOT_DIR/icon-128.png" "$RESOURCES_DIR/RevereStatusIcon.png"

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Revere</string>
  <key>CFBundleExecutable</key>
  <string>Revere</string>
  <key>CFBundleIdentifier</key>
  <string>dev.revere.menubar</string>
  <key>CFBundleName</key>
  <string>Revere</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSCameraUsageDescription</key>
  <string>Revere records your camera only when you start a face-overlay recording.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Revere currently records video-only, but macOS may ask before AV capture devices are listed.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Revere watches visual screen changes and records your screen only when you start those actions.</string>
</dict>
</plist>
PLIST

if command -v codesign >/dev/null 2>&1; then
  xattr -cr "$STAGE_APP_DIR" >/dev/null 2>&1 || true
  codesign --force --deep --sign - "$STAGE_APP_DIR" >/dev/null
fi

rm -rf "$APP_DIR"
ditto --noextattr --noqtn "$STAGE_APP_DIR" "$APP_DIR"

echo "$APP_DIR"
