# Knowledge

## User-Provided Knowledge
- Capture durable user guidance, preferences, and constraints that should survive past a single task.
- user: Prefer simplified skills: compact descriptions, minimal workflow text, clear trigger nouns, and narrow repo-specific guidance instead of duplicating broad built-in skills.

## Project Facts
- Capture stable project facts, decisions, and summaries worth reusing across tasks.
- repo: The popup's "Open Dashboard" action now opens `options.html` via `chrome.tabs.create`, and test notifications report whether a phone destination is configured while surfacing ntfy/webhook delivery failures in strict test mode.
- repo: CodexBar research is captured in `docs/codexbar-research.md`; Revere now treats visual screenshot diffs, DOM/network signals, desktop bridge events, and agent-attention posts as provider-like alert sources.
- repo: `npm run check` includes `scripts/verify-extension-logic.mjs`, which verifies the Chrome extension visual-diff thresholds, tiny 128x72 grayscale sample size, edge-strip filtering, URL capture guards, watch rotation, and notification template rendering without needing a live Chrome session.
- repo: The native macOS companion lives under `macos/RevereMenuBar/main.m` and is built by `scripts/build-revere-menubar.sh` into `build/Revere.app`; it uses an AppKit status item with a template white Revere icon, 2-second in-memory visual watch sampling, throttled UserNotifications-based Notify on Changes alerts, synthetic visual-diff self-tests, Screen Recording/Camera permission preflights, permission settings/retest controls, one-shot capture and 3-second screen/screen+face/face-only recording self-tests, a recording-plan dry run, and ffmpeg-based screen/camera recording controls.
- repo: `scripts/verify-revere-menubar.sh` rebuilds, signs, installs, and verifies the native menu-bar app without foreground UI control by default. Visible menu-bar click-through now requires explicit `--foreground-ui`; use `--no-build --foreground-ui` after granting Screen Recording permission so the verifier preserves the installed app identity that macOS approved. Once Screen Recording is granted, the foreground verifier also starts/stops Visual Watch and checks sample updates; once Camera is already granted, it runs screen+face and face-only recording tests without triggering a new prompt.
- repo: `scripts/install-revere-menubar.sh` installs the signed native app to `/Applications/Revere.app`; `--login` writes a `dev.revere.menubar` LaunchAgent so it opens at login.
- repo: The native menu-bar app can write `~/Library/Logs/Revere/diagnostics.txt` with permission, device, ffmpeg, codesign, Launch at Login, recording, mirror, and visual-watch state.
- repo: The native menu-bar app has a `Launch at Login` menu toggle backed by `~/Library/LaunchAgents/dev.revere.menubar.plist`; the verifier checks for the menu item but does not click it.
- repo: Mirror Face Overlay persists through `NSUserDefaults` key `mirrorCamera`; the verifier can exercise this with `--test-mirror-persistence` and restores the setting to on.
- repo: The native menu-bar app has a `Run Self-Test` item that summarizes diff engine, capture availability, screen/camera device discovery, ffmpeg, recording-plan readiness, notification state, and mirror state; this gives a useful proof even before Screen Recording permission is granted.

## Retrieval Hints
- Search this file, the shared context file, and nearby repo docs with `rg` before broader search.
- Label each note by source when useful: `user`, `repo`, or `external`.
