# Revere

Revere is a simple tool for telling you whenever a website changes. It sends a push notification to your phone through the `ntfy` app within a few seconds of the website update. You can use it for live sports, breaking news, marketplace changes, and attendance or student systems in college.

![Revere artwork](assets/paul-revere-ride.png)

## Why Chrome Extension

This product is a Chrome extension because it is the easiest way to access logged-in websites, and it can monitor live DOM changes on pages that are already open.

## Detection Model

The script runs inside the watched page and uses:

1. `MutationObserver` for live DOM changes
2. a page-context hook for `WebSocket` and `EventSource` messages
3. a fallback snapshot pass that re-scans the page for meaningful visible text every few seconds

## Install

1. Open Chrome extensions and enable Developer mode.
2. Click `Load unpacked` and select this project folder.
3. Run the local bridge if you want phone push delivery.
4. Set the extension webhook URL to `http://localhost:8787/event`.

## Use It

1. Open the website you want to monitor.
2. Log in if needed.
3. Click the extension icon and open Revere.
4. Press `Start Monitoring`.
5. Keep the tab open.
6. You can work in other apps or other websites, and as long as the watched tab stays open with tracking enabled, you will keep getting live alerts.
