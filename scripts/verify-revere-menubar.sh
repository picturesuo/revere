#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PATH="/Applications/Revere.app"
DIAGNOSTICS_PATH="$HOME/Library/Logs/Revere/diagnostics.txt"
BUILD_APP=1
TEST_MIRROR_PERSISTENCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      BUILD_APP=0
      ;;
    --test-mirror-persistence)
      TEST_MIRROR_PERSISTENCE=1
      ;;
    -h|--help)
      cat <<'HELP'
Usage: scripts/verify-revere-menubar.sh [--no-build] [--test-mirror-persistence]

By default this rebuilds, signs, installs, launches, and click-through verifies
Revere.app. Use --no-build after granting macOS Screen Recording permission so
the verifier preserves the installed app identity that macOS approved.

--test-mirror-persistence toggles Mirror Face Overlay off, relaunches Revere to
confirm the preference persisted, then toggles it back on.
HELP
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

menu_snapshot() {
  osascript <<'APPLESCRIPT'
tell application "System Events"
  if not (exists process "Revere") then error "Revere process not found"
  tell process "Revere"
    key code 53
    delay 0.1
    click menu bar item 1 of menu bar 1
    delay 0.2
    set itemNames to name of menu items of menu 1 of menu bar item 1 of menu bar 1
    key code 53
  end tell
end tell
return itemNames
APPLESCRIPT
}

click_menu_item() {
  local item_name="$1"
  osascript - "$item_name" <<'APPLESCRIPT'
on run argv
  set targetItem to item 1 of argv
  tell application "System Events"
    tell process "Revere"
      key code 53
      delay 0.1
      click menu bar item 1 of menu bar 1
      delay 0.2
      click menu item targetItem of menu 1 of menu bar item 1 of menu bar 1
    end tell
  end tell
  return ""
end run
APPLESCRIPT
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "expected menu to contain '$needle'"
  fi
}

menu_line() {
  local menu_text="$1"
  local needle="$2"
  printf '%s\n' "$menu_text" | tr ',' '\n' | sed 's/^ *//' | grep -F "$needle" | head -n 1 || true
}

run_recording_menu_test() {
  local item_name="$1"
  local label="$2"
  click_menu_item "$item_name"
  sleep 6
  local record_menu
  local record_line
  record_menu="$(menu_snapshot)"
  record_line="$(menu_line "$record_menu" "Recorder:")"
  echo "$label self-test: $record_line"
  [[ "$record_line" == *"saved"* ]] || fail "$label did not save a file: ${record_line:-missing}"
}

if [[ "$BUILD_APP" == "1" ]]; then
  echo "Building Revere menu-bar app..."
  "$ROOT_DIR/scripts/install-revere-menubar.sh" --no-start >/tmp/revere-menubar-install.txt
else
  echo "Using existing installed Revere.app without rebuilding..."
  [[ -x "$APP_PATH/Contents/MacOS/Revere" ]] || fail "$APP_PATH is not installed"
fi
codesign --verify --deep --strict "$APP_PATH"

pkill -INT ffmpeg >/dev/null 2>&1 || true
sleep 1
pkill -KILL ffmpeg >/dev/null 2>&1 || true
pkill -x Revere >/dev/null 2>&1 || true
sleep 1
open "$APP_PATH"
sleep 2

pgrep -fl "/Applications/Revere.app/Contents/MacOS/Revere" >/dev/null || fail "Revere did not launch"

initial_menu="$(menu_snapshot)"
assert_contains "$initial_menu" "Permissions:"
assert_contains "$initial_menu" "Test Capture Once"
assert_contains "$initial_menu" "Test Diff Engine"
assert_contains "$initial_menu" "Notify on Changes:"
assert_contains "$initial_menu" "Record 3s Screen Test"
assert_contains "$initial_menu" "Record 3s Screen + Face Test"
assert_contains "$initial_menu" "Request Camera Permission"
assert_contains "$initial_menu" "Request Notification Permission"
assert_contains "$initial_menu" "Record 3s Face Test"
assert_contains "$initial_menu" "Test Recording Plan"
assert_contains "$initial_menu" "Write Diagnostics Report"
assert_contains "$initial_menu" "Run Self-Test"
assert_contains "$initial_menu" "Launch at Login:"
assert_contains "$initial_menu" "Mirror Face Overlay: On"

