const SETTINGS_KEY = "settings";

const webhookInput = document.getElementById("webhook-url");
const ntfyServerInput = document.getElementById("ntfy-server");
const subscriptionNameInput = document.getElementById("subscription-name");
const notificationsInput = document.getElementById("notifications-enabled");
const saveButton = document.getElementById("save");
const messageEl = document.getElementById("message");

loadSettings().catch((error) => {
  messageEl.textContent = error.message;
});

saveButton.addEventListener("click", async () => {
  const webhookUrl = normalizeWebhookUrl(webhookInput.value.trim(), subscriptionNameInput.value.trim());
  const ntfyServer = ntfyServerInput.value.trim() || "https://ntfy.sh";
  const subscriptionName = subscriptionNameInput.value.trim();

  messageEl.textContent = "Saving...";
  saveButton.disabled = true;

  try {
    validateSettings({ webhookUrl, ntfyServer, subscriptionName });

    await chrome.storage.local.set({
      [SETTINGS_KEY]: {
        webhookUrl,
        ntfyServer,
        subscriptionName,
        notificationsEnabled: notificationsInput.checked
      }
    });

    messageEl.textContent = subscriptionName
      ? "Saved. Phone push will go directly to your ntfy topic, and the local bridge webhook was skipped to avoid duplicate alerts."
      : "Saved.";
    webhookInput.value = webhookUrl;
  } catch (error) {
    messageEl.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    saveButton.disabled = false;
  }
});

async function loadSettings() {
  const { [SETTINGS_KEY]: settings = {} } = await chrome.storage.local.get(SETTINGS_KEY);
  webhookInput.value = settings.webhookUrl || "";
  ntfyServerInput.value = settings.ntfyServer || "https://ntfy.sh";
  subscriptionNameInput.value = settings.subscriptionName || "";
  notificationsInput.checked = settings.notificationsEnabled !== false;
}

function validateSettings({ webhookUrl, ntfyServer, subscriptionName }) {
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
