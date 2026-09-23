const SERVER = "http://127.0.0.1:4173";
const pairing = document.querySelector("#pairing");
const ready = document.querySelector("#ready");
const result = document.querySelector("#result");
const runCard = document.querySelector("#run-card");
const noRun = document.querySelector("#no-run");
const pageCard = document.querySelector("#page-card");
const primaryActions = document.querySelector("#primary-actions");
let activeSession = null;
let activePack = null;

document.querySelector("#save-token").addEventListener("click", saveToken);
document.querySelector("#capture").addEventListener("click", captureCurrentPage);
document.querySelector("#bind").addEventListener("click", bindCurrentApplicationPage);
document.querySelector("#fill").addEventListener("click", fillCurrentPage);
document.querySelector("#attach").addEventListener("click", attachSelectedResume);
document.querySelector("#inspect").addEventListener("click", checkApplicationStatus);
document.querySelector("#open-application").addEventListener("click", openPreparedApplication);
document.querySelector("#refresh").addEventListener("click", refreshContext);
document.querySelector("#forget").addEventListener("click", forgetToken);

async function saveToken() {
  const token = document.querySelector("#token").value.trim();
  if (!token) return show("Paste the pairing token from ClearLead.", true);
  await chrome.storage.local.set({ clearleadToken: token });
  document.querySelector("#token").value = "";
  showReady(true);
  await refreshContext();
}

async function getSession() {
  const { clearleadToken } = await chrome.storage.local.get("clearleadToken");
  if (!clearleadToken) throw new Error("Pair the extension first.");
  const response = await fetch(`${SERVER}/api/extension/session`, { headers: { authorization: `Bearer ${clearleadToken}` } });
  const session = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error(session.error || "Pairing was rejected.");
  if (!response.ok) throw new Error(session.error || `ClearLead returned HTTP ${response.status}.`);
  activeSession = session;
  return { clearleadToken, session };
}

async function getPreparedPack(session) {
  if (!session?.capability) return null;
  const response = await fetch(`${SERVER}/api/extension/pack`, { headers: { authorization: `Bearer ${session.capability}` } });
  const pack = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(pack.error || `ClearLead returned HTTP ${response.status}.`);
  activePack = pack;
  return pack;
}

