const statusEl = document.getElementById("status");
const toggleButton = document.getElementById("toggle");
const testButton = document.getElementById("test");
const optionsButton = document.getElementById("open-options");

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

  const response = await chrome.runtime.sendMessage({
    type: "get-popup-state",
    tabId: tab.id
  });

  watched = Boolean(response.watched);
  render();
}

toggleButton.addEventListener("click", async () => {
  watched = !watched;

  const response = await chrome.runtime.sendMessage({
    type: "set-tab-monitoring",
    tabId: currentTab.id,
    url: currentTab.url,
    enabled: watched
  });

  watched = Boolean(response.watched);
  render();
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

  statusEl.textContent = "Test notification sent.";
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

function render() {
  statusEl.textContent = watched
    ? "Monitoring this tab for meaningful updates."
    : "This tab is not being monitored.";

  toggleButton.textContent = watched ? "Stop Monitoring" : "Start Monitoring";
}
