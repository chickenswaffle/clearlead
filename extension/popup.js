const SERVER = "http://127.0.0.1:4173";
const pairing = document.querySelector("#pairing");
const ready = document.querySelector("#ready");
const result = document.querySelector("#result");

document.querySelector("#save-token").addEventListener("click", saveToken);
document.querySelector("#fill").addEventListener("click", fillCurrentPage);
document.querySelector("#forget").addEventListener("click", forgetToken);

async function saveToken() {
  const token = document.querySelector("#token").value.trim();
  if (!token) return show("Paste the pairing token from ClearLead.", true);
  await chrome.storage.local.set({ clearleadToken: token });
  document.querySelector("#token").value = "";
  showReady(true);
  await checkPairing(token);
}

async function checkPairing(token) {
  try {
    const response = await fetch(`${SERVER}/api/extension/session`, { headers: { authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error(data.error || "Pairing was rejected.");
    show(data.packReady ? `Paired. Autofill pack ready for ${data.job.company} — ${data.job.title}.` : "Paired. Prepare a verified job in ClearLead before filling.");
  } catch (error) { show(error.message, true); }
}

async function fillCurrentPage() {
  const button = document.querySelector("#fill");
  button.disabled = true;
  try {
    const { clearleadToken } = await chrome.storage.local.get("clearleadToken");
    if (!clearleadToken) throw new Error("Pair the extension first.");
    const sessionResponse = await fetch(`${SERVER}/api/extension/session`, { headers: { authorization: `Bearer ${clearleadToken}` } });
    const session = await sessionResponse.json().catch(() => ({}));
    if (!sessionResponse.ok || !session.capability) throw new Error(session.error || "Prepare a verified job in ClearLead before filling.");
    const response = await fetch(`${SERVER}/api/extension/pack`, { headers: { authorization: `Bearer ${session.capability}` } });
    const pack = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(pack.error || `ClearLead returned HTTP ${response.status}.`);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active application tab is available.");
    const report = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_FILL_SAFE_FIELDS", pack });
    if (!report) throw new Error("Reload the application page and try again.");
    if (report.blockedPage) throw new Error(report.blockedPage);
    show(`${report.filled} safe fields filled · ${report.review} need review · ${report.blocked} sensitive fields blocked · ${report.manual} manual fields. Nothing was submitted.`);
  } catch (error) { show(error.message, true); }
  finally { button.disabled = false; }
}

async function forgetToken() {
  await chrome.storage.local.remove("clearleadToken");
  showReady(false);
  show("Pairing removed from this browser.");
}

function showReady(isReady) { pairing.hidden = isReady; ready.hidden = !isReady; }
function show(message, error = false) { result.className = `active ${error ? "error" : ""}`; result.textContent = message; }

chrome.storage.local.get("clearleadToken").then(({ clearleadToken }) => {
  showReady(Boolean(clearleadToken));
  if (clearleadToken) checkPairing(clearleadToken);
});
