const SETTINGS_KEY = "settings";

const webhookInput = document.getElementById("webhook-url");
const ntfyServerInput = document.getElementById("ntfy-server");
const subscriptionNameInput = document.getElementById("subscription-name");
const notificationsInput = document.getElementById("notifications-enabled");
const visualScanInput = document.getElementById("visual-scan-enabled");
const visualScanIntervalInput = document.getElementById("visual-scan-interval");
const debuggerCaptureInput = document.getElementById("debugger-capture-enabled");
const saveButton = document.getElementById("save");
const sendTestButton = document.getElementById("send-test");
const messageEl = document.getElementById("message");
const watchListEl = document.getElementById("watch-list");
const eventListEl = document.getElementById("event-list");
const watchDetailEl = document.getElementById("watch-detail");
const stepsEl = document.getElementById("steps");
const statWatchesEl = document.getElementById("stat-watches");
const statEventsEl = document.getElementById("stat-events");
const statLastEl = document.getElementById("stat-last");
const statDestinationsEl = document.getElementById("stat-destinations");

let dashboardState = {
  settings: {},
  watches: [],
  recentEvents: []
};
let selectedWatchTabId = null;

init().catch((error) => {
  messageEl.textContent = error instanceof Error ? error.message : String(error);
});

saveButton.addEventListener("click", saveSettings);
sendTestButton.addEventListener("click", sendTestNotification);

async function init() {
  await loadSettings();
  await refreshDashboard();
}

async function refreshDashboard() {
  const response = await chrome.runtime.sendMessage({
    type: "get-dashboard-data"
  });
  assertOk(response);
  dashboardState = response;

  const { watches = [], recentEvents = [], settings = {}, onboarding = {} } = dashboardState;

  statWatchesEl.textContent = String(watches.length);
  statEventsEl.textContent = String(recentEvents.length);
  statLastEl.textContent = recentEvents[0] ? formatRelativeTime(recentEvents[0].timestamp) : "None";
  statDestinationsEl.textContent = formatDestinations(settings);

  renderWatches(watches, recentEvents);
  renderEvents(recentEvents);
  renderSteps(onboarding);

  if (!selectedWatchTabId && watches[0]) {
    selectedWatchTabId = watches[0].tabId;
  }

  renderWatchDetail();
}

async function loadSettings() {
  const { [SETTINGS_KEY]: settings = {} } = await chrome.storage.local.get(SETTINGS_KEY);
  webhookInput.value = settings.webhookUrl || "";
  ntfyServerInput.value = settings.ntfyServer || "https://ntfy.sh";
  subscriptionNameInput.value = settings.subscriptionName || "";
  notificationsInput.checked = settings.notificationsEnabled !== false;
  visualScanInput.checked = settings.visualScanEnabled !== false;
  visualScanIntervalInput.value = String(settings.visualScanIntervalSeconds || 5);
  debuggerCaptureInput.checked = settings.debuggerCaptureEnabled !== false;
}

async function saveSettings() {
  const webhookUrl = normalizeWebhookUrl(webhookInput.value.trim(), subscriptionNameInput.value.trim());
  const ntfyServer = ntfyServerInput.value.trim() || "https://ntfy.sh";
  const subscriptionName = subscriptionNameInput.value.trim();
  const visualScanIntervalSeconds = normalizeVisualScanInterval(visualScanIntervalInput.value);

  messageEl.textContent = "Saving...";
  saveButton.disabled = true;

  try {
    validateSettings({ webhookUrl, ntfyServer, subscriptionName, visualScanIntervalSeconds });
    const { [SETTINGS_KEY]: existingSettings = {} } = await chrome.storage.local.get(SETTINGS_KEY);

    await chrome.storage.local.set({
      [SETTINGS_KEY]: {
        ...existingSettings,
        webhookUrl,
        ntfyServer,
        subscriptionName,
        notificationsEnabled: notificationsInput.checked,
        visualScanEnabled: visualScanInput.checked,
        visualScanIntervalSeconds,
        debuggerCaptureEnabled: debuggerCaptureInput.checked
      }
    });

    webhookInput.value = webhookUrl;
    visualScanIntervalInput.value = String(visualScanIntervalSeconds);
    messageEl.textContent = subscriptionName
      ? "Saved. Revere will send desktop alerts and phone pushes to your ntfy topic."
      : "Saved. Desktop alerts stay on, and the webhook remains optional.";

    await refreshDashboard();
  } catch (error) {
    messageEl.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    saveButton.disabled = false;
  }
}

async function sendTestNotification() {
  sendTestButton.disabled = true;
  messageEl.textContent = "Sending test...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "send-test-event",
      url: "https://example.com"
    });
    assertOk(response);
    messageEl.textContent = response.phoneConfigured
      ? "Test notification sent."
      : "Test sent locally only. Add an ntfy topic or webhook for phone pushes.";
    await refreshDashboard();
  } catch (error) {
    messageEl.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sendTestButton.disabled = false;
  }
}

function renderWatches(watches, events) {
  if (!watches.length) {
    watchListEl.innerHTML =
      '<div class="empty">No watches yet. Open a tab and start monitoring it from the popup.</div>';
    return;
  }

  watchListEl.innerHTML = watches
    .map((watch) => {
      const lastEvent = events.find((event) => event.tabId === watch.tabId);
      const isSelected = selectedWatchTabId === watch.tabId;
      return `
        <button class="watch-card ${isSelected ? "selected" : ""}" data-tab-id="${watch.tabId}" style="text-align:left;border:1px solid var(--line);background:${isSelected ? "rgba(255,107,44,0.10)" : "rgba(255,255,255,0.76)"};">
          <div class="watch-top">
            <div>
              <p class="watch-title">${escapeHtml(watch.name || formatDomain(watch.url))}</p>
              <p class="watch-meta">${escapeHtml(formatDomain(watch.url))} · ${escapeHtml(formatMode(watch.mode || "page"))}</p>
            </div>
            <span class="badge live">Live</span>
          </div>
          <p class="watch-meta">${lastEvent ? escapeHtml(lastEvent.summary) : "No event yet."}</p>
        </button>
      `;
    })
    .join("");

  for (const button of watchListEl.querySelectorAll("[data-tab-id]")) {
    button.addEventListener("click", () => {
      selectedWatchTabId = Number(button.dataset.tabId);
      renderWatches(watches, events);
      renderWatchDetail();
    });
  }
}

