const WATCHED_TABS_KEY = "watchedTabs";
const EVENTS_KEY = "recentEvents";
const SETTINGS_KEY = "settings";
const MAX_EVENTS = 50;
const SCREENSHOT_SAMPLE_WIDTH = 128;
const SCREENSHOT_SAMPLE_HEIGHT = 72;
const SCREENSHOT_PIXEL_DIFF_THRESHOLD = 24;
const SCREENSHOT_DIFF_RATIO_THRESHOLD = 0.005;
const SCREENSHOT_BBOX_RATIO_THRESHOLD = 0.01;
const SCREENSHOT_BBOX_EDGE_RATIO_THRESHOLD = 0.02;
const VISUAL_SCAN_ALARM_NAME = "revere-visual-scan";
const VISUAL_SCAN_DEFAULT_INTERVAL_SECONDS = 5;
const VISUAL_SCAN_MIN_INTERVAL_SECONDS = 2;
const VISUAL_SCAN_MAX_INTERVAL_SECONDS = 60;
const VISUAL_SCAN_ALARM_PERIOD_MINUTES = 0.5;
const VISUAL_SCAN_MAX_TABS_PER_PASS = 6;
const VISUAL_EVENT_FINGERPRINT_TTL_MS = 20000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const NOTIFICATION_TARGETS_KEY = "notificationTargets";
const NOTIFICATION_ICON_URL = chrome.runtime.getURL("icon-128.png");
const DEFAULT_SETTINGS = {
  webhookUrl: "",
  ntfyServer: "https://ntfy.sh",
  subscriptionName: "",
  notificationsEnabled: true,
  ntfyTitleTemplate: "",
  ntfyMessageTemplate: "",
  visualScanEnabled: true,
  visualScanIntervalSeconds: VISUAL_SCAN_DEFAULT_INTERVAL_SECONDS,
  debuggerCaptureEnabled: true
};

chrome.runtime.onInstalled.addListener(async () => {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  if (!settings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  } else {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...settings } });
  }
  await ensureVisualScanScheduler();
});

const screenshotSamples = new Map();
const recentVisualFingerprints = new Map();
let visualScanTimerId = null;
let visualScanTimerIntervalSeconds = 0;
let visualScanInFlight = false;
let visualScanCursor = 0;
let lastVisualScanAt = 0;

ensureVisualScanScheduler().catch((error) => {
  console.error("Visual scan scheduler failed:", error);
});

