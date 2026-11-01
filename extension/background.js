async function enableApplicationCopilot() {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); }
  catch { /* Older Chromium builds keep the extension installed but cannot open the persistent panel. */ }
}

const CLEARLEAD_SERVER = "http://127.0.0.1:4173";
const HEALTH_ALARM = "clearlead-pairing-health";

async function checkClearLeadHealth() {
  const { clearleadToken, clearleadLastReloadVersion } = await chrome.storage.local.get(["clearleadToken", "clearleadLastReloadVersion"]);
  if (!clearleadToken) return;
  const currentVersion = chrome.runtime.getManifest().version;
  try {
    const response = await fetch(`${CLEARLEAD_SERVER}/api/extension/health`, {
      headers: { authorization: `Bearer ${clearleadToken}`, "x-clearlead-extension-id": chrome.runtime.id, "x-clearlead-extension-version": currentVersion },
    });
    const health = await response.json().catch(() => ({}));
    if (response.status === 401) {
      await clearRejectedToken(clearleadToken, health.error || "ClearLead revoked or replaced this pairing. Create a new token in the local app.");
      return;
    }
    if (!response.ok) return;
    await chrome.storage.local.set({ clearleadPairingHealth: { checkedAt: new Date().toISOString(), ...health }, clearleadPairingError: "" });
    const expected = health.extension?.expectedVersion;
    if (health.extension?.updateRequired && expected && clearleadLastReloadVersion !== expected) {
      await chrome.storage.local.set({ clearleadLastReloadVersion: expected });
      chrome.runtime.reload();
      return;
    }
    if (!health.extension?.updateRequired && clearleadLastReloadVersion) await chrome.storage.local.remove("clearleadLastReloadVersion");
  } catch {
    await chrome.storage.local.set({ clearleadPairingHealth: { checkedAt: new Date().toISOString(), offline: true } });
  }
}

async function clearRejectedToken(rejectedToken, message) {
  const current = await chrome.storage.local.get("clearleadToken");
  if (current.clearleadToken !== rejectedToken) return;
  await chrome.storage.local.remove(["clearleadToken", "clearleadLastReloadVersion"]);
  await chrome.storage.local.set({ clearleadPairingError: message });
}

async function initializeApplicationCopilot() {
  await enableApplicationCopilot();
  await chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 1 });
  await checkClearLeadHealth();
}

chrome.runtime.onInstalled.addListener(initializeApplicationCopilot);
chrome.runtime.onStartup.addListener(initializeApplicationCopilot);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === HEALTH_ALARM) checkClearLeadHealth(); });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "CLEARLEAD_AUTO_VERIFY_EVIDENCE") return false;
  submitAutomaticVerification(message.evidence, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function submitAutomaticVerification(evidence, sender) {
  const tabUrl = String(sender?.tab?.url || "");
  if (!/^https:\/\/(?:[^/]+\.)?(?:myworkdayjobs\.com|smartrecruiters\.com|greenhouse\.io|greenhouse\.com|lever\.co|ashbyhq\.com)\//i.test(tabUrl)) throw new Error("Unsupported verification page.");
  if (String(evidence?.pageUrl || "") !== tabUrl.replace(/#.*$/, "")) throw new Error("Verification page mismatch.");
  const { clearleadToken } = await chrome.storage.local.get("clearleadToken");
  if (!clearleadToken) throw new Error("Pair ClearLead before browser verification.");
  const currentVersion = chrome.runtime.getManifest().version;
  const response = await fetch(`${CLEARLEAD_SERVER}/api/extension/verify`, {
    method: "POST",
    headers: { authorization: `Bearer ${clearleadToken}`, "content-type": "application/json", "x-clearlead-extension-id": chrome.runtime.id, "x-clearlead-extension-version": currentVersion },
    body: JSON.stringify(evidence),
  });
  const verification = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(verification.error || `ClearLead returned HTTP ${response.status}.`);
  await chrome.storage.local.set({ clearleadLastVerification: { checkedAt: new Date().toISOString(), ...verification } });
  return { ok: true, status: verification.status };
}
initializeApplicationCopilot();