if [[ "$TEST_MIRROR_PERSISTENCE" == "1" ]]; then
  click_menu_item "Mirror Face Overlay: On"
  sleep 0.5
  pkill -x Revere >/dev/null 2>&1 || true
  sleep 1
  open "$APP_PATH"
  sleep 2
  mirror_menu="$(menu_snapshot)"
  assert_contains "$mirror_menu" "Mirror Face Overlay: Off"
  click_menu_item "Mirror Face Overlay: Off"
  sleep 0.5
  restored_menu="$(menu_snapshot)"
  assert_contains "$restored_menu" "Mirror Face Overlay: On"
  echo "Mirror persistence self-test: off survived relaunch and was restored to on."
fi

rm -f "$DIAGNOSTICS_PATH"
click_menu_item "Write Diagnostics Report"
for _ in {1..20}; do
  [[ -s "$DIAGNOSTICS_PATH" ]] && break
  sleep 0.25
done
[[ -s "$DIAGNOSTICS_PATH" ]] || fail "diagnostics report was not written"
grep -q "Revere Diagnostics" "$DIAGNOSTICS_PATH" || fail "diagnostics report has unexpected content"

click_menu_item "Test Diff Engine"
sleep 0.5
diff_menu="$(menu_snapshot)"
diff_line="$(menu_line "$diff_menu" "Diff engine:")"
[[ "$diff_line" == *"OK"* ]] || fail "diff engine self-test failed: ${diff_line:-missing}"
echo "Diff self-test: $diff_line"

click_menu_item "Test Recording Plan"
sleep 2
plan_menu="$(menu_snapshot)"
plan_line="$(menu_line "$plan_menu" "Recording plan:")"
[[ "$plan_line" == *"OK"* ]] || fail "recording plan self-test failed: ${plan_line:-missing}"
[[ "$plan_line" == *"screen+face overlay"* ]] || fail "recording plan did not prove face overlay: ${plan_line:-missing}"
echo "Recording plan self-test: $plan_line"

click_menu_item "Run Self-Test"
sleep 2
self_test_menu="$(menu_snapshot)"
self_test_line="$(menu_line "$self_test_menu" "Self-test:")"
[[ "$self_test_line" == *"diff OK"* ]] || fail "self-test did not prove diff engine: ${self_test_line:-missing}"
[[ "$self_test_line" == *"ffmpeg OK"* ]] || fail "self-test did not find ffmpeg: ${self_test_line:-missing}"
[[ "$self_test_line" == *"record plan OK"* ]] || fail "self-test did not prove recording plan: ${self_test_line:-missing}"
[[ "$self_test_line" == *"notify "* ]] || fail "self-test did not include notification state: ${self_test_line:-missing}"
echo "Full self-test: $self_test_line"

click_menu_item "Retest Permissions"
sleep 0.5
permission_menu="$(menu_snapshot)"
permission_line="$(menu_line "$permission_menu" "Permissions:")"
camera_ready=0
if [[ "$permission_line" == *"Camera granted"* ]]; then
  camera_ready=1
fi
echo "Permission state:"
echo "$permission_line"

click_menu_item "Test Capture Once"
sleep 1
capture_menu="$(menu_snapshot)"
capture_line="$(menu_line "$capture_menu" "Capture test:")"
[[ -n "$capture_line" ]] || fail "capture self-test did not report a result"
echo "Capture self-test: $capture_line"

if [[ "$capture_line" == *"OK"* ]]; then
  echo "Screen capture permission is active; running visual watch and recording tests."
  click_menu_item "Start Visual Watch"
  sleep 5
  watch_menu="$(menu_snapshot)"
  watch_line="$(menu_line "$watch_menu" "Visual Watch:")"
  watch_diff_line="$(menu_line "$watch_menu" "Last diff:")"
  echo "Visual watch self-test: $watch_line / $watch_diff_line"
  [[ "$watch_line" == *"running every 2s"* ]] || fail "visual watch did not start: ${watch_line:-missing}"
  [[ "$watch_diff_line" == *"samples"* ]] || fail "visual watch did not capture samples: ${watch_diff_line:-missing}"
  click_menu_item "Stop Visual Watch"
  sleep 0.5

  run_recording_menu_test "Record 3s Screen Test" "Screen recording"
  if [[ "$camera_ready" == "1" ]]; then
    run_recording_menu_test "Record 3s Screen + Face Test" "Screen + face recording"
    run_recording_menu_test "Record 3s Face Test" "Face recording"
  else
    echo "Camera permission is not active yet; face recording self-tests remain permission-gated."
  fi
else
  echo "Screen capture permission is not active yet; recording self-tests remain permission-gated."
fi

if pgrep -fl "ffmpeg" >/dev/null; then
  pgrep -fl "ffmpeg"
  fail "ffmpeg process left running"
fi

echo "PASS: menu-bar app launched, menu controls clicked, and self-tests reported a usable state."