chrome.runtime.onStartup?.addListener(() => {
  ensureVisualScanScheduler().catch((error) => {
    console.error("Visual scan startup failed:", error);
  });
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== VISUAL_SCAN_ALARM_NAME) {
    return;
  }

  scanWatchedTabsVisually("alarm").catch((error) => {
    console.error("Visual alarm scan failed:", error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || (!changes[WATCHED_TABS_KEY] && !changes[SETTINGS_KEY])) {
    return;
  }

  ensureVisualScanScheduler().catch((error) => {
    console.error("Visual scheduler sync failed:", error);
  });
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
    case "get-dashboard-data":
      return getDashboardData(message.tabId);
    case "get-content-state":
      return getContentState(sender);
    case "set-tab-monitoring":
      await setTabMonitoring(message.tabId, message.url, message.enabled, {
        name: message.name,
        mode: message.mode,
        ntfyTitleTemplate: message.ntfyTitleTemplate,
        ntfyMessageTemplate: message.ntfyMessageTemplate
      });
      await saveNtfyDefaults(message.ntfyTitleTemplate, message.ntfyMessageTemplate);
      return getPopupState(message.tabId);
    case "set-ntfy-defaults":
      await saveNtfyDefaults(message.ntfyTitleTemplate, message.ntfyMessageTemplate);
      return getPopupState(message.tabId);
    case "send-test-event":
      return sendTestEvent(message.tabId, message.url);
    case "page-update":
      await handlePageUpdate(message.payload, sender);
      return {};
    case "capture-visible-screenshot":
      return handleVisibleScreenshotRequest(message, sender);
    default:
      return {};
  }
}

async function getPopupState(tabId) {
  const [watchedTabs, settings] = await Promise.all([
    getStoredObject(WATCHED_TABS_KEY),
    getSettings()
  ]);
  return {
    watched: Boolean(watchedTabs[String(tabId)]),
    watch: watchedTabs[String(tabId)] || null,
    ntfyDefaults: {
      titleTemplate: settings.ntfyTitleTemplate || "",
      messageTemplate: settings.ntfyMessageTemplate || ""
    }
  };
}

async function getDashboardData(tabId) {
  const [watchedTabs, settings, events] = await Promise.all([
    getStoredObject(WATCHED_TABS_KEY),
    getSettings(),
    getRecentEvents()
  ]);

  const watches = Object.entries(watchedTabs).map(([storedTabId, watch]) => ({
    tabId: Number(storedTabId),
    ...watch
  }));

  return {
    settings,
    watches,
    currentWatch: watchedTabs[String(tabId)] || null,
    recentEvents: events,
    visualScanner: {
      enabled: settings.visualScanEnabled !== false,
      intervalSeconds: normalizeVisualScanInterval(settings.visualScanIntervalSeconds),
      debuggerCaptureEnabled: settings.debuggerCaptureEnabled !== false,
      timerActive: Boolean(visualScanTimerId),
      lastScanAt: lastVisualScanAt ? new Date(lastVisualScanAt).toISOString() : ""
    },
    onboarding: {
      extensionLoaded: true,
      phonePushReady: Boolean(settings.subscriptionName || settings.webhookUrl),
      hasWatch: watches.length > 0
    }
  };
}

async function getContentState(sender) {
  const tabId = sender.tab?.id;
  if (!tabId) {
    return { tabId: null, watched: false };
  }

  const watchedTabs = await getStoredObject(WATCHED_TABS_KEY);
  return {
    tabId,
    watched: Boolean(watchedTabs[String(tabId)]),
    watch: watchedTabs[String(tabId)] || null
  };
}

async function setTabMonitoring(tabId, url, enabled, metadata = {}) {
  if (!tabId) {
    return;
  }

  await updateStoredObject(WATCHED_TABS_KEY, (next) => {
    if (enabled) {
      const previous = next[String(tabId)] || {};
      next[String(tabId)] = {
        url,
        name: metadata.name || previous.name || "",
        mode: metadata.mode || previous.mode || "page",
        ntfyTitleTemplate: normalizeTemplateValue(metadata.ntfyTitleTemplate, previous.ntfyTitleTemplate),
        ntfyMessageTemplate: normalizeTemplateValue(
          metadata.ntfyMessageTemplate,
          previous.ntfyMessageTemplate
        ),
        enabledAt: previous.enabledAt || new Date().toISOString()
      };
      return next;
    }

    delete next[String(tabId)];
    return next;
  });
}

async function sendTestEvent(tabId, url) {
  const watchedTabs = await getStoredObject(WATCHED_TABS_KEY);
  const settings = await getSettings();
  const watch = watchedTabs[String(tabId)] || null;
  const titleTemplate = watch?.ntfyTitleTemplate || settings.ntfyTitleTemplate;
  const messageTemplate = watch?.ntfyMessageTemplate || settings.ntfyMessageTemplate;
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
    ntfyTitle: renderTemplate(titleTemplate, {
      title: "Revere Test",
      summary: "Manual extension test notification.",
      url: url || "https://example.com",
      profile: "manual",
      source: "manual",
      domain: url ? safeDomain(url) : "example.com",
      timestamp: new Date().toISOString()
    }),
    ntfyMessage: renderTemplate(messageTemplate, {
      title: "Revere Test",
      summary: "Manual extension test notification.",
      url: url || "https://example.com",
      profile: "manual",
      source: "manual",
      domain: url ? safeDomain(url) : "example.com",
      timestamp: new Date().toISOString()
    }),
    timestamp: new Date().toISOString()
  }, settings, { strictDelivery: true });

  return {
    delivered: true,
    phoneConfigured: Boolean(settings.subscriptionName || settings.webhookUrl)
  };
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
    applyWatchTemplates(
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
      watchedTabs[String(tabId)]
    ),
    settings
  );
}

async function handleVisibleScreenshotRequest(message, sender) {
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (!tabId || typeof windowId !== "number") {
    return { captured: false, changed: false };
  }

  const [watchedTabs, settings] = await Promise.all([
    getStoredObject(WATCHED_TABS_KEY),
    getSettings()
  ]);

  const watch = watchedTabs[String(tabId)];
  if (!watch) {
    return { captured: false, changed: false };
  }

  if (!sender.tab.active) {
    return { captured: false, changed: false };
  }

  const windowInfo = await chrome.windows.get(windowId).catch(() => null);
  if (!windowInfo?.focused) {
    return { captured: false, changed: false };
  }

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    console.error("Screenshot capture failed:", error);
    return { captured: false, changed: false };
  }

  if (!dataUrl) {
    return { captured: false, changed: false };
  }

  return processVisualSample({
    tabId,
    watch,
    settings,
    dataUrl,
    captureMethod: "visible_tab",
    url: message.url || sender.tab.url || "",
    title: message.title || sender.tab.title || "Visual update"
  });
}