async function refreshContext() {
  const button = document.querySelector("#refresh");
  button.disabled = true;
  try {
    const { session } = await getSession();
    renderSession(session);
    if (!session.packReady) return show("Paired. Prepare a verified job in ClearLead to begin.");
    const pack = await getPreparedPack(session);
    const tab = await activeTab();
    if (!tab?.id || !/^https:\/\//i.test(String(tab.url || ""))) {
      return renderPageState(null, pack, "Open the prepared employer application to begin.");
    }
    let inspection;
    try { inspection = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_INSPECT_APPLICATION" }); }
    catch { return renderPageState(null, pack, "Reload the employer page after updating the extension, then refresh this panel."); }
    if (!inspection || inspection.inspectionError) return renderPageState(null, pack, inspection?.inspectionError || "Open the prepared employer application to begin.");
    renderPageState(inspection, pack);
  } catch (error) { show(error.message, true); }
  finally { button.disabled = false; }
}

function renderSession(session) {
  const hasRun = Boolean(session?.packReady && session.job);
  runCard.hidden = !hasRun;
  noRun.hidden = hasRun;
  pageCard.hidden = !hasRun;
  primaryActions.hidden = !hasRun;
  document.querySelector("#pair-status").textContent = hasRun ? "paired · application ready" : "paired locally";
  if (!hasRun) return;
  document.querySelector("#job-title").textContent = session.job.title || "Prepared application";
  document.querySelector("#job-company").textContent = [session.job.company, session.job.location].filter(Boolean).join(" · ");
  document.querySelector("#bind").hidden = session.handoff?.canBind !== true;
  setProgress("open");
}

function renderPageState(inspection, pack, guidance = "") {
  pageCard.hidden = false;
  const phase = inspection?.phase || "posting";
  const stepLabel = inspection?.stepLabel || (phase === "complete" ? "Application complete" : "Application not open yet");
  document.querySelector("#step-label").textContent = stepLabel;
  document.querySelector("#ats-family").textContent = String(inspection?.atsFamily || pack?.navigation?.atsFamily || "ATS").toUpperCase();
  const summary = document.querySelector("#field-summary");
  const attach = document.querySelector("#attach");
  attach.hidden = !(pack?.resume && Number(inspection?.fileFieldCount) > 0);
  if (inspection?.phase === "application") {
    const remaining = Number(inspection.emptyRequiredCount || 0);
    document.querySelector("#page-guidance").textContent = guidance || (remaining ? `${remaining} required field${remaining === 1 ? "" : "s"} still need attention on this step.` : inspection.submitControlCount ? "This step appears complete. Review everything before the final Submit click." : "Fill repeatable fields, resolve highlighted questions, then use the employer's Next or Continue button.");
    summary.hidden = false;
    summary.innerHTML = `<span><strong>${Number(inspection.fieldCount || 0)}</strong>fields</span><span><strong>${Number(inspection.emptyRequiredCount || 0)}</strong>required</span><span><strong>${Number(inspection.fileFieldCount || 0)}</strong>files</span><span><strong>${Number(inspection.nextControlCount || inspection.submitControlCount || 0)}</strong>${inspection.submitControlCount ? "submit" : "next"}</span>`;
    pageCard.className = `card page-card ${remaining ? "attention" : "ready"}`;
    setProgress(remaining ? "fill" : "review");
  } else {
    document.querySelector("#page-guidance").textContent = guidance || (phase === "complete" ? "Employer confirmation evidence is visible. Check the step to record completion." : "Open the employer's application form, then refresh this panel.");
    summary.hidden = true;
    pageCard.className = "card page-card";
    setProgress(phase === "complete" ? "review" : "open");
  }
}

function setProgress(stage) {
  const order = ["open", "fill", "review"];
  const activeIndex = Math.max(0, order.indexOf(stage));
  order.forEach((name, index) => {
    const node = document.querySelector(`#progress-${name}`);
    node.className = index < activeIndex ? "done" : index === activeIndex ? "active" : "";
    if (index < order.length - 1) node.nextElementSibling.className = index < activeIndex ? "done" : "";
  });
}

async function openPreparedApplication() {
  try {
    if (!activeSession?.job?.applicationUrl) await refreshContext();
    const url = activeSession?.job?.applicationUrl;
    if (!/^https:\/\//i.test(String(url || ""))) throw new Error("Prepare the verified application in ClearLead again.");
    await chrome.tabs.create({ url });
    show("Application opened. Keep this panel beside it and choose Fill this step.", false, true);
  } catch (error) { show(error.message, true); }
}

async function fillCurrentPage() {
  const button = document.querySelector("#fill");
  button.disabled = true;
  try {
    const { session } = await getSession();
    if (!session.capability) throw new Error(session.error || "Prepare a verified job in ClearLead before filling.");
    const pack = await getPreparedPack(session);
    const tab = await activeTab();
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
    renderPageState(afterFill || inspection, pack);
    const answerNote = report.savedAnswers ? ` ${report.savedAnswers} came from answers you previously confirmed.` : "";
    show(`${report.filled} repeatable field${report.filled === 1 ? "" : "s"} filled.${answerNote} ${report.review + report.blocked + report.manual} item${report.review + report.blocked + report.manual === 1 ? "" : "s"} need your attention. ${runMessage(recorded.run)} Nothing was submitted.`, recorded.run?.status === "needs_review", recorded.run?.status !== "needs_review");
  } catch (error) { show(error.message, true); }
  finally { button.disabled = false; }
}

async function attachSelectedResume() {
  const button = document.querySelector("#attach");
  button.disabled = true;
  try {
    const { session } = await getSession();
    if (!session.capability) throw new Error("Prepare a verified job in ClearLead before attaching a resume.");
    const pack = await getPreparedPack(session);
    if (!pack?.resume?.pdfUrl) throw new Error("Select a tailored resume in ClearLead before attaching it.");
    const resumeResponse = await fetch(new URL(pack.resume.pdfUrl, SERVER));
    if (!resumeResponse.ok) throw new Error("ClearLead could not load the selected resume. Prepare the application again.");
    const resumeBase64 = bytesToBase64(new Uint8Array(await resumeResponse.arrayBuffer()));
    const tab = await activeTab();
    if (!tab?.id) throw new Error("No active application tab is available.");
    const attachment = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_ATTACH_RESUME", pack, resume: { filename: pack.resume.filename, mimeType: "application/pdf", base64: resumeBase64 } });
    if (!attachment || attachment.attachmentError) throw new Error(attachment?.attachmentError || "Reload the application page and try again.");
    if (!attachment.attached) throw new Error(attachment.message || "No empty resume field was found on this step.");
    const inspection = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_INSPECT_APPLICATION" });
    renderPageState(inspection, pack);
    show(`Attached ${pack.resume.filename} to the resume field. Review the filename on the employer page before continuing. Nothing was submitted.`, false, true);
  } catch (error) { show(error.message, true); }
  finally { button.disabled = false; }
}

async function checkApplicationStatus() {
  const button = document.querySelector("#inspect");
  button.disabled = true;
  try {
    const { session } = await getSession();
    if (!session.capability) throw new Error(session.error || "Prepare a verified job in ClearLead before checking status.");
    const pack = await getPreparedPack(session);
    const tab = await activeTab();
    if (!tab?.id) throw new Error("No active application tab is available.");
    const inspection = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_INSPECT_APPLICATION" });
    if (!inspection || inspection.inspectionError) throw new Error(inspection?.inspectionError || "Reload the application page and try again.");
    const recorded = await reportApplicationRun(session.capability, pack.id, tab.url, inspection);
    renderPageState(inspection, pack);
    show(runMessage(recorded.run), recorded.run?.status === "needs_review", recorded.run?.status === "ready_for_final_approval" || recorded.run?.status === "complete");
  } catch (error) { show(error.message, true); }
  finally { button.disabled = false; }
}

async function bindCurrentApplicationPage() {
  const button = document.querySelector("#bind");
  button.disabled = true;
  try {
    const { clearleadToken, session } = await getSession();
    if (!session.runId) throw new Error(session.error || "Prepare a verified job in ClearLead before binding a page.");
    if (session.handoff?.bound) throw new Error("This run already has a bound employer application page.");
    const tab = await activeTab();
    if (!tab?.id || !/^https:\/\//i.test(String(tab.url || ""))) throw new Error("Open the public HTTPS employer application form first.");
    const inspection = await chrome.tabs.sendMessage(tab.id, { type: "CLEARLEAD_INSPECT_APPLICATION" });
    if (!inspection || inspection.inspectionError) throw new Error(inspection?.inspectionError || "Reload the application page and try again.");
    if (inspection.phase !== "application" || inspection.fieldCount < 1) throw new Error("Open the employer's application form—not only the posting—before binding.");
    if (!window.confirm(`Bind this application page to ${session.job.company} — ${session.job.title}? ClearLead will allow safe-field fill only for this evidenced job flow.`)) throw new Error("Application-page binding was canceled.");
    const response = await fetch(`${SERVER}/api/extension/transition`, {
      method: "POST",
      headers: { authorization: `Bearer ${clearleadToken}`, "content-type": "application/json" },
      body: JSON.stringify({ runId: session.runId, pageUrl: tab.url, pageTitle: inspection.pageTitle, identityText: inspection.identityText, referrer: inspection.referrer, inspection, userApproved: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `ClearLead returned HTTP ${response.status}.`);
    show(`${data.message} Nothing was filled or submitted.`, false, true);
    await refreshContext();
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
    const tab = await activeTab();
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
    show(`${String(verification.status || "inconclusive").toUpperCase()} — ${verification.reason} ${evidenceLine}. Return to ClearLead; this evidence will appear there automatically.`, verification.status !== "live", verification.status === "live");
  } catch (error) { show(error.message, true); }
  finally { button.disabled = false; }
}

async function activeTab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; }
function bytesToBase64(bytes) { let binary = ""; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary); }

async function forgetToken() {
  await chrome.storage.local.remove("clearleadToken");
  activeSession = null;
  activePack = null;
  showReady(false);
  show("Pairing removed from this browser.");
}

function showReady(isReady) { pairing.hidden = isReady; ready.hidden = !isReady; }
function show(message, error = false, success = false) { result.className = `active ${error ? "error" : success ? "success" : ""}`; result.textContent = message; }

chrome.storage.local.get("clearleadToken").then(({ clearleadToken }) => {
  showReady(Boolean(clearleadToken));
  if (clearleadToken) refreshContext();
});
