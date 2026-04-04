const SETTINGS_KEY = "settings";

const webhookInput = document.getElementById("webhook-url");
const notificationsInput = document.getElementById("notifications-enabled");
const saveButton = document.getElementById("save");
const messageEl = document.getElementById("message");

loadSettings().catch((error) => {
  messageEl.textContent = error.message;
});

saveButton.addEventListener("click", async () => {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      webhookUrl: webhookInput.value.trim(),
      notificationsEnabled: notificationsInput.checked
    }
  });

  messageEl.textContent = "Saved.";
});

async function loadSettings() {
  const { [SETTINGS_KEY]: settings = {} } = await chrome.storage.local.get(SETTINGS_KEY);
  webhookInput.value = settings.webhookUrl || "";
  notificationsInput.checked = settings.notificationsEnabled !== false;
}