async function ensureVisualScanScheduler() {
  const [watchedTabs, settings] = await Promise.all([
    getStoredObject(WATCHED_TABS_KEY),
    getSettings()
  ]);
  const hasWatches = Object.keys(watchedTabs).length > 0;
  const enabled = hasWatches && settings.visualScanEnabled !== false;

  if (!enabled) {
    stopVisualScanTimer();
    if (chrome.alarms?.clear) {
      await chrome.alarms.clear(VISUAL_SCAN_ALARM_NAME).catch(() => {});
    }
    return;
  }

  const intervalSeconds = normalizeVisualScanInterval(settings.visualScanIntervalSeconds);
  startVisualScanTimer(intervalSeconds);

  if (chrome.alarms?.create) {
    await chrome.alarms.create(VISUAL_SCAN_ALARM_NAME, {
      delayInMinutes: VISUAL_SCAN_ALARM_PERIOD_MINUTES,
      periodInMinutes: VISUAL_SCAN_ALARM_PERIOD_MINUTES
    }).catch((error) => {
      console.warn("Visual alarm creation failed:", error);
    });
  }
}

function startVisualScanTimer(intervalSeconds) {
  if (visualScanTimerId && visualScanTimerIntervalSeconds === intervalSeconds) {
    return;
  }

  stopVisualScanTimer();
  visualScanTimerIntervalSeconds = intervalSeconds;
  visualScanTimerId = setInterval(() => {
    scanWatchedTabsVisually("timer").catch((error) => {
      console.error("Visual timer scan failed:", error);
    });
  }, intervalSeconds * 1000);
}

function stopVisualScanTimer() {
  if (visualScanTimerId) {
    clearInterval(visualScanTimerId);
  }
  visualScanTimerId = null;
  visualScanTimerIntervalSeconds = 0;
}

async function scanWatchedTabsVisually(reason = "manual") {
  if (visualScanInFlight) {
    return;
  }

  const [watchedTabs, settings] = await Promise.all([
    getStoredObject(WATCHED_TABS_KEY),
    getSettings()
  ]);
  if (settings.visualScanEnabled === false) {
    await ensureVisualScanScheduler();
    return;
  }

  const intervalSeconds = normalizeVisualScanInterval(settings.visualScanIntervalSeconds);
  const minGapMs = Math.max(1000, intervalSeconds * 1000 - 250);
  const now = Date.now();
  if (reason !== "manual" && lastVisualScanAt && now - lastVisualScanAt < minGapMs) {
    return;
  }

  const watches = Object.entries(watchedTabs)
    .map(([tabId, watch]) => ({ tabId: Number(tabId), watch }))
    .filter((item) => Number.isInteger(item.tabId) && item.tabId > 0);
  if (!watches.length) {
    await ensureVisualScanScheduler();
    return;
  }

  visualScanInFlight = true;
  lastVisualScanAt = now;
  try {
    const ordered = rotateVisualWatches(watches);
    for (const { tabId, watch } of ordered.slice(0, VISUAL_SCAN_MAX_TABS_PER_PASS)) {
      await scanTabVisually(tabId, watch, settings);
    }
  } finally {
    visualScanInFlight = false;
    pruneRecentVisualFingerprints(Date.now());
  }
}

function rotateVisualWatches(watches) {
  if (watches.length <= VISUAL_SCAN_MAX_TABS_PER_PASS) {
    return watches;
  }

  const start = visualScanCursor % watches.length;
  visualScanCursor = (start + VISUAL_SCAN_MAX_TABS_PER_PASS) % watches.length;
  return [...watches.slice(start), ...watches.slice(0, start)];
}

async function scanTabVisually(tabId, watch, settings) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.discarded || !isCapturableTabUrl(tab.url)) {
    return;
  }

  const capture = await captureTabScreenshot(tab, settings);
  if (!capture?.dataUrl) {
    return;
  }

  await processVisualSample({
    tabId,
    watch,
    settings,
    dataUrl: capture.dataUrl,
    captureMethod: capture.method,
    url: tab.url || watch.url || "",
    title: tab.title || watch.name || "Visual update"
  });
}

