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
      token: type === "remotive" ? "remote" : type === "arbeitnow" ? "europe" : "employer-direct",
      name: type === "remotive" ? "Remotive" : type === "arbeitnow" ? "Arbeitnow" : "Public Job Ledger",
    })),
  ];
}

export async function searchPublishedRoles(input, {
  discoverSourceFn,
  discoverFn,
  profile = {},
  resume = {},
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
      error: result.error,
      jobs: result.jobs || [],
    };
  }));

  const queryGroups = config.query.split(",").map(words).filter((group) => group.length > 0);
  const locationGroups = config.location.split(",").map(words).filter((group) => group.length > 0);
  const candidates = [];
  for (const source of outcomes) {
    for (const job of source.jobs) {
      if (!job.url) continue;
      const titleTerms = new Set(words(job.title));
      if (queryGroups.length > 0) {
        const titleMatches = input.plan
          ? smartTitleMatches(job.title, input.plan.titles || [])
          : queryGroups.some((group) => group.every((term) => titleTerms.has(term)));
        if (!titleMatches) continue;
      }
      const locationText = new Set(words(job.location));
      const remoteAllowed = input.plan?.remote && /\bremote\b/i.test(String(job.location) + " " + String(job.workplaceType));
      if (!input.plan && locationGroups.length > 0 && !remoteAllowed && !locationGroups.some((group) => group.every((term) => locationText.has(term)))) continue;
      const normalized = {
        ...job,
        company: job.company || source.name,
        source: job.source || source.type,
        board: job.board || source.board,
        verificationStatus: "unverified",
      };
      normalized.match = rankJob(normalized, { resume, profile, query: config.query, location: config.location, plan: input.plan, now: now() });
      normalized.relevance = { score: normalized.match.score, matched: normalized.match.matchedSkills };
      candidates.push(normalized);
    }
  }

  const matchedJobs = dedupeJobs(candidates).sort((a, b) => {
    const score = (b.match?.score || 0) - (a.match?.score || 0);
    if (score !== 0) return score;
    return timestamp(b.postedAt) - timestamp(a.postedAt);
  });
  const jobs = matchedJobs.slice(0, 150);
  const outage = outcomes.length > 0 && outcomes.every((source) => !source.ok);

  return {
    config,
    jobs,
    allJobs: matchedJobs,
    matchedCount: matchedJobs.length,
    outage,
    sources: outcomes.map(({ jobs: sourceJobs, ...source }) => ({ ...source, count: sourceJobs.length })),
    searchedAt: now().toISOString(),
  };
}

function tokens(value, fallback, limit) {
  const supplied = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : fallback;
  return [...new Set(supplied.map((item) => String(item).trim().toLowerCase()).filter((item) => /^[a-z0-9_-]{2,80}$/.test(item)))].slice(0, limit);
}
function allowedFeeds(value) {
  const supplied = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : DEFAULT_SOURCE_CONFIG.broadFeeds;
  return [...new Set(supplied.map((item) => String(item).trim().toLowerCase()).filter((item) => ["jobledger", "remotive", "arbeitnow"].includes(item)))];
}
function words(value) { return String(value).toLowerCase().match(/[a-z0-9+#.]{2,}/g) || []; }
function smartTitleMatches(title, plannedTitles) {
  const titleWords = new Set(words(title));
  const plannedWords = new Set(plannedTitles.flatMap(words));
  const supportPlan = [...plannedWords].some((word) => ["support", "help", "desk", "desktop", "computer"].includes(word));
  if (supportPlan) {
    const text = String(title).toLowerCase();
    const domain = /\b(it|information technology|technology|technical|tech|help desk|service desk|desktop|computer|network|systems?|end user|user support|computing)\b/i.test(text);
    const role = /\b(support|technician|specialist|analyst|associate|representative|administrator|admin|engineer)\b/i.test(text);
    if (domain && role) return true;
  }
  const generic = new Set(["senior", "junior", "entry", "staff", "lead", "manager", "engineer", "developer", "analyst", "specialist", "technician", "associate"]);
  const distinctiveOverlap = [...plannedWords].filter((word) => !generic.has(word) && titleWords.has(word)).length;
  const genericOverlap = [...plannedWords].filter((word) => generic.has(word) && titleWords.has(word)).length;
  return distinctiveOverlap >= 2 || (distinctiveOverlap >= 1 && genericOverlap >= 1);
}
function timestamp(value) { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? parsed : 0; }
function humanize(value) { return String(value).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
