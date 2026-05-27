# CodexBar Research Notes

## Why CodexBar Feels Useful

CodexBar is a small macOS menu bar control plane for AI-provider limits. The useful pattern is not the exact UI; it is the way it keeps many independent signals visible without asking the user to keep checking dashboards.

Peter Steinberger's repo describes CodexBar as a macOS menu bar app with 40+ provider sources, one status item per provider or a merged icon mode, dynamic menu-bar meters, reset countdowns, status polling, and optional notifications. It reuses existing sessions where possible: OAuth, CLIs, API keys, browser cookies, local files, and provider app state.

Architecture notes from CodexBar:
- `CodexBarCore` owns fetch and parse work.
- `CodexBar` owns state and UI: `UsageStore`, `SettingsStore`, `StatusItemController`, menus, icon rendering.
- Background refresh flows into a central store, then the menu, icon, widgets, and notifications react to that state.
- Refresh cadence is explicit: manual, 1m, 2m, 5m, 15m, 30m. Automatic scans are coalesced and should not block the UI.
- Errors and stale data are first-class states, not hidden logs.
- Notifications are transition-based: quota depleted, quota restored, low quota thresholds.

Sources:
- https://github.com/steipete/CodexBar
- https://raw.githubusercontent.com/steipete/CodexBar/main/docs/architecture.md
- https://raw.githubusercontent.com/steipete/CodexBar/main/docs/refresh-loop.md

## Revere Translation

Revere should become a small alert control plane:
- `content.js`: page-local signals, DOM, network, visible text, page-context hooks.
- `background.js`: central watch store, screenshot-diff state, notification routing, tab lifecycle, scheduler.
- `bridge-server.js`: optional local/native hooks for ntfy, agent attention, and opt-in desktop screen watching.
- `options.html`: dashboard for watches, delivery state, and capture settings.

The important CodexBar idea is provider-like sources. Revere's sources are:
- DOM mutations.
- WebSocket/EventSource hooks.
- Visible text snapshots.
- Active visible-tab screenshot diffs.
- Background tab screenshot diffs through Chrome debugger/CDP.
- Optional macOS desktop screenshot diffs through the local bridge.
- Agent-attention events posted into the bridge.

## Chrome Capture Constraints

`chrome.tabs.captureVisibleTab` only captures the visible area of the currently active tab in a window. For background tabs, Revere now uses the Chrome debugger API as an alternate transport for CDP, targeting a tab by `tabId` and calling `Page.captureScreenshot`.

The scheduler uses a fast in-memory timer while the service worker is alive, plus a Chrome alarm fallback. Chrome alarms are currently limited to a minimum 30-second period, so the timer is what provides every-few-seconds behavior during normal extension activity, and the alarm is the wakeup safety net.

Sources:
- https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab
- https://developer.chrome.com/docs/extensions/reference/api/debugger
- https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot
- https://developer.chrome.com/docs/extensions/reference/api/alarms

## Workflow Shape

1. User arms one or more tabs from the popup.
2. Revere keeps existing DOM/network watchers in the content script.
3. Background visual scans sample armed tabs every few seconds when the service worker is alive.
4. Inactive tabs are captured through debugger/CDP when the setting is enabled.
5. Each screenshot is downsampled to grayscale, compared against the last sample, and filtered by pixel ratio, bounding box area, and edge-strip noise.
6. Meaningful changes become normal Revere events, so desktop notifications, ntfy, webhooks, and recents all use the same path.
7. External agents can post to `/agent-attention` on the local bridge, which turns "needs user input" into the same notification surface.
8. The local bridge can opt into `/screen-watch/start` or `REVERE_SCREEN_WATCH=1` to watch the visible macOS desktop. This is intentionally not automatic because macOS may require Screen Recording permission.

## Next Opportunities

- Add per-watch capture modes: DOM only, visual only, combined, or agent-only.
- Add event severity rules so tiny visual changes can be logged but only high-confidence changes interrupt.
- Add a menu-bar companion later if Revere needs CodexBar-style always-visible state outside Chrome.
- Add a "waiting on me" queue where agents post recommended next tasks and Revere ranks the most important one.
- Persist visual-scan health per watch: last captured, last changed, last debugger failure.
