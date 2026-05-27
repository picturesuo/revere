# Queue

## Now
- [x] Initialize the first real task artifact.
- [x] Build and click-through test the native macOS menu-bar controls.
- [x] Add and click-through test the native permission status/retest/settings controls.
- [x] Add menu-bar self-tests for one-shot capture and 3-second screen/screen+face recordings.
- [x] Add `scripts/verify-revere-menubar.sh` for repeatable menu-bar click-through verification.
- [x] Add `scripts/verify-revere-menubar.sh --no-build` so the final permission proof does not reinstall and invalidate the approved app identity.
- [x] Add camera permission and 3-second mirrored face-only recording test controls.
- [x] Add `scripts/install-revere-menubar.sh` for build/sign/install and optional launch-at-login setup.
- [x] Add native diagnostics report generation and verify it from the menu-bar click-through script.
- [x] Add native Launch at Login status/toggle menu control.
- [x] Add native synthetic visual-diff engine self-test and verify it from the menu-bar click-through script.
- [x] Persist Mirror Face Overlay setting and verify it survives relaunch.
- [x] Add native Run Self-Test summary for diff, capture availability, devices, ffmpeg, and mirror state.
- [x] Add native recording-plan dry run and verify screen, screen+face overlay, ffmpeg, and mirror wiring before privacy-gated recording.
- [x] Extend menu-bar verifier so granted Screen Recording proves live visual-watch sampling and granted Camera proves screen+face and face-only recording.
- [x] Add extension visual-diff logic verifier for screenshot sample size, edge-noise filtering, capture guards, and templates.
- [x] Add native Notify on Changes toggle so visual watch can send throttled macOS notifications for meaningful screen changes.
- [x] Make menu-bar verification screen-safe by default; foreground menu clicking now requires explicit `--foreground-ui`.
- [ ] Verify CodexBar-inspired visual monitoring and attention notification changes in Chrome.
- [ ] Grant macOS Screen & System Audio Recording permission and re-test native visual watch/recording with real pixels.

## Next
- [ ] Add per-watch capture mode controls.
- [ ] Capture debugger attach failures in dashboard health.
- [ ] Add a ranked "waiting on me" agent queue.
- [ ] Replace ffmpeg process recording with a native ScreenCaptureKit recorder when full Xcode is available.

## Later
- [ ] Expand only when the project grows.

## Blocked
- [ ] No blockers recorded yet.

## Discovered While Working
- [ ] Chrome alarms cannot provide every-few-seconds cadence by themselves; use an in-memory timer while awake and alarms as wakeup fallback.
- [ ] Local macOS Screen Recording permission is currently blocking native visual watch and recording capture; Revere reports the blocker in the menu and controls panel.
- [ ] The `Open Screen Recording Settings` control opens macOS System Settings to `Screen & System Audio Recording`; changing the permission still requires the user.
- [ ] Rebuilding/reinstalling the unsigned app can invalidate prior Screen Recording approval, so the build script now ad-hoc signs `Revere.app`.