async function captureTabScreenshot(tab, settings) {
  if (settings.debuggerCaptureEnabled !== false) {
    const debuggerCapture = await captureTabScreenshotWithDebugger(tab.id);
    if (debuggerCapture) {
      return { dataUrl: debuggerCapture, method: "debugger_screenshot" };
    }
  }

  if (!tab.active || typeof tab.windowId !== "number") {
    return null;
  }

  const windowInfo = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!windowInfo?.focused) {
    return null;
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return dataUrl ? { dataUrl, method: "visible_tab" } : null;
  } catch (error) {
    console.warn("Visible tab visual capture failed:", error);
    return null;
  }
}

async function captureTabScreenshotWithDebugger(tabId) {
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand) {
    return null;
  }

  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    attached = true;
    await chrome.debugger.sendCommand(target, "Page.enable");
    const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true
    });
    return result?.data ? `data:image/png;base64,${result.data}` : null;
  } catch (error) {
    console.warn("Debugger visual capture failed:", error);
    return null;
  } finally {
    if (attached) {
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
}

async function processVisualSample({ tabId, watch, settings, dataUrl, captureMethod, url, title }) {
  const currentSample = await buildScreenshotSample(dataUrl);
  if (!currentSample) {
    return { captured: false, changed: false };
  }

  const previousSample = screenshotSamples.get(String(tabId)) || null;
  screenshotSamples.set(String(tabId), currentSample);

  if (!previousSample) {
    return { captured: true, changed: false, method: captureMethod };
  }

  const diff = compareScreenshotSamples(previousSample, currentSample);
  if (!diff) {
    return { captured: true, changed: false, method: captureMethod };
  }

  if (
    diff.changedRatio < SCREENSHOT_DIFF_RATIO_THRESHOLD ||
    diff.bboxRatio < SCREENSHOT_BBOX_RATIO_THRESHOLD ||
    isThinEdgeStrip(diff, currentSample.width, currentSample.height)
  ) {
    return {
      captured: true,
      changed: false,
      method: captureMethod,
      changedRatio: diff.changedRatio,
      bboxRatio: diff.bboxRatio,
      bboxWidthRatio: diff.bboxWidthRatio,
      bboxHeightRatio: diff.bboxHeightRatio
    };
  }

  const fingerprint = `screenshot:${tabId}:${diff.signature}`;
  const now = Date.now();
  if (isRecentVisualFingerprint(fingerprint, now)) {
    return {
      captured: true,
      changed: false,
      duplicate: true,
      method: captureMethod
    };
  }
  rememberVisualFingerprint(fingerprint, now);

  await dispatchEvent(
    applyWatchTemplates(
      {
        type: "page_update",
        tabId,
        url,
        title: title || "Visual update",
        summary: buildVisualSummary(captureMethod, diff),
        fingerprint,
        profile: "visual",
        score: 12,
        source: captureMethod,
        timestamp: new Date().toISOString()
      },
      watch
    ),
    settings
  );

  return {
    captured: true,
    changed: true,
    method: captureMethod,
    changedRatio: diff.changedRatio,
    bboxRatio: diff.bboxRatio,
    bboxWidthRatio: diff.bboxWidthRatio,
    bboxHeightRatio: diff.bboxHeightRatio
  };
}

function buildVisualSummary(captureMethod, diff) {
  const percent = Math.max(1, Math.round(diff.changedRatio * 100));
  if (captureMethod === "debugger_screenshot") {
    return `Background tab visual change detected (${percent}% of sampled pixels changed).`;
  }
  return `Visible page visual change detected (${percent}% of sampled pixels changed).`;
}

function normalizeVisualScanInterval(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return VISUAL_SCAN_DEFAULT_INTERVAL_SECONDS;
  }
  return Math.min(
    VISUAL_SCAN_MAX_INTERVAL_SECONDS,
    Math.max(VISUAL_SCAN_MIN_INTERVAL_SECONDS, Math.round(seconds))
  );
}

function isCapturableTabUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch (error) {
    return false;
  }
}

function isRecentVisualFingerprint(fingerprint, now) {
  const previous = recentVisualFingerprints.get(fingerprint);
  return Boolean(previous && now - previous < VISUAL_EVENT_FINGERPRINT_TTL_MS);
}

