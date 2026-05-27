const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const PORT = Number(process.env.PORT || 8787);
const MODE = process.env.BRIDGE_MODE || "log";
const execFileAsync = promisify(execFile);
const SCREEN_SAMPLE_WIDTH = 128;
const SCREEN_SAMPLE_HEIGHT = 72;
const SCREEN_PIXEL_DIFF_THRESHOLD = 24;
const SCREEN_DIFF_RATIO_THRESHOLD = 0.012;
const SCREEN_BBOX_RATIO_THRESHOLD = 0.025;
const SCREEN_BBOX_EDGE_RATIO_THRESHOLD = 0.02;
const SCREEN_WATCH_DEFAULT_INTERVAL_MS = 5000;
const SCREEN_WATCH_MIN_INTERVAL_MS = 2000;
const SCREEN_WATCH_MAX_INTERVAL_MS = 60000;
const SCREEN_WATCH_EVENT_COOLDOWN_MS = 15000;
const SENDERS = {
  log: async (event) => console.log(formatEvent(event)),
  twilio_whatsapp: sendViaTwilio,
  meta_whatsapp: sendViaMeta,
  ntfy: sendViaNtfy,
  telegram: sendViaTelegram
};
const screenWatchState = {
  timer: null,
  inFlight: false,
  previousSample: null,
  intervalMs: SCREEN_WATCH_DEFAULT_INTERVAL_MS,
  lastScanAt: 0,
  lastEventAt: 0,
  label: "Desktop"
};

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, { ok: true, mode: MODE, screenWatch: screenWatchStatus() });
    return;
  }

  if (req.method === "GET" && req.url === "/screen-watch") {
    writeJson(res, 200, { ok: true, screenWatch: screenWatchStatus() });
    return;
  }

  if (req.method === "POST" && req.url === "/event") {
    try {
      const payload = await readJson(req);
      await dispatchEvent(payload);
      writeJson(res, 200, { ok: true });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && (req.url === "/agent" || req.url === "/agent-attention")) {
    try {
      const payload = await readJson(req);
      await dispatchEvent(buildAgentAttentionEvent(payload));
      writeJson(res, 200, { ok: true });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/screen-watch/start") {
    try {
      const payload = await readJson(req);
      await startScreenWatch(payload);
      writeJson(res, 200, { ok: true, screenWatch: screenWatchStatus() });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/screen-watch/stop") {
    stopScreenWatch();
    writeJson(res, 200, { ok: true, screenWatch: screenWatchStatus() });
    return;
  }

  if (req.method === "POST" && req.url === "/validate-subscription-name") {
    try {
      const payload = await readJson(req);
      const name = normalizeSubscriptionName(payload.name);
      const available = MODE !== "ntfy" ? true : !(await ntfyTopicHasMessages(name));
      writeJson(res, 200, { ok: true, available });
    } catch (error) {
      writeJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  writeJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Revere bridge listening on http://localhost:${PORT}`);
  console.log(`Mode: ${MODE}`);
  if (process.env.REVERE_SCREEN_WATCH === "1") {
    startScreenWatch({
      intervalMs: process.env.REVERE_SCREEN_WATCH_INTERVAL_MS,
      label: process.env.REVERE_SCREEN_WATCH_LABEL
    }).catch((error) => {
      console.error(`Screen watch failed to start: ${error.message}`);
    });
  }
});

async function dispatchEvent(event) {
  const sender = SENDERS[MODE];
  if (!sender) {
    throw new Error(`Unsupported BRIDGE_MODE: ${MODE}`);
  }

  await sender(event);
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

function buildAgentAttentionEvent(payload) {
  const agent = String(payload.agent || payload.source || "Agent").trim();
  const summary = String(
    payload.summary ||
      payload.message ||
      payload.task ||
      payload.prompt ||
      "An agent is waiting for your input."
  ).trim();

  return {
    type: "agent_attention",
    title: payload.title || `${agent} needs you`,
    summary,
    url: payload.url || payload.threadUrl || "",
    profile: "agent",
    source: "agent_attention",
    priority: payload.priority || "high",
    tags: payload.tags || "robot,bell",
    timestamp: new Date().toISOString()
  };
}

async function startScreenWatch(options = {}) {
  stopScreenWatch();
  screenWatchState.intervalMs = normalizeScreenWatchInterval(options.intervalMs);
  screenWatchState.label = String(options.label || "Desktop").trim() || "Desktop";
  screenWatchState.previousSample = null;
  screenWatchState.lastEventAt = 0;
  screenWatchState.timer = setInterval(() => {
    runScreenWatchPass("timer").catch((error) => {
      console.error(`Screen watch scan failed: ${error.message}`);
    });
  }, screenWatchState.intervalMs);
  await runScreenWatchPass("start");
}

function stopScreenWatch() {
  if (screenWatchState.timer) {
    clearInterval(screenWatchState.timer);
  }
  screenWatchState.timer = null;
  screenWatchState.inFlight = false;
  screenWatchState.previousSample = null;
}

function screenWatchStatus() {
  return {
    running: Boolean(screenWatchState.timer),
    intervalMs: screenWatchState.intervalMs,
    lastScanAt: screenWatchState.lastScanAt
      ? new Date(screenWatchState.lastScanAt).toISOString()
      : "",
    lastEventAt: screenWatchState.lastEventAt
      ? new Date(screenWatchState.lastEventAt).toISOString()
      : "",
    label: screenWatchState.label
  };
}

async function runScreenWatchPass(reason) {
  if (screenWatchState.inFlight) {
    return;
  }

  screenWatchState.inFlight = true;
  screenWatchState.lastScanAt = Date.now();
  try {
    const currentSample = await captureDesktopSample();
    const previousSample = screenWatchState.previousSample;
    screenWatchState.previousSample = currentSample;
    if (!previousSample) {
      return;
    }

    const diff = compareImageSamples(previousSample, currentSample);
    if (!isMeaningfulScreenDiff(diff, currentSample)) {
      return;
    }

    const now = Date.now();
    if (now - screenWatchState.lastEventAt < SCREEN_WATCH_EVENT_COOLDOWN_MS) {
      return;
    }

    screenWatchState.lastEventAt = now;
    await dispatchEvent(buildScreenWatchEvent(diff, reason));
  } finally {
    screenWatchState.inFlight = false;
  }
}

async function captureDesktopSample() {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const basePath = path.join(os.tmpdir(), `revere-screen-${id}`);
  const pngPath = `${basePath}.png`;
  const bmpPath = `${basePath}.bmp`;

  try {
    await execFileAsync("/usr/sbin/screencapture", ["-x", "-t", "png", pngPath], {
      timeout: 10000
    });
    await execFileAsync(
      "/usr/bin/sips",
      [
        "-s",
        "format",
        "bmp",
        "-z",
        String(SCREEN_SAMPLE_HEIGHT),
        String(SCREEN_SAMPLE_WIDTH),
        pngPath,
        "--out",
        bmpPath
      ],
      { timeout: 10000 }
    );
    const bytes = await fs.readFile(bmpPath);
    return parseBmpSample(bytes);
  } finally {
    await fs.unlink(pngPath).catch(() => {});
    await fs.unlink(bmpPath).catch(() => {});
  }
}

function parseBmpSample(bytes) {
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error("sips did not return a BMP image.");
  }

  const dataOffset = bytes.readUInt32LE(10);
  const width = bytes.readInt32LE(18);
  const rawHeight = bytes.readInt32LE(22);
  const bitsPerPixel = bytes.readUInt16LE(28);
  if (![24, 32].includes(bitsPerPixel)) {
    throw new Error(`Unsupported BMP depth: ${bitsPerPixel}`);
  }

  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bytesPerPixel = bitsPerPixel / 8;
  const rowStride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  const pixels = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const sourceY = topDown ? y : height - 1 - y;
    const rowOffset = dataOffset + sourceY * rowStride;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + x * bytesPerPixel;
      const blue = bytes[offset];
      const green = bytes[offset + 1];
      const red = bytes[offset + 2];
      pixels[y * width + x] = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
    }
  }

  return { width, height, pixels };
}

function compareImageSamples(previous, current) {
  if (!previous || !current || previous.width !== current.width || previous.height !== current.height) {
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
    if (diff < SCREEN_PIXEL_DIFF_THRESHOLD) {
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
  return {
    changedPixels,
    changedRatio: changedPixels / totalPixels,
    bboxRatio: (bboxWidth * bboxHeight) / totalPixels,
    bboxWidthRatio: bboxWidth / width,
    bboxHeightRatio: bboxHeight / height,
    minX,
    minY,
    maxX,
    maxY
  };
}

function isMeaningfulScreenDiff(diff, sample) {
  if (!diff) {
    return false;
  }

  return (
    diff.changedRatio >= SCREEN_DIFF_RATIO_THRESHOLD &&
    diff.bboxRatio >= SCREEN_BBOX_RATIO_THRESHOLD &&
    !isThinScreenEdgeStrip(diff, sample.width, sample.height)
  );
}

function isThinScreenEdgeStrip(diff, width, height) {
  const edge = SCREEN_BBOX_EDGE_RATIO_THRESHOLD;
  const leftEdge = diff.minX <= Math.floor(width * edge);
  const rightEdge = diff.maxX >= width - 1 - Math.floor(width * edge);
  const topEdge = diff.minY <= Math.floor(height * edge);
  const bottomEdge = diff.maxY >= height - 1 - Math.floor(height * edge);
  const thinVerticalStrip = diff.bboxWidthRatio < edge && (leftEdge || rightEdge);
  const thinHorizontalStrip = diff.bboxHeightRatio < edge && (topEdge || bottomEdge);
  return thinVerticalStrip || thinHorizontalStrip;
}

function buildScreenWatchEvent(diff, reason) {
  const percent = Math.max(1, Math.round(diff.changedRatio * 100));
  return {
    type: "screen_update",
    title: `${screenWatchState.label} changed`,
    summary: `Visible desktop changed (${percent}% of sampled pixels changed).`,
    url: "",
    profile: "visual",
    source: `screen_watch:${reason}`,
    priority: "high",
    tags: "desktop,bell",
    timestamp: new Date().toISOString()
  };
}

async function sendViaTwilio(event) {
  const accountSid = requiredEnv("TWILIO_ACCOUNT_SID");
  const authToken = requiredEnv("TWILIO_AUTH_TOKEN");
  const from = requiredEnv("TWILIO_WHATSAPP_FROM");
  const to = requiredEnv("TWILIO_WHATSAPP_TO");

  const body = new URLSearchParams({
    From: from,
    To: to,
    Body: formatEvent(event)
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    }
  );

  if (!response.ok) {
    throw new Error(`Twilio request failed with status ${response.status}`);
  }
}

async function sendViaMeta(event) {
  const token = requiredEnv("META_ACCESS_TOKEN");
  const phoneNumberId = requiredEnv("META_PHONE_NUMBER_ID");
  const to = requiredEnv("META_WHATSAPP_TO");

  const response = await fetch(`https://graph.facebook.com/v23.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: {
        preview_url: false,
        body: formatEvent(event)
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Meta request failed with status ${response.status}: ${text}`);
  }
}

async function sendViaNtfy(event) {
  const topic = event.subscriptionName
    ? normalizeSubscriptionName(event.subscriptionName)
    : requiredEnv("NTFY_TOPIC");
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  const response = await fetch(`${trimTrailingSlash(server)}/${topic}`, {
    method: "POST",
    headers: {
      Title: event.title || "Website update",
      Priority: normalizeNtfyPriority(event.priority || "urgent"),
      Tags: formatNtfyTags(event),
      Click: event.url || ""
    },
    body: formatEvent(event)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ntfy request failed with status ${response.status}: ${text}`);
  }
}

async function ntfyTopicHasMessages(name) {
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  const response = await fetch(
    `${trimTrailingSlash(server)}/${encodeURIComponent(name)}/json?poll=1&since=all&limit=1`
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ntfy validation failed with status ${response.status}: ${text}`);
  }

  const body = await response.text();
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      try {
        const message = JSON.parse(line);
        return message.event === "message";
      } catch (error) {
        return false;
      }
    });
}

async function sendViaTelegram(event) {
  const token = requiredEnv("TELEGRAM_BOT_TOKEN");
  const chatId = requiredEnv("TELEGRAM_CHAT_ID");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: formatEvent(event),
      disable_web_page_preview: false
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram request failed with status ${response.status}: ${text}`);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeSubscriptionName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(name)) {
    throw new Error(
      "Subscription names must be 3-64 characters and use only letters, numbers, dots, underscores, or dashes."
    );
  }
  return name;
}

function normalizeScreenWatchInterval(value) {
  const intervalMs = Number(value || SCREEN_WATCH_DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(intervalMs)) {
    return SCREEN_WATCH_DEFAULT_INTERVAL_MS;
  }
  return Math.min(
    SCREEN_WATCH_MAX_INTERVAL_MS,
    Math.max(SCREEN_WATCH_MIN_INTERVAL_MS, Math.round(intervalMs))
  );
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
