import { createHash, randomUUID } from "node:crypto";

const OUTCOME_STAGES = new Set(["applied", "recruiter_contact", "screening", "assessment", "interview", "final_interview", "offer", "hired", "rejected", "withdrawn", "offer_declined", "no_response"]);
const REASONS = new Set(["unknown", "experience", "skills", "role_fit", "location", "compensation", "authorization", "resume", "assessment", "interview", "timing", "position_closed", "internal_candidate", "other"]);
const REACHED_STAGES = new Set(["application", "screening", "interview", "final_interview", "offer"]);
const REACHED_WEIGHT = { application: 0, screening: 1, interview: 2, final_interview: 3, offer: 4 };

export function normalizeOutcomeState(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    schema: "clearlead-outcomes/v1",
    settings: { rankingEnabled: input.settings?.rankingEnabled !== false },
    applications: (Array.isArray(input.applications) ? input.applications : []).map(normalizeApplication).filter(Boolean).slice(0, 2_000),
  };
}

export function applicationFromRun(run) {
  if (!run?.id || run.status !== "complete" || !run.completedAt) return null;
  return normalizeApplication({
    id: run.id,
    runId: run.id,
    job: run.job,
    resume: run.resume,
    appliedAt: run.completedAt,
    createdAt: run.completedAt,
    updatedAt: run.completedAt,
    evidence: "employer_completion",
    fingerprint: applicationFingerprint(run.job, run.completedAt),
    decisionSnapshot: run.decisionSnapshot,
    currentStage: "applied",
    stageReached: "application",
    events: [{ id: randomUUID(), type: "applied", at: run.completedAt, source: "employer_page", note: "Application completion was detected on the employer page." }],
  });
}

export function createManualApplication(input = {}, now = new Date().toISOString()) {
  const job = compactJob(input.job || input);
  if (!job.title || !job.company) throw new Error("Add the job title and company before recording an application.");
  const appliedAt = validDate(input.appliedAt) || now;
  return normalizeApplication({
    id: randomUUID(),
    leadId: token(input.leadId, 100),
    job,
    resume: input.resume,
    appliedAt,
    createdAt: now,
    updatedAt: now,
    evidence: input.leadId ? "user_confirmed_lead" : "user_confirmed_history",
    fingerprint: applicationFingerprint(job, appliedAt),
    decisionSnapshot: input.decisionSnapshot,
    currentStage: "applied",
    stageReached: "application",
    events: [{ id: randomUUID(), type: "applied", at: appliedAt, source: "user", note: shortText(input.note, 1_000) }],
  });
}

export function recordApplicationOutcome(application, input = {}, now = new Date().toISOString()) {
  const stage = String(input.stage || "");
  if (!OUTCOME_STAGES.has(stage)) throw new Error("Choose a valid application result.");
  const reason = REASONS.has(input.reason) ? input.reason : "unknown";
  let stageReached = REACHED_STAGES.has(input.stageReached) ? input.stageReached : defaultReachedStage(stage);
  if (["offer", "hired", "offer_declined"].includes(stage)) stageReached = "offer";
  if (["interview", "final_interview"].includes(stage) && REACHED_WEIGHT[stageReached] < REACHED_WEIGHT.interview) stageReached = stage === "final_interview" ? "final_interview" : "interview";
  if (["recruiter_contact", "screening", "assessment"].includes(stage) && REACHED_WEIGHT[stageReached] < REACHED_WEIGHT.screening) stageReached = "screening";
  const at = validDate(input.at) || now;
  const event = {
    id: randomUUID(),
    type: stage,
    at,
    source: "user",
    stageReached,
    reason,
    note: shortText(input.note, 1_000),
  };
  return normalizeApplication({
    ...application,
    currentStage: stage,
    stageReached: furthestStage(application.stageReached, stageReached),
    outcomeReason: reason,
    updatedAt: now,
    events: [...(application.events || []), event].slice(-100),
  });
}

