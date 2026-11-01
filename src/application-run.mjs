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
    decisionSnapshot: sanitizeDecisionSnapshot(pack.decisionSnapshot),
    allowedPages: [...new Set((pack.allowedPages || []).map(normalizePage).filter(Boolean))],
    navigation: sanitizeNavigation(pack.navigation),
    events: [{ type: "prepared", at: now }],
  };
}

export function recordApplicationRunReport(run, input, now = new Date().toISOString()) {
  if (!run || !STATUSES.has(run.status)) throw new Error("That application run is unavailable. Prepare the job again.");
  if (run.status === "complete") return run;
  const report = sanitizeApplicationReport(input);
  if (!sameAllowedApplication(run.allowedPages, run.navigation, report.pageUrl)) {
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

export function resumeApplicationRun(run, pack, now = new Date().toISOString()) {
  if (!run || !STATUSES.has(run.status)) throw new Error("That application run is unavailable. Prepare the job again.");
  if (run.status === "complete") throw new Error("That application is already complete and cannot be resumed.");
  const refreshed = createApplicationRun(pack);
  return {
    ...run,
    status: "in_progress",
    updatedAt: now,
    completedAt: null,
    job: refreshed.job,
    resume: refreshed.resume,
    truth: refreshed.truth,
    decisionSnapshot: refreshed.decisionSnapshot,
    allowedPages: refreshed.allowedPages,
    navigation: refreshed.navigation,
    events: [...(run.events || []), { type: "resumed", at: now }].slice(-100),
  };
}

export function bindApplicationRunTransition(run, pack, evidence = {}, now = new Date().toISOString()) {
  if (!run || !STATUSES.has(run.status) || run.status === "complete") throw new Error("That application run cannot bind another page.");
  const refreshed = createApplicationRun(pack);
  return {
    ...run,
    status: "in_progress",
    updatedAt: now,
    completedAt: null,
    job: refreshed.job,
    resume: refreshed.resume,
    truth: refreshed.truth,
    decisionSnapshot: refreshed.decisionSnapshot,
    allowedPages: refreshed.allowedPages,
    navigation: refreshed.navigation,
    events: [...(run.events || []), {
      type: "application_page_bound",
      at: now,
      atsFamily: shortToken(evidence.atsFamily || "generic", 40),
      pageUrl: normalizePage(evidence.pageUrl),
      evidence: shortToken(evidence.evidence || "user-approved", 60),
    }].slice(-100),
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
    stepKey: shortToken(inspection.stepKey || `${inspection.atsFamily || "generic"}-application`, 100),
    stepLabel: shortText(inspection.stepLabel || "Application", 100),
    fileFieldCount: count(inspection.fileFieldCount),
    submitControlCount: count(inspection.submitControlCount),
    nextControlCount: count(inspection.nextControlCount),
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
    decisionSnapshot: run.decisionSnapshot || null,
    lastEvent: run.events?.at(-1) || null,
  };
}

function statusFromReport(report) {
  if (report.phase === "complete" && report.completionSignals.length) return "complete";
  if (report.phase !== "application") return "in_progress";
  if (report.emptyRequiredCount === 0 && report.submitControlCount > 0) return "ready_for_final_approval";
  const outstanding = report.fill ? report.fill.review + report.fill.blocked + report.fill.manual : 0;
  if (report.emptyRequiredCount > 0 || outstanding > 0) return "needs_review";
  if (report.nextControlCount > 0) return "in_progress";
  if (report.fill) return "needs_review";
  return "in_progress";
}

function sameAllowedApplication(allowedPages, navigation, pageUrl) {
  if (!pageUrl) return false;
  let target;
  try { target = new URL(pageUrl); }
  catch { return false; }
  return (allowedPages || []).some((allowed) => {
    try {
      const prepared = new URL(allowed);
      return prepared.protocol === target.protocol && prepared.host === target.host && prepared.pathname === target.pathname && prepared.search === target.search;
    } catch { return false; }
  }) || allowedByNavigation(navigation, target);
}

function allowedByNavigation(scope, target) {
  if (!scope?.multiPage) return false;
  const sameOrigin = target.origin === scope.origin;
  const preparedHost = new URL(scope.origin).hostname;
  const familyHost = scope.allowedHostSuffix && hostMatches(preparedHost, scope.allowedHostSuffix) && hostMatches(target.hostname, scope.allowedHostSuffix);
  if (!sameOrigin && !familyHost) return false;
  if (navigationTokenMatches(scope.jobTokens, target)) return true;
  if (!sameOrigin || !scope.pathPrefix) return false;
  const hasQueryToken = scope.jobTokens.some((token) => token.includes("="));
  return !hasQueryToken && (target.pathname === scope.pathPrefix || target.pathname.startsWith(`${scope.pathPrefix}/`));
}

function sanitizeNavigation(value) {
  if (!value?.multiPage) return null;
  try {
    const origin = new URL(value.origin).origin;
    if (!origin.startsWith("https://")) return null;
    const allowedHostSuffix = String(value.allowedHostSuffix || "").toLowerCase();
    if (allowedHostSuffix && !["greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "smartrecruiters.com"].includes(allowedHostSuffix)) return null;
    return {
      multiPage: true,
      origin,
      pathPrefix: normalizedPath(value.pathPrefix),
      jobTokens: strings(value.jobTokens, 5, 100).map((token) => token.toLowerCase()),
      atsFamily: shortToken(value.atsFamily || "generic", 40),
      allowedHostSuffix,
    };
  } catch { return null; }
}

function compactJob(job = {}) {
  const result = Object.fromEntries(["title", "company", "location", "salary", "source", "url", "postingUrl", "resumeJobUrl", "finalUrl", "applicationUrl", "checkedAt", "reason"].map((key) => [key, String(job[key] || "").slice(0, ["url", "postingUrl", "resumeJobUrl", "finalUrl", "applicationUrl"].includes(key) ? 2_000 : 300)]));
  result.httpStatus = count(job.httpStatus);
  result.handoffBound = job.handoffBound === true;
  return result;
}

function compactResume(resume = {}) {
  return Object.fromEntries(["draftId", "kitId", "filename", "pdfUrl"].filter((key) => resume[key]).map((key) => [key, String(resume[key]).slice(0, 500)]));
}

function sanitizeDecisionSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const match = snapshot.match && typeof snapshot.match === "object" ? snapshot.match : {};
  const eligibility = match.eligibility && typeof match.eligibility === "object" ? match.eligibility : {};
  const qualifications = match.qualifications && typeof match.qualifications === "object" ? match.qualifications : {};
  return {
    scorerVersion: shortText(snapshot.scorerVersion || "clearlead-ranking/v1", 80),
    score: score(match.score),
    rawScore: score(match.rawScore),
    breakdown: Object.fromEntries(Object.entries(match.breakdown || {}).slice(0, 20).map(([key, value]) => [shortToken(key, 40), score(value)])),
    decision: match.decision ? { code: shortToken(match.decision.code, 40), label: shortText(match.decision.label, 100), reason: shortText(match.decision.reason, 300) } : null,
    eligibility: { eligible: eligibility.eligible === true, rejections: compactCodes(eligibility.rejections), warnings: compactCodes(eligibility.warnings) },
    qualifications: { counts: Object.fromEntries(Object.entries(qualifications.counts || {}).slice(0, 10).map(([key, value]) => [shortToken(key, 40), count(value)])) },
    descriptionHash: /^[a-f0-9]{64}$/i.test(String(snapshot.descriptionHash || "")) ? String(snapshot.descriptionHash).toLowerCase() : "",
    capturedAt: validDate(snapshot.capturedAt),
  };
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
function shortText(value, limit) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit); }
function normalizedPath(value) { const path = String(value || "/").replace(/\/{2,}/g, "/"); return path.length > 1 ? path.replace(/\/+$/, "") : "/"; }
function count(value) { return Math.max(0, Math.min(10_000, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0)); }
function score(value) { return Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0)); }
function strings(values, limit, length) { return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, length)).filter(Boolean))].slice(0, limit); }
function compactCodes(values) { return (Array.isArray(values) ? values : []).map((item) => ({ code: shortToken(item?.code || item, 60), reason: shortText(item?.reason || "", 240) })).filter((item) => item.code).slice(0, 30); }
function validDate(value) { const time = Date.parse(value || ""); return Number.isFinite(time) ? new Date(time).toISOString() : ""; }
function hostMatches(hostname, suffix) { return hostname === suffix || hostname.endsWith(`.${suffix}`); }
function navigationTokenMatches(tokens, target) {
  const pathSegments = target.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part).toLowerCase());
  return (tokens || []).some((token) => {
    const normalized = String(token || "").toLowerCase();
    if (!normalized.includes("=")) return normalized && pathSegments.includes(normalized);
    const separator = normalized.indexOf("=");
    return target.searchParams.get(normalized.slice(0, separator))?.toLowerCase() === normalized.slice(separator + 1);
  });
}
