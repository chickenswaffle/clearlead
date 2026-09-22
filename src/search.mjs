import { rankJob, dedupeJobs } from "./ranking.mjs";
import { DEFAULT_SOURCE_CONFIG } from "./sources.mjs";

export const DEFAULT_SOURCES = DEFAULT_SOURCE_CONFIG.greenhouseBoards.map((board) => ({ board, name: humanize(board) }));
const REFRESH_OPTIONS = new Set([2, 5, 15, 30]);
const VERIFY_OPTIONS = new Set([0, 5, 8, 12, 20]);

export function normalizeSearchConfig(input = {}) {
  const legacyBoards = input.greenhouseBoards ?? input.boards;
  const greenhouseBoards = tokens(legacyBoards, DEFAULT_SOURCE_CONFIG.greenhouseBoards, 20);
  return {
    greenhouseBoards,
    boards: greenhouseBoards,
    leverSites: tokens(input.leverSites, DEFAULT_SOURCE_CONFIG.leverSites, 12),
    ashbyBoards: tokens(input.ashbyBoards, DEFAULT_SOURCE_CONFIG.ashbyBoards, 12),
    broadFeeds: allowedFeeds(input.broadFeeds),
    smartPrompt: String(input.smartPrompt || "").trim().slice(0, 500),
    query: String(input.query || "").trim().slice(0, 800),
    location: String(input.location || "").trim().slice(0, 800),
    autoRefresh: input.autoRefresh !== false,
    refreshMinutes: REFRESH_OPTIONS.has(Number(input.refreshMinutes)) ? Number(input.refreshMinutes) : 5,
    autoVerify: input.autoVerify !== false,
    verifyLimit: VERIFY_OPTIONS.has(Number(input.verifyLimit)) ? Number(input.verifyLimit) : 8,
  };
}

export function sourceSpecs(config) {
  return [
    ...config.greenhouseBoards.map((token) => ({ type: "greenhouse", token, name: humanize(token) })),
    ...config.leverSites.map((token) => ({ type: "lever", token, name: humanize(token) })),
    ...config.ashbyBoards.map((token) => ({ type: "ashby", token, name: humanize(token) })),
    ...config.broadFeeds.map((type) => ({
      type,
      token: type === "remotive" ? "remote" : type === "arbeitnow" ? "europe" : type === "ziprecruiter" ? "public-mcp" : "employer-direct",
      name: type === "remotive" ? "Remotive" : type === "arbeitnow" ? "Arbeitnow" : type === "ziprecruiter" ? "ZipRecruiter" : "Employer-direct index",
    })),
  ];
}

export async function searchPublishedRoles(input, {
  discoverSourceFn,
  discoverFn,
  profile = {},
  resume = {},
  applicationProfile = {},
  now = () => new Date(),
} = {}) {
  const config = normalizeSearchConfig(input);
  const specs = discoverSourceFn
    ? sourceSpecs(config)
    : config.greenhouseBoards.map((token) => ({ type: "greenhouse", token, name: humanize(token) }));
  if (!discoverSourceFn && typeof discoverFn !== "function") throw new Error("A discovery adapter is required.");
  const outcomes = await Promise.all(specs.map(async (spec) => {
    let result;
    try {
      result = discoverSourceFn
        ? await discoverSourceFn(spec, { limit: 500, plan: input.plan })
        : await discoverFn(spec.token, { limit: 500 });
    } catch {
      result = { jobs: [], error: `${spec.name} adapter failed unexpectedly. Retry or remove this source.` };
    }
    return {
      id: `${spec.type}:${spec.token}`,
      type: spec.type,
      board: spec.token,
      name: spec.name,
      ok: !result.error,
      cached: Boolean(result.cached),
      note: result.note || "",
      error: result.error,
      jobs: result.jobs || [],
    };
  }));

  const queryGroups = config.query.split(",").map(words).filter((group) => group.length > 0);
  const locationGroups = config.location.split(",").map(words).filter((group) => group.length > 0);
  const candidates = [];
  const rejected = [];
  const funnel = {
    discovered: outcomes.reduce((total, source) => total + source.jobs.length, 0),
    missingUrl: 0,
    titleMismatch: 0,
    locationMismatch: 0,
    hardRejected: 0,
    eligibleBeforeDedupe: 0,
    duplicatesRemoved: 0,
  };
  for (const source of outcomes) {
    for (const job of source.jobs) {
      if (!job.url) { funnel.missingUrl += 1; continue; }
      const titleTerms = new Set(words(job.title));
      if (queryGroups.length > 0) {
        const titleMatches = input.plan
          ? smartTitleMatches(job.title, input.plan)
          : queryGroups.some((group) => group.every((term) => titleTerms.has(term)));
        if (!titleMatches) { funnel.titleMismatch += 1; continue; }
      }
      const locationText = new Set(words(job.location));
      const remoteAllowed = input.plan?.remote && /\bremote\b/i.test(String(job.location) + " " + String(job.workplaceType));
      const locationMatches = locationGroups.some((group) => group.every((term) => locationText.has(term)));
      const hardLocationFilter = !input.plan || input.plan.locationRequired === true;
      if (locationGroups.length > 0 && hardLocationFilter && !remoteAllowed && !locationMatches) { funnel.locationMismatch += 1; continue; }
      const normalized = {
        ...job,
        company: job.company || source.name,
        source: job.source || source.type,
        board: job.board || source.board,
        verificationStatus: "unverified",
      };
      normalized.match = rankJob(normalized, { resume, profile, applicationProfile, query: config.query, location: config.location, plan: input.plan, now: now() });
      normalized.relevance = { score: normalized.match.score, matched: normalized.match.matchedSkills };
      if (!normalized.match.eligibility.eligible) {
        rejected.push(normalized);
        funnel.hardRejected += 1;
        continue;
      }
      candidates.push(normalized);
    }
  }

  const matchedJobs = dedupeJobs(candidates).sort((a, b) => {
    const decision = decisionPriority(a.match?.decision?.code) - decisionPriority(b.match?.decision?.code);
    if (decision !== 0) return decision;
    const score = (b.match?.score || 0) - (a.match?.score || 0);
    if (score !== 0) return score;
    return timestamp(b.postedAt) - timestamp(a.postedAt);
  });
  funnel.eligibleBeforeDedupe = candidates.length;
  funnel.duplicatesRemoved = candidates.length - matchedJobs.length;
  const actionableJobs = matchedJobs.filter((job) => job.match?.decision?.code !== "skip");
  funnel.fitSkipped = matchedJobs.length - actionableJobs.length;
  const jobs = actionableJobs.slice(0, 150);
  const outage = outcomes.length > 0 && outcomes.every((source) => !source.ok);

  return {
    config,
    jobs,
    allJobs: matchedJobs,
    matchedCount: actionableJobs.length,
    rejectedCount: rejected.length,
    rejectionReasons: rejectionSummary(rejected),
    funnel,
    outage,
    sources: outcomes.map(({ jobs: sourceJobs, ...source }) => ({ ...source, count: sourceJobs.length })),
    providerAccess: providerAccess(config),
    searchedAt: now().toISOString(),
  };
}