function rememberVisualFingerprint(fingerprint, now) {
  recentVisualFingerprints.set(fingerprint, now);
  pruneRecentVisualFingerprints(now);
}

function pruneRecentVisualFingerprints(now) {
  for (const [fingerprint, sentAt] of recentVisualFingerprints.entries()) {
    if (now - sentAt > VISUAL_EVENT_FINGERPRINT_TTL_MS) {
      recentVisualFingerprints.delete(fingerprint);
    }
  }
}

async function dispatchEvent(event, providedSettings, options = {}) {
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
      if (options.strictDelivery) {
        throw error;
      }
      console.error("ntfy delivery failed:", error);
    }
  }

  if (shouldPostWebhook(settings)) {
    try {
      await postWebhook(settings.webhookUrl, event);
    } catch (error) {
      if (options.strictDelivery) {
        throw error;
      }
      console.error("Webhook delivery failed:", error);
    }
  }
}

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}

async function getRecentEvents() {
  const result = await chrome.storage.local.get(EVENTS_KEY);
  return result[EVENTS_KEY] || [];
}

async function appendEvent(event) {
  const { [EVENTS_KEY]: events = [] } = await chrome.storage.local.get(EVENTS_KEY);
  const next = [event, ...events].slice(0, MAX_EVENTS);
  await chrome.storage.local.set({ [EVENTS_KEY]: next });
}

async function buildScreenshotSample(dataUrl) {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    return null;
  }

  let bitmap = null;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(SCREENSHOT_SAMPLE_WIDTH, SCREENSHOT_SAMPLE_HEIGHT);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return null;
    }

    ctx.drawImage(bitmap, 0, 0, SCREENSHOT_SAMPLE_WIDTH, SCREENSHOT_SAMPLE_HEIGHT);
    const source = ctx.getImageData(0, 0, SCREENSHOT_SAMPLE_WIDTH, SCREENSHOT_SAMPLE_HEIGHT).data;
    const pixels = new Uint8Array(SCREENSHOT_SAMPLE_WIDTH * SCREENSHOT_SAMPLE_HEIGHT);

    for (let i = 0, j = 0; i < source.length; i += 4, j += 1) {
      pixels[j] = Math.round(
        source[i] * 0.299 + source[i + 1] * 0.587 + source[i + 2] * 0.114
      );
    }

    return {
      width: SCREENSHOT_SAMPLE_WIDTH,
      height: SCREENSHOT_SAMPLE_HEIGHT,
      pixels
    };
  } catch (error) {
    console.error("Screenshot sample build failed:", error);
    return null;
  } finally {
    if (bitmap) {
      bitmap.close();
    }
  }
}

function compareScreenshotSamples(previous, current) {
  if (
    !previous ||
    !current ||
    previous.width !== current.width ||
    previous.height !== current.height
  ) {
    return null;
  }

  const width = current.width;
  const height = current.height;
  const totalPixels = width * height;
  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let index = 0; index < totalPixels; index += 1) {
    const diff = Math.abs(current.pixels[index] - previous.pixels[index]);
    if (diff < SCREENSHOT_PIXEL_DIFF_THRESHOLD) {
      continue;
    }

    changedPixels += 1;
    const x = index % width;
    const y = Math.floor(index / width);

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  if (!changedPixels) {
    return null;
  }

  const bboxWidth = maxX - minX + 1;
  const bboxHeight = maxY - minY + 1;
  const bboxRatio = (bboxWidth * bboxHeight) / totalPixels;
  const bboxWidthRatio = bboxWidth / width;
  const bboxHeightRatio = bboxHeight / height;
  const changedRatio = changedPixels / totalPixels;
  const signature = `${changedPixels}:${minX}:${minY}:${maxX}:${maxY}`;

  return {
    changedPixels,
    changedRatio,
    bboxRatio,
    bboxWidthRatio,
    bboxHeightRatio,
    minX,
    minY,
    maxX,
    maxY,
    signature
  };
}

