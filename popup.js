const statusEl = document.getElementById("status");
const statusDotEl = document.getElementById("status-dot");
const toggleButton = document.getElementById("toggle");
const testButton = document.getElementById("test");
const optionsButton = document.getElementById("open-options");
const watchNameInput = document.getElementById("watch-name");
const watchModeSelect = document.getElementById("watch-mode");
const domainEl = document.getElementById("tab-domain");
const phoneStatusEl = document.getElementById("phone-status");
const modeStatEl = document.getElementById("mode-stat");
const lastStatEl = document.getElementById("last-stat");
const eventsEl = document.getElementById("events");

let currentTab = null;
let watched = false;

init().catch((error) => {
  statusEl.textContent = error.message;
  toggleButton.disabled = true;
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  if (!tab?.id || !tab?.url) {
    throw new Error("No active tab available.");
  }

  await refreshState();
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({
    type: "get-popup-state",
    tabId: currentTab.id
  });

  watched = Boolean(response.watched);
  watchNameInput.value = response.watch?.name || suggestWatchName(currentTab);
  watchModeSelect.value = response.watch?.mode || suggestMode(currentTab.url);

  const dashboard = await chrome.runtime.sendMessage({
    type: "get-dashboard-data",
    tabId: currentTab.id
  });

  render(response, dashboard);
}

toggleButton.addEventListener("click", async () => {
  watched = !watched;

  const response = await chrome.runtime.sendMessage({
    type: "set-tab-monitoring",
    tabId: currentTab.id,
    url: currentTab.url,
    enabled: watched,
    name: watchNameInput.value.trim(),
    mode: watchModeSelect.value
  });

  watched = Boolean(response.watched);
  await refreshState();
});

testButton.addEventListener("click", async () => {
  if (!currentTab?.id) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "send-test-event",
    tabId: currentTab.id,
    url: currentTab.url
  });

  statusEl.textContent = "Test alert sent.";
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function render(stateResponse, dashboard) {
  const watch = stateResponse.watch || {};
  const settings = dashboard.settings || {};
  const currentWatch = dashboard.currentWatch || {};

  statusDotEl.classList.toggle("live", watched);
  statusEl.textContent = watched
    ? "Live on this tab. Revere will fire when it catches a meaningful update."
    : "This tab is idle. Turn it on when you want alerts from this page.";

  toggleButton.textContent = watched ? "Stop Monitoring" : "Start Monitoring";
  domainEl.textContent = formatDomain(currentTab.url);
  phoneStatusEl.textContent = settings.subscriptionName ? "Phone Push On" : "Phone Push Off";
  modeStatEl.textContent = formatMode(currentWatch.mode || watch.mode || suggestMode(currentTab.url));
  lastStatEl.textContent = dashboard.recentEvents?.[0]
    ? formatRelativeTime(dashboard.recentEvents[0].timestamp)
    : "None";

  renderEvents(dashboard.recentEvents || []);
}

function renderEvents(events) {
  if (!events.length) {
    eventsEl.innerHTML =
      '<div class="empty">No events yet. Start monitoring or send a test.</div>';
    return;
  }

  eventsEl.innerHTML = events
    .slice(0, 4)
    .map(
      (event) => `
        <article class="event-card">
          <div class="event-meta">
            <span>${escapeHtml(event.profile || "event")}</span>
            <span>${escapeHtml(formatRelativeTime(event.timestamp))}</span>
          </div>
          <p class="event-title">${escapeHtml(event.title || "Website update")}</p>
          <p class="event-summary">${escapeHtml(event.summary || "Meaningful change detected.")}</p>
        </article>
      `
    )
    .join("");
}

function suggestWatchName(tab) {
  const domain = formatDomain(tab.url);
  return domain ? `${domain} watch` : "New watch";
}

function suggestMode(url) {
  const lower = String(url || "").toLowerCase();
  if (/(btc|bitcoin|coinbase|coingecko|binance|kraken|tradingview)/.test(lower)) {
    return "price";
  }

  if (/(espn|nba|nfl|mlb|nhl|sports)/.test(lower)) {
    return "live";
  }

  return "page";
}

function formatMode(mode) {
  return {
    price: "Price",
    live: "Live Feed",
    page: "Page"
  }[mode] || "Page";
}

function formatDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (error) {
    return "Current tab";
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
