# Revere

Revere is a Chrome extension for monitoring live website changes and sending a phone alert within seconds. It is designed for pages that update while you are logged in or already watching the tab, including sports feeds, breaking news pages, marketplaces, and other live dashboards.

![Revere artwork](assets/paul-revere-ride.png)

## Why This Matters

Many useful pages update in the browser before any public API or email alert catches up. Revere focuses on that gap: it watches the page you already have open and surfaces meaningful updates quickly enough to matter.

## What It Does

- Monitors open tabs for meaningful visible changes
- Detects live DOM updates, websocket-driven updates, and event-stream activity
- Sends alerts through a local bridge to services like `ntfy`, Telegram, or WhatsApp
- Works well for logged-in pages and other sites where browser context matters

## Why Chrome Extension

This is a Chrome extension because that is the most practical way to access logged-in websites and monitor live page changes inside an open tab.

## Detection Model

The script runs inside the watched page and uses:

1. `MutationObserver` for live DOM changes
2. a page-context hook for `WebSocket` and `EventSource` messages
3. a fallback snapshot pass that re-scans the page for meaningful visible text every few seconds

## Tech Stack

- Chrome Extension APIs
- JavaScript
- Node.js for the optional local bridge
- `ntfy`, Telegram, or WhatsApp for alert delivery

## How To Run

1. Open Chrome extensions and enable Developer mode.
2. Click `Load unpacked` and select this project folder.
3. Run the local bridge if you want phone push delivery:

```bash
npm install
npm run bridge
```

4. Set the extension webhook URL to `http://localhost:8787/event`.

## How To Use It

1. Open the website you want to monitor.
2. Log in if needed.
3. Click the extension icon and open Revere.
4. Press `Start Monitoring`.
5. Keep the tab open.
6. You can work in other apps or other websites, and as long as the watched tab stays open with tracking enabled, you will keep getting live alerts.

## What I Learned

- Browser extensions are a practical way to monitor pages that are hard to cover through APIs alone.
- Live-update detection is more reliable when multiple signals are combined instead of relying on one source.
- Fast public-facing documentation matters because it changes how a project is perceived before anyone reads the code.