function rejectionSummary(jobs) {
  const counts = new Map();
  for (const job of jobs) {
    for (const item of job.match?.eligibility?.reasons || []) counts.set(item.code, (counts.get(item.code) || 0) + 1);
  }
  return [...counts.entries()].map(([code, count]) => ({ code, count })).sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

function tokens(value, fallback, limit) {
  const supplied = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : fallback;
  return [...new Set(supplied.map((item) => String(item).trim().toLowerCase()).filter((item) => /^[a-z0-9_-]{2,80}$/.test(item)))].slice(0, limit);
}
function allowedFeeds(value) {
  const supplied = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : DEFAULT_SOURCE_CONFIG.broadFeeds;
  return [...new Set(supplied.map((item) => String(item).trim().toLowerCase()).filter((item) => ["jobledger", "ziprecruiter", "remotive", "arbeitnow"].includes(item)))];
}
function providerAccess(config) {
  const enabled = new Set(config.broadFeeds);
  return [
    { id: "ziprecruiter", name: "ZipRecruiter", status: enabled.has("ziprecruiter") ? "enabled" : "available", detail: "Official public MCP · small result pages · no sign-in" },
    { id: "indeed", name: "Indeed", status: "partner-required", detail: "Official search access requires publisher-partner approval and an HTTPS placement" },
    { id: "glassdoor", name: "Glassdoor", status: "partner-required", detail: "Official API access is restricted to approved integrations" },
  ];
}
function words(value) { return String(value).toLowerCase().match(/[a-z0-9+#.]{2,}/g) || []; }
function smartTitleMatches(title, plan) {
  const plannedTitles = plan.titles || [];
  const normalizedTitle = normalizedTitleWords(title);
  if (plannedTitles.some((planned) => {
    const normalizedPlanned = normalizedTitleWords(planned);
    return normalizedPlanned === normalizedTitle || normalizedTitle.includes(normalizedPlanned) || normalizedPlanned.includes(normalizedTitle);
  })) return true;
  const titleWords = new Set(words(title));
  const plannedWords = new Set(plannedTitles.flatMap(words));
  const supportPlan = [...plannedWords].some((word) => ["support", "help", "desk", "desktop", "computer"].includes(word));
  if (supportPlan) {
    const text = String(title).toLowerCase();
    if (plan.seniority === "entry" && /\b(?:senior|sr\.?|staff|principal|lead|manager|director|head|chief|vp)\b/i.test(text)) return false;
    const supportPhrase = /\b(?:help\s*desk|service\s*desk|desktop support|(?:technical|tech|technology|it|information technology|computer|network|systems?|user|end user|field|application)(?: customer| product| client)? support)\b/i.test(text);
    const supportRole = /\bsupport\s+(?:technician|specialist|analyst|associate|representative|administrator|admin|engineer|consultant)\b/i.test(text);
    const endpointRole = /\b(?:it|information technology|desktop|computer|end user computing|euc)\s+(?:support\s+)?(?:technician|specialist|analyst|associate|administrator|admin|engineer)\b/i.test(text);
    return supportPhrase || supportRole || endpointRole;
  }
  const generic = new Set(["senior", "junior", "entry", "staff", "lead", "manager", "engineer", "developer", "analyst", "specialist", "technician", "associate"]);
  const distinctiveOverlap = [...plannedWords].filter((word) => !generic.has(word) && titleWords.has(word)).length;
  const genericOverlap = [...plannedWords].filter((word) => generic.has(word) && titleWords.has(word)).length;
  return distinctiveOverlap >= 2 || (distinctiveOverlap >= 1 && genericOverlap >= 1);
}
function normalizedTitleWords(value) {
  return words(value).map((word) => ({ pc: "computer", bi: "business-intelligence", service: "support" })[word] || word).filter((word) => !["junior", "entry", "level"].includes(word)).join("-");
}
function timestamp(value) { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? parsed : 0; }
function decisionPriority(value) { return value === "apply" ? 0 : value === "review" ? 1 : 2; }
function humanize(value) { return String(value).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
