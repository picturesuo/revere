# Revere

Revere is a Chrome extension that monitors website changes live by sending a push notification to your phone within seconds. It's designed for pages that update while you're already logged in or watching the tab, which includes:
- Sports Feeds
- Breaking News Pages
- Marketplaces
- other live dashboards (like college attendance websites).
 
![Revere artwork](assets/paul-revere-ride.png)

## What It Does

- Monitors open tabs for meaningful visible changes
- Detects live DOM updates, websocket-driven updates, and event-stream activity
- Sends alerts through a local bridge to services like `ntfy`
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
- `ntfy`

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

## Learnings

This is the first product that I had to test in real time, and it failed the first two times when I was trying to track a live attendance website. Then I learned every website is different, and some are much harder to track than others. Hence I added the three-layer checker, although I hypothesize that there will need to be more layers to check.

