const toggleButton = document.getElementById("toggle");
const testButton = document.getElementById("test");
const optionsButton = document.getElementById("open-options");
const domainEl = document.getElementById("tab-domain");
const lastStatEl = document.getElementById("last-stat");
const monitorBadgeEl = document.getElementById("monitor-badge");
const eventsEl = document.getElementById("events");

let currentTab = null;
let watched = false;

init().catch((error) => {
  toggleButton.disabled = true;
  monitorBadgeEl.textContent = error.message;
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  if (!tab?.id || !tab?.url) {
    throw new Error("No active tab");
  }

  await refreshState();
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({
    type: "get-popup-state",
    tabId: currentTab.id
  });

  watched = Boolean(response.watched);

  const dashboard = await chrome.runtime.sendMessage({
    type: "get-dashboard-data",
    tabId: currentTab.id
  });

  render(dashboard);
}

toggleButton.addEventListener("click", async () => {
  watched = !watched;

  const response = await chrome.runtime.sendMessage({
    type: "set-tab-monitoring",
    tabId: currentTab.id,
    url: currentTab.url,
    enabled: watched,
    name: suggestWatchName(currentTab),
    mode: "page"
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

  await refreshState();
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function render(dashboard) {
  domainEl.textContent = formatDomain(currentTab.url);
  monitorBadgeEl.textContent = watched ? "Monitoring" : "Not Monitoring";
  monitorBadgeEl.classList.toggle("live", watched);
  toggleButton.textContent = watched ? "Stop Monitoring" : "Start Monitoring";
  lastStatEl.textContent = dashboard.recentEvents?.[0]
    ? formatRelativeTime(dashboard.recentEvents[0].timestamp)
    : "None";

  renderEvents(dashboard.recentEvents || []);
}

function renderEvents(events) {
  if (!events.length) {
    eventsEl.innerHTML = '<div class="empty">No alerts yet.</div>';
    return;
  }

  eventsEl.innerHTML = events
    .slice(0, 3)
    .map(
      (event) => `
        <article class="event-card">
          <div class="event-top">
            <span>${escapeHtml(event.profile || "event")}</span>
            <span>${escapeHtml(formatRelativeTime(event.timestamp))}</span>
          </div>
          <div class="event-summary">${escapeHtml(event.summary || "Meaningful change detected.")}</div>
        </article>
      `
    )
    .join("");
}

function suggestWatchName(tab) {
  const domain = formatDomain(tab.url);
  return domain ? `${domain} watch` : "New watch";
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