function isThinEdgeStrip(diff, width, height) {
  const leftEdge = diff.minX <= Math.floor(width * SCREENSHOT_BBOX_EDGE_RATIO_THRESHOLD);
  const rightEdge = diff.maxX >= width - 1 - Math.floor(width * SCREENSHOT_BBOX_EDGE_RATIO_THRESHOLD);
  const topEdge = diff.minY <= Math.floor(height * SCREENSHOT_BBOX_EDGE_RATIO_THRESHOLD);
  const bottomEdge = diff.maxY >= height - 1 - Math.floor(height * SCREENSHOT_BBOX_EDGE_RATIO_THRESHOLD);

  const thinVerticalStrip = diff.bboxWidthRatio < SCREENSHOT_BBOX_EDGE_RATIO_THRESHOLD && (leftEdge || rightEdge);
  const thinHorizontalStrip = diff.bboxHeightRatio < SCREENSHOT_BBOX_EDGE_RATIO_THRESHOLD && (topEdge || bottomEdge);

  return thinVerticalStrip || thinHorizontalStrip;
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
  const templateData = {
    title: event.title || "",
    summary: event.summary || "",
    url: event.url || "",
    profile: event.profile || "",
    source: event.source || "",
    domain: safeDomain(event.url),
    timestamp: event.timestamp || ""
  };
  const ntfyTitle = event.ntfyTitle || renderTemplate(settings.ntfyTitleTemplate, templateData);
  const ntfyMessage = event.ntfyMessage || renderTemplate(settings.ntfyMessageTemplate, templateData);
  const response = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      Title: ntfyTitle || event.title || "Website update",
      Priority: normalizeNtfyPriority(event.priority || "urgent"),
      Tags: formatNtfyTags(event),
      Click: event.url || ""
    },
    body: ntfyMessage || formatEvent(event)
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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title) {
    return;
  }

  if (changeInfo.url) {
    screenshotSamples.delete(String(tabId));
  }

  await updateStoredObject(WATCHED_TABS_KEY, (next) => {
    const watch = next[String(tabId)];
    if (!watch) {
      return next;
    }

    next[String(tabId)] = {
      ...watch,
      url: changeInfo.url || tab.url || watch.url,
      name: watch.name || tab.title || ""
    };
    return next;
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const watchedTabs = await getStoredObject(WATCHED_TABS_KEY);
  if (!watchedTabs[String(tabId)]) {
    screenshotSamples.delete(String(tabId));
    return;
  }

  await removeStoredKey(WATCHED_TABS_KEY, String(tabId));
  screenshotSamples.delete(String(tabId));
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

function applyWatchTemplates(event, watch) {
  const templateData = {
    title: event.title || "",
    summary: event.summary || "",
    url: event.url || "",
    profile: event.profile || "",
    source: event.source || "",
    domain: safeDomain(event.url),
    timestamp: event.timestamp || ""
  };

  return {
    ...event,
    ntfyTitle: renderTemplate(watch?.ntfyTitleTemplate, templateData),
    ntfyMessage: renderTemplate(watch?.ntfyMessageTemplate, templateData)
  };
}

function renderTemplate(template, data) {
  const normalizedTemplate = String(template || "").trim();
  if (!normalizedTemplate) {
    return "";
  }

  return normalizedTemplate.replace(/\{\{\s*(title|summary|url|profile|source|domain|timestamp)\s*\}\}/gi, (match, key) => {
    const value = data[key.toLowerCase()];
    return value == null ? "" : String(value);
  });
}

function normalizeTemplateValue(nextValue, previousValue = "") {
  if (typeof nextValue === "string") {
    return nextValue.trim();
  }

  return String(previousValue || "").trim();
}

async function saveNtfyDefaults(titleTemplate, messageTemplate) {
  const settings = await getSettings();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...settings,
      ntfyTitleTemplate: normalizeTemplateValue(titleTemplate, settings.ntfyTitleTemplate),
      ntfyMessageTemplate: normalizeTemplateValue(messageTemplate, settings.ntfyMessageTemplate)
    }
  });
}

function safeDomain(url) {
  try {
    return new URL(url || "").hostname.replace(/^www\./, "");
  } catch (error) {
    return "";
  }
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

function normalizeNtfyPriority(value) {
  const priority = String(value || "").toLowerCase();
  return ["min", "low", "default", "high", "urgent", "1", "2", "3", "4", "5"].includes(priority)
    ? priority
    : "urgent";
}

function formatNtfyTags(event) {
  if (Array.isArray(event.tags)) {
    return event.tags.map((tag) => String(tag).trim()).filter(Boolean).join(",");
  }

  if (typeof event.tags === "string" && event.tags.trim()) {
    return event.tags.trim();
  }

  if (event.profile === "sports") {
    return "rotating_light,trophy";
  }

  if (event.profile === "agent") {
    return "robot,bell";
  }

  return "rotating_light,bell";
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