function renderEvents(events) {
  if (!events.length) {
    eventListEl.innerHTML =
      '<div class="empty">Nothing has fired yet. Send a test or wait for the next update.</div>';
    return;
  }

  eventListEl.innerHTML = events
    .slice(0, 8)
    .map(
      (event) => `
        <article class="event-card">
          <div class="event-top">
            <div>
              <p class="event-title">${escapeHtml(event.title || "Website update")}</p>
              <p class="event-meta">${escapeHtml(event.summary || "Meaningful change detected.")}</p>
            </div>
            <span class="badge">${escapeHtml(formatRelativeTime(event.timestamp))}</span>
          </div>
        </article>
      `
    )
    .join("");
}

function renderWatchDetail() {
  const watch = dashboardState.watches.find((item) => item.tabId === selectedWatchTabId);
  if (!watch) {
    watchDetailEl.innerHTML =
      '<div class="empty">Pick a watch to see its details.</div>';
    return;
  }

  const lastEvent = dashboardState.recentEvents.find((event) => event.tabId === watch.tabId);
  watchDetailEl.innerHTML = `
    <div class="detail-row">
      <span class="detail-label">Watch Name</span>
      <span class="detail-value">${escapeHtml(watch.name || formatDomain(watch.url))}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Mode</span>
      <span class="detail-value">${escapeHtml(formatMode(watch.mode || "page"))}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">URL</span>
      <span class="detail-value">${escapeHtml(watch.url || "")}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Last Event</span>
      <span class="detail-value">${escapeHtml(lastEvent ? lastEvent.summary : "No event yet.")}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Armed Since</span>
      <span class="detail-value">${escapeHtml(formatTimestamp(watch.enabledAt))}</span>
    </div>
  `;
}

function renderSteps(onboarding) {
  const steps = [
    {
      title: "Install and keep Chrome open",
      description: onboarding.extensionLoaded
        ? "Extension loaded."
        : "Load Revere as an unpacked extension."
    },
    {
      title: "Turn on phone push",
      description: onboarding.phonePushReady
        ? "Phone delivery is configured."
        : "Add an ntfy topic or webhook."
    },
    {
      title: "Arm your first watch",
      description: onboarding.hasWatch
        ? "At least one watch is live."
        : "Open a tab and arm it from the popup."
    }
  ];

  stepsEl.innerHTML = steps
    .map(
      (step) => `
        <article class="step-card">
          <p class="watch-title">${escapeHtml(step.title)}</p>
          <p class="watch-meta">${escapeHtml(step.description)}</p>
        </article>
      `
    )
    .join("");
}

function validateSettings({ webhookUrl, ntfyServer, subscriptionName, visualScanIntervalSeconds }) {
  if (webhookUrl) {
    assertValidUrl(webhookUrl, "Enter a valid webhook URL.");
  }

  if (ntfyServer) {
    assertValidUrl(ntfyServer, "Enter a valid ntfy server URL.");
  }

  if (subscriptionName && !/^[a-z0-9._-]{3,64}$/i.test(subscriptionName)) {
    throw new Error(
      "ntfy topic names must be 3-64 characters and use only letters, numbers, dots, underscores, or dashes."
    );
  }

  if (!Number.isFinite(visualScanIntervalSeconds)) {
    throw new Error("Visual scan seconds must be a number.");
  }
}

function assertValidUrl(value, message) {
  try {
    new URL(value);
  } catch (error) {
    throw new Error(message);
  }
}

function normalizeWebhookUrl(webhookUrl, subscriptionName) {
  if (!webhookUrl || !subscriptionName) {
    return webhookUrl;
  }

  try {
    const url = new URL(webhookUrl);
    const isLocalBridge =
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.pathname === "/event";
    return isLocalBridge ? "" : webhookUrl;
  } catch (error) {
    return webhookUrl;
  }
}

function normalizeVisualScanInterval(value) {
  const seconds = Number(value || 5);
  if (!Number.isFinite(seconds)) {
    return NaN;
  }
  return Math.min(60, Math.max(2, Math.round(seconds)));
}

function formatDestinations(settings) {
  const desktop = settings.notificationsEnabled !== false;
  const phone = Boolean(settings.subscriptionName || settings.webhookUrl);
  const visual = settings.visualScanEnabled !== false ? "Visual" : "";
  if (desktop && phone) {
    return ["Desktop + Phone", visual].filter(Boolean).join(" + ");
  }
  if (phone) {
    return ["Phone", visual].filter(Boolean).join(" + ");
  }
  return [desktop ? "Desktop" : "Off", visual].filter(Boolean).join(" + ");
}

function formatMode(mode) {
  return {
    price: "Price Changes",
    live: "Live Feed",
    page: "Page Changes"
  }[mode] || "Page Changes";
}

function formatDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (error) {
    return "unknown";
  }
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return "now";
  }

  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.max(1, Math.round(diff / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "Unknown";
  }

  return new Date(timestamp).toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function assertOk(response) {
  if (!response || response.ok === false) {
    throw new Error(response?.error || "Dashboard request failed.");
  }

  return response;
}
