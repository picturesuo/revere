const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const MODE = process.env.BRIDGE_MODE || "log";

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, { ok: true, mode: MODE });
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

  writeJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Website Updater bridge listening on http://localhost:${PORT}`);
  console.log(`Mode: ${MODE}`);
});

async function dispatchEvent(event) {
  if (MODE === "log") {
    console.log(formatEvent(event));
    return;
  }

  if (MODE === "twilio_whatsapp") {
    await sendViaTwilio(event);
    return;
  }

  if (MODE === "meta_whatsapp") {
    await sendViaMeta(event);
    return;
  }

  if (MODE === "ntfy") {
    await sendViaNtfy(event);
    return;
  }

  if (MODE === "telegram") {
    await sendViaTelegram(event);
    return;
  }

  throw new Error(`Unsupported BRIDGE_MODE: ${MODE}`);
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
  const topic = requiredEnv("NTFY_TOPIC");
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  const response = await fetch(`${trimTrailingSlash(server)}/${topic}`, {
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
    const text = await response.text();
    throw new Error(`ntfy request failed with status ${response.status}: ${text}`);
  }
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