export function buildOutcomeLearning(applications = [], settings = {}) {
  const normalized = applications.map(normalizeApplication).filter(Boolean);
  const updated = normalized.filter((application) => application.events.some((event) => event.source === "user" && event.type !== "applied"));
  const rated = updated.filter((application) => !["no_response", "withdrawn"].includes(application.currentStage));
  const responses = rated.filter(responded).length;
  const interviews = rated.filter(interviewed).length;
  const offers = rated.filter((application) => ["offer", "hired", "offer_declined"].includes(application.currentStage) || application.stageReached === "offer").length;
  const rankingEnabled = settings.rankingEnabled !== false;
  const outcomeClasses = new Set(rated.map((application) => responded(application) ? "advanced" : "early_stop")).size;
  const active = rankingEnabled && rated.length >= 20 && responses >= 5 && outcomeClasses >= 2;
  const baseline = (responses + 2) / (rated.length + 4);
  const featureStats = new Map();
  for (const application of rated) {
    for (const feature of applicationFeatures(application.job)) {
      const current = featureStats.get(feature.key) || { ...feature, samples: 0, responses: 0, interviews: 0, offers: 0 };
      current.samples += 1;
      current.responses += responded(application) ? 1 : 0;
      current.interviews += interviewed(application) ? 1 : 0;
      current.offers += ["offer", "hired", "offer_declined"].includes(application.currentStage) || application.stageReached === "offer" ? 1 : 0;
      featureStats.set(feature.key, current);
    }
  }
  const signals = [...featureStats.values()].map((signal) => {
    const smoothedResponseRate = (signal.responses + 2) / (signal.samples + 4);
    const adjustment = clamp(Math.round((smoothedResponseRate - baseline) * 12), -4, 4);
    return {
      ...signal,
      responseRate: signal.samples ? signal.responses / signal.samples : 0,
      interviewRate: signal.samples ? signal.interviews / signal.samples : 0,
      adjustment,
      active: active && signal.samples >= 2 && adjustment !== 0,
    };
  }).sort((left, right) => right.samples - left.samples || Math.abs(right.adjustment) - Math.abs(left.adjustment) || left.label.localeCompare(right.label));
  return {
    mode: active ? "active" : rankingEnabled ? "observing" : "paused",
    rankingEnabled,
    minimumSamples: 20,
    minimumResponses: 5,
    outcomeClasses,
    sampleSize: rated.length,
    totalApplications: normalized.length,
    responses,
    interviews,
    offers,
    responseRate: rated.length ? responses / rated.length : 0,
    signals: signals.slice(0, 12),
    privacy: "Outcome memory is computed locally. No application history is sent to an AI provider.",
  };
}

export function applyOutcomeLearning(job, learning) {
  if (!job?.match || learning?.mode !== "active") return job;
  const keys = new Set(applicationFeatures(job).map((feature) => feature.key));
  const matched = (learning.signals || []).filter((signal) => signal.active && keys.has(signal.key));
  if (!matched.length) return job;
  const adjustment = clamp(matched.reduce((total, signal) => total + signal.adjustment, 0), -6, 6);
  if (!adjustment) return job;
  const baseScore = Number(job.match.score || 0);
  return {
    ...job,
    match: {
      ...job.match,
      score: clamp(baseScore + adjustment, 0, 100),
      outcomeLearning: {
        adjustment,
        baseScore,
        evidence: matched.map((signal) => `${signal.label} (${signal.samples})`).slice(0, 3),
        explanation: `Local outcome memory adjusted this rank by ${adjustment > 0 ? "+" : ""}${adjustment} points. Eligibility and qualification gates were not changed.`,
      },
    },
  };
}

function normalizeApplication(value) {
  if (!value?.id) return null;
  const currentStage = OUTCOME_STAGES.has(value.currentStage) ? value.currentStage : "applied";
  const stageReached = REACHED_STAGES.has(value.stageReached) ? value.stageReached : defaultReachedStage(currentStage);
  const job = compactJob(value.job);
  return {
    id: token(value.id, 100),
    runId: token(value.runId, 100),
    leadId: token(value.leadId, 100),
    job,
    resume: compactResume(value.resume),
    appliedAt: validDate(value.appliedAt) || validDate(value.createdAt) || new Date().toISOString(),
    createdAt: validDate(value.createdAt) || new Date().toISOString(),
    updatedAt: validDate(value.updatedAt) || validDate(value.createdAt) || new Date().toISOString(),
    evidence: ["employer_completion", "user_confirmed_lead", "user_confirmed_history"].includes(value.evidence) ? value.evidence : "user_confirmed_history",
    fingerprint: token(value.fingerprint, 64) || applicationFingerprint(job, value.appliedAt || value.createdAt),
    decisionSnapshot: compactDecisionSnapshot(value.decisionSnapshot),
    currentStage,
    stageReached,
    outcomeReason: REASONS.has(value.outcomeReason) ? value.outcomeReason : "unknown",
    events: (Array.isArray(value.events) ? value.events : []).map(compactEvent).filter(Boolean).slice(-100),
  };
}

function compactJob(job = {}) {
  return {
    title: shortText(job.title, 180),
    company: shortText(job.company, 120),
    location: shortText(job.location, 160),
    source: shortText(job.source, 60),
    url: safeHttpUrl(job.applicationUrl || job.finalUrl || job.url),
  };
}

function compactResume(resume = {}) {
  if (!resume || typeof resume !== "object") return null;
  const result = Object.fromEntries(["draftId", "kitId", "filename"].filter((key) => resume[key]).map((key) => [key, shortText(resume[key], 300)]));
  return Object.keys(result).length ? result : null;
}

function compactDecisionSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const result = {
    scorerVersion: shortText(snapshot.scorerVersion, 80),
    score: finiteScore(snapshot.score),
    rawScore: finiteScore(snapshot.rawScore),
    breakdown: Object.fromEntries(Object.entries(snapshot.breakdown || {}).slice(0, 20).map(([key, value]) => [token(key, 40), finiteScore(value)])),
    decision: snapshot.decision && typeof snapshot.decision === "object" ? { code: token(snapshot.decision.code, 40), label: shortText(snapshot.decision.label, 100), reason: shortText(snapshot.decision.reason, 300) } : null,
    eligibility: snapshot.eligibility && typeof snapshot.eligibility === "object" ? { eligible: snapshot.eligibility.eligible === true, codes: [...new Set([...(snapshot.eligibility.rejections || []), ...(snapshot.eligibility.warnings || [])].map((item) => token(item?.code || item, 60)).filter(Boolean))].slice(0, 30) } : null,
    qualifications: snapshot.qualifications && typeof snapshot.qualifications === "object" ? { counts: Object.fromEntries(Object.entries(snapshot.qualifications.counts || {}).slice(0, 10).map(([key, value]) => [token(key, 40), Math.max(0, Math.min(10_000, Number(value) || 0))])) } : null,
    descriptionHash: token(snapshot.descriptionHash, 64),
    capturedAt: validDate(snapshot.capturedAt),
  };
  return result.scorerVersion || result.descriptionHash || result.score ? result : null;
}

function compactEvent(event) {
  if (!event || !OUTCOME_STAGES.has(event.type) || !validDate(event.at)) return null;
  return {
    id: token(event.id, 100) || randomUUID(),
    type: event.type,
    at: validDate(event.at),
    source: event.source === "employer_page" ? "employer_page" : "user",
    stageReached: REACHED_STAGES.has(event.stageReached) ? event.stageReached : defaultReachedStage(event.type),
    reason: REASONS.has(event.reason) ? event.reason : "unknown",
    note: shortText(event.note, 1_000),
  };
}

function applicationFeatures(job = {}) {
  const features = [];
  const title = titleFamily(job.title);
  if (title) features.push({ key: `title:${title}`, kind: "title", label: `role · ${title}` });
  const source = String(job.source || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  if (source) features.push({ key: `source:${source}`, kind: "source", label: `source · ${source}` });
  const arrangement = /\bremote\b/i.test(job.location || "") ? "remote" : /\bhybrid\b/i.test(job.location || "") ? "hybrid" : job.location ? "onsite-or-local" : "";
  if (arrangement) features.push({ key: `arrangement:${arrangement}`, kind: "arrangement", label: `work · ${arrangement}` });
  return features;
}

function titleFamily(value) {
  const ignored = new Set(["junior", "jr", "senior", "sr", "staff", "lead", "principal", "associate", "i", "ii", "iii", "iv"]);
  return (String(value || "").toLowerCase().match(/[a-z0-9+#]{2,}/g) || []).filter((part) => !ignored.has(part)).slice(0, 5).join(" ");
}

function responded(application) { return REACHED_WEIGHT[application.stageReached] >= REACHED_WEIGHT.screening || ["recruiter_contact", "screening", "assessment", "interview", "final_interview", "offer", "hired", "offer_declined"].includes(application.currentStage); }
function interviewed(application) { return REACHED_WEIGHT[application.stageReached] >= REACHED_WEIGHT.interview || ["interview", "final_interview", "offer", "hired", "offer_declined"].includes(application.currentStage); }
function defaultReachedStage(stage) { return ["offer", "hired", "offer_declined"].includes(stage) ? "offer" : stage === "final_interview" ? "final_interview" : stage === "interview" ? "interview" : ["recruiter_contact", "screening", "assessment"].includes(stage) ? "screening" : "application"; }
function furthestStage(left, right) { return (REACHED_WEIGHT[right] || 0) > (REACHED_WEIGHT[left] || 0) ? right : REACHED_STAGES.has(left) ? left : right; }
function validDate(value) { const time = Date.parse(value || ""); return Number.isFinite(time) ? new Date(time).toISOString() : ""; }
function token(value, limit) { return String(value || "").replace(/[^a-z0-9_.:-]/gi, "").slice(0, limit); }
function shortText(value, limit) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit); }
function safeHttpUrl(value) { try { const url = new URL(String(value || "")); return /^https?:$/.test(url.protocol) ? url.toString() : ""; } catch { return ""; } }
function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function finiteScore(value) { return Number.isFinite(Number(value)) ? clamp(Math.round(Number(value)), 0, 100) : 0; }

export function applicationFingerprint(job = {}, appliedAt = "") {
  const day = validDate(appliedAt).slice(0, 10);
  const identity = [safeHttpUrl(job.applicationUrl || job.finalUrl || job.url).replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase(), shortText(job.company, 120).toLowerCase(), titleFamily(job.title), day].join("|");
  return createHash("sha256").update(identity).digest("hex");
}
