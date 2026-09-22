const SERVER = "http://127.0.0.1:4173";
const pairing = document.querySelector("#pairing");
const ready = document.querySelector("#ready");
const result = document.querySelector("#result");

document.querySelector("#save-token").addEventListener("click", saveToken);
document.querySelector("#capture").addEventListener("click", captureCurrentPage);
document.querySelector("#fill").addEventListener("click", fillCurrentPage);
document.querySelector("#inspect").addEventListener("click", checkApplicationStatus);
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
    const inspection = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_INSPECT_APPLICATION" });
    if (!inspection || inspection.inspectionError) throw new Error(inspection?.inspectionError || "Reload the application page and try again.");
    if (inspection.phase === "complete") throw new Error("This application already appears complete.");
    if (inspection.phase !== "application") throw new Error("Open the employer's application form before filling fields.");
    const report = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_FILL_SAFE_FIELDS", pack });
    if (!report) throw new Error("Reload the application page and try again.");
    if (report.blockedPage) throw new Error(report.blockedPage);
    const afterFill = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_INSPECT_APPLICATION" });
    const recorded = await reportApplicationRun(session.capability, pack.id, tab.url, afterFill || inspection, report);
    show(`${String(report.atsFamily || inspection.atsFamily || "generic").toUpperCase()} · ${String(afterFill?.stepLabel || inspection.stepLabel || "Application")} · ${report.filled} safe fields filled · ${report.review} need review · ${report.blocked} sensitive fields blocked · ${report.manual} manual fields. ${runMessage(recorded.run)} Nothing was submitted.`);
  } catch (error) { show(error.message, true); }
  finally { button.disabled = false; }
}

async function checkApplicationStatus() {
  const button = document.querySelector("#inspect");
  button.disabled = true;
  try {
    const { clearleadToken } = await chrome.storage.local.get("clearleadToken");
    if (!clearleadToken) throw new Error("Pair the extension first.");
    const sessionResponse = await fetch(`${SERVER}/api/extension/session`, { headers: { authorization: `Bearer ${clearleadToken}` } });
    const session = await sessionResponse.json().catch(() => ({}));
    if (!sessionResponse.ok || !session.capability) throw new Error(session.error || "Prepare a verified job in ClearLead before checking status.");
    const packResponse = await fetch(`${SERVER}/api/extension/pack`, { headers: { authorization: `Bearer ${session.capability}` } });
    const pack = await packResponse.json().catch(() => ({}));
    if (!packResponse.ok) throw new Error(pack.error || `ClearLead returned HTTP ${packResponse.status}.`);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active application tab is available.");
    const inspection = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_INSPECT_APPLICATION" });
    if (!inspection || inspection.inspectionError) throw new Error(inspection?.inspectionError || "Reload the application page and try again.");
    const recorded = await reportApplicationRun(session.capability, pack.id, tab.url, inspection);
    show(runMessage(recorded.run), recorded.run?.status === "needs_review");
  } catch (error) { show(error.message, true); }
  finally { button.disabled = false; }
}

async function reportApplicationRun(capability, runId, pageUrl, inspection, fill = null) {
  const response = await fetch(`${SERVER}/api/extension/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
    body: JSON.stringify({ runId, pageUrl, inspection, ...(fill ? { fill } : {}) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `ClearLead returned HTTP ${response.status}.`);
  return data;
}

function runMessage(run) {
  if (run?.status === "complete") return "Employer-page completion evidence recorded. Application marked complete.";
  if (run?.status === "ready_for_final_approval") return "All required fields appear complete. Review the page once, then make the final Submit click yourself.";
  if (run?.status === "needs_review") return run.lastEvent?.emptyRequiredCount > 0
    ? `${run.lastEvent.emptyRequiredCount} required fields still appear empty. Review the highlighted and manual fields, then check again.`
    : "Highlighted or manual fields still need review. Resolve them, then check status again.";
  if (run?.lastEvent?.nextControlCount > 0) return `${run.lastEvent.stepLabel || "This step"} is ready. Review it, use the employer's Next or Continue button, then fill the next step.`;
  return "Application run saved. Continue on the employer page, then check status again.";
}

async function captureCurrentPage() {
  const button = document.querySelector("#capture");
  button.disabled = true;
  try {
    const { clearleadToken } = await chrome.storage.local.get("clearleadToken");
    if (!clearleadToken) throw new Error("Pair the extension first.");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active job page is available.");
    if (!/^https:\/\//i.test(String(tab.url || ""))) throw new Error("Open the HTTPS employer job page — not ClearLead — then try again.");
    const evidence = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_CAPTURE_VERIFICATION" });
    if (!evidence || evidence.captureError) throw new Error(evidence?.captureError || "Reload the job page and try again.");
    const response = await fetch(`${SERVER}/api/extension/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${clearleadToken}`, "content-type": "application/json" },
      body: JSON.stringify(evidence),
    });
    const verification = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(verification.error || `ClearLead returned HTTP ${response.status}.`);
    const evidenceLine = `${verification.httpStatus ? `HTTP ${verification.httpStatus} · ` : ""}${(verification.signals || []).join(" + ") || "no qualifying signals"}`;
    show(`${String(verification.status || "inconclusive").toUpperCase()} — ${verification.reason} ${evidenceLine}. Return to ClearLead; this evidence will appear there automatically.`, verification.status !== "live");
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
