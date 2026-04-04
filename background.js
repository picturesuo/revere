const WATCHED_TABS_KEY = "watchedTabs";
const EVENTS_KEY = "recentEvents";
const SETTINGS_KEY = "settings";
const MAX_EVENTS = 50;
const NOTIFICATION_TARGETS_KEY = "notificationTargets";
const NOTIFICATION_ICON_URL = chrome.runtime.getURL("icon-128.png");

chrome.runtime.onInstalled.addListener(async () => {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  if (!settings) {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: {
        webhookUrl: "",
        notificationsEnabled: true
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      const errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("Website Updater error:", errorMessage, error);
      sendResponse({ ok: false, error: errorMessage });
    });

  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "get-popup-state":
      return getPopupState(message.tabId);
    case "set-tab-monitoring":
      await setTabMonitoring(message.tabId, message.url, message.enabled);
      return getPopupState(message.tabId);
    case "send-test-event":
      await sendTestEvent(message.tabId, message.url);
      return { delivered: true };
    case "page-update":
      await handlePageUpdate(message.payload, sender);
      return {};
    default:
      return {};
  }
}

async function getPopupState(tabId) {
  const { [WATCHED_TABS_KEY]: watchedTabs = {} } = await chrome.storage.local.get(WATCHED_TABS_KEY);
  return {
    watched: Boolean(watchedTabs[String(tabId)])
  };
}

async function setTabMonitoring(tabId, url, enabled) {
  if (!tabId) {
    return;
  }

  const { [WATCHED_TABS_KEY]: watchedTabs = {} } = await chrome.storage.local.get(WATCHED_TABS_KEY);
  const next = { ...watchedTabs };

  if (enabled) {
    next[String(tabId)] = {
      url,
      enabledAt: new Date().toISOString()
    };
  } else {
    delete next[String(tabId)];
  }

  await chrome.storage.local.set({ [WATCHED_TABS_KEY]: next });
}

async function sendTestEvent(tabId, url) {
  await dispatchEvent({
    type: "page_update",
    tabId: tabId || -1,
    url: url || "https://example.com",
    title: "Website Updater Test",
    summary: "Manual extension test notification.",
    fingerprint: `manual-test:${Date.now()}`,
    profile: "manual",
    score: 100,
    source: "manual",
    timestamp: new Date().toISOString()
  });
}

async function handlePageUpdate(payload, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    return;
  }

  const { [WATCHED_TABS_KEY]: watchedTabs = {}, [SETTINGS_KEY]: settings = {} } =
    await chrome.storage.local.get([WATCHED_TABS_KEY, SETTINGS_KEY]);

  if (!watchedTabs[String(tabId)]) {
    return;
  }

  await dispatchEvent(
    {
      type: "page_update",
      tabId,
      url: payload.url,
      title: payload.title,
      summary: payload.summary,
      fingerprint: payload.fingerprint || "",
      profile: payload.profile || "generic",
      score: payload.score || 0,
      source: payload.source || "dom",
      timestamp: new Date().toISOString()
    },
    settings
  );
}

async function dispatchEvent(event, providedSettings) {
  const settings = providedSettings || (await getSettings());

  await appendEvent(event);

  if (settings.notificationsEnabled !== false) {
    try {
      const notificationId = `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await chrome.notifications.create(notificationId, {
        type: "basic",
        iconUrl: NOTIFICATION_ICON_URL,
        title: event.title || "Website updated",
        message: event.summary || "Meaningful page change detected.",
        contextMessage: event.url || "",
        priority: 2,
        requireInteraction: true
      });
      await rememberNotificationTarget(notificationId, event.url);
    } catch (error) {
      console.error("Notification delivery failed:", error);
    }
  }

  if (settings.webhookUrl) {
    try {
      await postWebhook(settings.webhookUrl, event);
    } catch (error) {
      console.error("Webhook delivery failed:", error);
    }
  }
}

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return result[SETTINGS_KEY] || {};
}

async function appendEvent(event) {
  const { [EVENTS_KEY]: events = [] } = await chrome.storage.local.get(EVENTS_KEY);
  const next = [event, ...events].slice(0, MAX_EVENTS);
  await chrome.storage.local.set({ [EVENTS_KEY]: next });
}

async function postWebhook(webhookUrl, event) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(event)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Webhook request failed with status ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`
    );
  }
}

async function rememberNotificationTarget(notificationId, url) {
  if (!url) {
    return;
  }

  const { [NOTIFICATION_TARGETS_KEY]: targets = {} } =
    await chrome.storage.local.get(NOTIFICATION_TARGETS_KEY);
  const next = { ...targets, [notificationId]: url };
  await chrome.storage.local.set({ [NOTIFICATION_TARGETS_KEY]: next });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const { [NOTIFICATION_TARGETS_KEY]: targets = {} } =
    await chrome.storage.local.get(NOTIFICATION_TARGETS_KEY);
  const url = targets[notificationId];
  if (!url) {
    return;
  }

  await chrome.tabs.create({ url });
  await chrome.notifications.clear(notificationId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { [WATCHED_TABS_KEY]: watchedTabs = {} } = await chrome.storage.local.get(WATCHED_TABS_KEY);
  if (!watchedTabs[String(tabId)]) {
    return;
  }

  const next = { ...watchedTabs };
  delete next[String(tabId)];
  await chrome.storage.local.set({ [WATCHED_TABS_KEY]: next });
});
