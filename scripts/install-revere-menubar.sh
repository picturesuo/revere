#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PATH="/Applications/Revere.app"
AGENT_ID="dev.revere.menubar"
AGENT_PATH="$HOME/Library/LaunchAgents/$AGENT_ID.plist"
ENABLE_LOGIN=0
START_NOW=1

usage() {
  cat <<'HELP'
Usage: scripts/install-revere-menubar.sh [--login] [--no-start]

Builds, signs, and installs Revere.app into /Applications.

Options:
  --login     Install a LaunchAgent so Revere opens at login.
  --no-start  Install without launching Revere now.
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --login)
      ENABLE_LOGIN=1
      ;;
    --no-start)
      START_NOW=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

"$ROOT_DIR/scripts/build-revere-menubar.sh" >/tmp/revere-menubar-build-path.txt

pkill -INT ffmpeg >/dev/null 2>&1 || true
sleep 1
pkill -KILL ffmpeg >/dev/null 2>&1 || true
pkill -x Revere >/dev/null 2>&1 || true
sleep 1

rm -rf "$APP_PATH"
ditto --noextattr --noqtn "$ROOT_DIR/build/Revere.app" "$APP_PATH"
xattr -d com.apple.FinderInfo "$APP_PATH" >/dev/null 2>&1 || true
codesign --verify --deep --strict "$APP_PATH"

if [[ "$ENABLE_LOGIN" == "1" ]]; then
  mkdir -p "$(dirname "$AGENT_PATH")"
  cat > "$AGENT_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$AGENT_ID</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>$APP_PATH</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST
  plutil -lint "$AGENT_PATH" >/dev/null
  launchctl bootout "gui/$(id -u)" "$AGENT_PATH" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$AGENT_PATH"
fi

if [[ "$START_NOW" == "1" ]]; then
  open "$APP_PATH"
fi

echo "Installed $APP_PATH"
if [[ "$ENABLE_LOGIN" == "1" ]]; then
  echo "Launch at login enabled via $AGENT_PATH"
fi
