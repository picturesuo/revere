const WATCHED_TABS_KEY = "watchedTabs";
const EVENTS_KEY = "recentEvents";
const SETTINGS_KEY = "settings";
const MAX_EVENTS = 50;
const NOTIFICATION_TARGETS_KEY = "notificationTargets";
const NOTIFICATION_ICON_URL = chrome.runtime.getURL("icon-128.png");
const DEFAULT_SETTINGS = {
  webhookUrl: "",
  ntfyServer: "https://ntfy.sh",
  subscriptionName: "",
  notificationsEnabled: true
};

chrome.runtime.onInstalled.addListener(async () => {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  if (!settings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      const errorMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("Revere error:", errorMessage, error);
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
  const watchedTabs = await getStoredObject(WATCHED_TABS_KEY);
  return {
    watched: Boolean(watchedTabs[String(tabId)])
  };
}

async function setTabMonitoring(tabId, url, enabled) {
  if (!tabId) {
    return;
  }

  await updateStoredObject(WATCHED_TABS_KEY, (next) => {
    if (enabled) {
      next[String(tabId)] = {
        url,
        enabledAt: new Date().toISOString()
      };
      return next;
    }

    delete next[String(tabId)];
    return next;
  });
}

async function sendTestEvent(tabId, url) {
  await dispatchEvent({
    type: "page_update",
    tabId: tabId || -1,
    url: url || "https://example.com",
    title: "Revere Test",
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

  if (settings.subscriptionName) {
    try {
      await postNtfy(settings, event);
    } catch (error) {
      console.error("ntfy delivery failed:", error);
    }
  }

  if (shouldPostWebhook(settings)) {
    try {
      await postWebhook(settings.webhookUrl, event);
    } catch (error) {
      console.error("Webhook delivery failed:", error);
    }
  }
}

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
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

async function postNtfy(settings, event) {
  const topic = normalizeSubscriptionName(settings.subscriptionName);
  const server = trimTrailingSlash(settings.ntfyServer || DEFAULT_SETTINGS.ntfyServer);
  const response = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      Title: event.title || "Website update",
      Priority: "urgent",
      Tags: event.profile === "sports" ? "rotating_light,trophy" : "rotating_light,bell",
      Click: event.url || ""
    },
    body: formatEvent(event)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `ntfy request failed with status ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`
    );
  }
}

async function rememberNotificationTarget(notificationId, url) {
  if (!url) {
    return;
  }

  await updateStoredObject(NOTIFICATION_TARGETS_KEY, (next) => ({
    ...next,
    [notificationId]: url
  }));
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const targets = await getStoredObject(NOTIFICATION_TARGETS_KEY);
  const url = targets[notificationId];
  if (!url) {
    return;
  }

  await chrome.tabs.create({ url });
  await chrome.notifications.clear(notificationId);
  await removeStoredKey(NOTIFICATION_TARGETS_KEY, notificationId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const watchedTabs = await getStoredObject(WATCHED_TABS_KEY);
  if (!watchedTabs[String(tabId)]) {
    return;
  }

  await removeStoredKey(WATCHED_TABS_KEY, String(tabId));
});

async function getStoredObject(key) {
  const result = await chrome.storage.local.get(key);
  return result[key] || {};
}

async function updateStoredObject(key, updater) {
  const next = updater({ ...(await getStoredObject(key)) });
  await chrome.storage.local.set({ [key]: next });
}

async function removeStoredKey(key, nestedKey) {
  await updateStoredObject(key, (next) => {
    delete next[nestedKey];
    return next;
  });
}

function formatEvent(event) {
  return [
    event.title || "Website update",
    event.summary || "Meaningful page update detected.",
    event.url || "",
    event.timestamp || new Date().toISOString()
  ]
    .filter(Boolean)
    .join("\n");
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeSubscriptionName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(name)) {
    throw new Error(
      "ntfy topic names must be 3-64 characters and use only letters, numbers, dots, underscores, or dashes."
    );
  }
  return name;
}

function shouldPostWebhook(settings) {
  if (!settings.webhookUrl) {
    return false;
  }

  if (!settings.subscriptionName) {
    return true;
  }

  try {
    const url = new URL(settings.webhookUrl);
    const isLocalBridge =
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.pathname === "/event";
    return !isLocalBridge;
  } catch (error) {
    return true;
  }
}
