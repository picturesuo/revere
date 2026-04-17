const toggleButton = document.getElementById("toggle");
const testButton = document.getElementById("test");
const optionsButton = document.getElementById("open-options");
const saveNtfyCopyButton = document.getElementById("save-ntfy-copy");
const domainEl = document.getElementById("tab-domain");
const lastStatEl = document.getElementById("last-stat");
const monitorBadgeEl = document.getElementById("monitor-badge");
const eventsEl = document.getElementById("events");
const ntfyTitleTemplateInput = document.getElementById("ntfy-title-template");
const ntfyMessageTemplateInput = document.getElementById("ntfy-message-template");

let currentTab = null;
let watched = false;
let currentWatch = null;
let ntfyDefaults = {
  titleTemplate: "",
  messageTemplate: ""
};

init().catch((error) => {
  toggleButton.disabled = true;
  monitorBadgeEl.textContent = error instanceof Error ? error.message : String(error);
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
  assertOk(response);

  watched = Boolean(response.watched);
  currentWatch = response.watch || null;
  ntfyDefaults = response.ntfyDefaults || {
    titleTemplate: "",
    messageTemplate: ""
  };

  const dashboard = await chrome.runtime.sendMessage({
    type: "get-dashboard-data",
    tabId: currentTab.id
  });
  assertOk(dashboard);

  render(dashboard);
}

toggleButton.addEventListener("click", async () => {
  const nextWatched = !watched;
  watched = nextWatched;
  toggleButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "set-tab-monitoring",
      tabId: currentTab.id,
      url: currentTab.url,
      enabled: nextWatched,
      name: suggestWatchName(currentTab),
      mode: "page",
      ntfyTitleTemplate: ntfyTitleTemplateInput.value.trim(),
      ntfyMessageTemplate: ntfyMessageTemplateInput.value.trim()
    });
    assertOk(response);

    watched = Boolean(response.watched);
    currentWatch = response.watch || null;
    await refreshState();
  } catch (error) {
    watched = !nextWatched;
    monitorBadgeEl.textContent = error instanceof Error ? error.message : String(error);
    await refreshState().catch(() => {});
  } finally {
    toggleButton.disabled = false;
  }
});

testButton.addEventListener("click", async () => {
  if (!currentTab?.id) {
    return;
  }

  testButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "send-test-event",
      tabId: currentTab.id,
      url: currentTab.url
    });
    assertOk(response);

    await refreshState();
    if (response.phoneConfigured === false) {
      monitorBadgeEl.textContent = "Desktop only";
      monitorBadgeEl.classList.remove("live");
    }
  } catch (error) {
    monitorBadgeEl.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    testButton.disabled = false;
  }
});

saveNtfyCopyButton.addEventListener("click", async () => {
  if (!currentTab?.id) {
    return;
  }

  saveNtfyCopyButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "set-ntfy-defaults",
      tabId: currentTab.id,
      ntfyTitleTemplate: ntfyTitleTemplateInput.value.trim(),
      ntfyMessageTemplate: ntfyMessageTemplateInput.value.trim()
    });
    assertOk(response);

    ntfyDefaults = response.ntfyDefaults || ntfyDefaults;
    await refreshState();
  } finally {
    saveNtfyCopyButton.disabled = false;
  }
});

optionsButton.addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("options.html")
  });
});

function render(dashboard) {
  domainEl.textContent = formatDomain(currentTab.url);
  monitorBadgeEl.textContent = watched ? "Monitoring" : "Not Monitoring";
  monitorBadgeEl.classList.toggle("live", watched);
  toggleButton.textContent = watched ? "Stop Monitoring" : "Start Monitoring";
  lastStatEl.textContent = dashboard.recentEvents?.[0]
    ? formatRelativeTime(dashboard.recentEvents[0].timestamp)
    : "None";
  ntfyTitleTemplateInput.value =
    currentWatch?.ntfyTitleTemplate || ntfyDefaults.titleTemplate || "";
  ntfyMessageTemplateInput.value =
    currentWatch?.ntfyMessageTemplate || ntfyDefaults.messageTemplate || "";
  saveNtfyCopyButton.textContent = "Save ntfy Copy Defaults";
  saveNtfyCopyButton.disabled = false;

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

function assertOk(response) {
  if (!response || response.ok === false) {
    throw new Error(response?.error || "Dashboard request failed.");
  }

  return response;
}
