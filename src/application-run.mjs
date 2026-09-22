const STATUSES = new Set(["prepared", "in_progress", "needs_review", "ready_for_final_approval", "complete"]);

export function createApplicationRun(pack) {
  const now = new Date().toISOString();
  return {
    id: pack.id,
    status: "prepared",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    job: compactJob(pack.job),
    resume: pack.resume ? compactResume(pack.resume) : null,
    truth: pack.truth ? { schema: String(pack.truth.schema || ""), fingerprint: String(pack.truth.fingerprint || "") } : null,
    allowedPages: [...new Set((pack.allowedPages || []).map(normalizePage).filter(Boolean))],
    events: [{ type: "prepared", at: now }],
  };
}

export function recordApplicationRunReport(run, input, now = new Date().toISOString()) {
  if (!run || !STATUSES.has(run.status)) throw new Error("That application run is unavailable. Prepare the job again.");
  if (run.status === "complete") return run;
  const report = sanitizeApplicationReport(input);
  if (!sameAllowedApplication(run.allowedPages, report.pageUrl)) {
    throw new Error("This application page does not belong to the prepared job.");
  }
  const status = statusFromReport(report);
  const event = { type: "page_report", at: now, status, ...report };
  const events = [...(run.events || []), event].slice(-100);
  return {
    ...run,
    status,
    updatedAt: now,
    completedAt: status === "complete" ? now : null,
    events,
  };
}

export function sanitizeApplicationReport(input = {}) {
  const inspection = input.inspection && typeof input.inspection === "object" ? input.inspection : {};
  const fill = input.fill && typeof input.fill === "object" ? input.fill : null;
  const phase = ["posting", "application", "complete"].includes(inspection.phase) ? inspection.phase : "posting";
  const completionSignals = strings(inspection.completionSignals, 5, 80);
  return {
    pageUrl: normalizePage(input.pageUrl),
    atsFamily: shortToken(inspection.atsFamily || "generic", 40),
    phase,
    fieldCount: count(inspection.fieldCount),
    requiredCount: count(inspection.requiredCount),
    emptyRequiredCount: count(inspection.emptyRequiredCount),
    fileFieldCount: count(inspection.fileFieldCount),
    submitControlCount: count(inspection.submitControlCount),
    completionSignals,
    fill: fill ? {
      filled: count(fill.filled),
      review: count(fill.review),
      blocked: count(fill.blocked),
      manual: count(fill.manual),
    } : null,
  };
}

export function publicApplicationRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    job: run.job,
    resume: run.resume,
    truth: run.truth,
    lastEvent: run.events?.at(-1) || null,
  };
}

function statusFromReport(report) {
  if (report.phase === "complete" && report.completionSignals.length) return "complete";
  if (report.phase !== "application") return "in_progress";
  if (report.emptyRequiredCount === 0 && report.submitControlCount > 0) return "ready_for_final_approval";
  if (report.fill || report.emptyRequiredCount > 0) return "needs_review";
  return "in_progress";
}

function sameAllowedApplication(allowedPages, pageUrl) {
  if (!pageUrl) return false;
  let target;
  try { target = new URL(pageUrl); }
  catch { return false; }
  return (allowedPages || []).some((allowed) => {
    try {
      const prepared = new URL(allowed);
      return prepared.protocol === target.protocol && prepared.host === target.host && prepared.pathname === target.pathname && prepared.search === target.search;
    } catch { return false; }
  });
}

function compactJob(job = {}) {
  return Object.fromEntries(["title", "company", "location", "source", "applicationUrl"].map((key) => [key, String(job[key] || "").slice(0, key === "applicationUrl" ? 2_000 : 180)]));
}

function compactResume(resume = {}) {
  return Object.fromEntries(["draftId", "kitId", "filename", "pdfUrl"].filter((key) => resume[key]).map((key) => [key, String(resume[key]).slice(0, 500)]));
}

function normalizePage(value) {
  try {
    const page = new URL(String(value || ""));
    if (page.protocol !== "https:") return "";
    page.hash = "";
    return page.toString();
  } catch { return ""; }
}

function shortToken(value, limit) { return String(value || "").replace(/[^a-z0-9_-]/gi, "").slice(0, limit) || "generic"; }
function count(value) { return Math.max(0, Math.min(10_000, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0)); }
function strings(values, limit, length) { return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, length)).filter(Boolean))].slice(0, limit); }
