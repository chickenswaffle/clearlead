import { roleRelevance } from "./profile.mjs";

export const DEFAULT_SOURCES = [
  { board: "figma", name: "Figma" },
  { board: "datadog", name: "Datadog" },
  { board: "cloudflare", name: "Cloudflare" },
  { board: "discord", name: "Discord" },
  { board: "lyft", name: "Lyft" },
  { board: "reddit", name: "Reddit" },
  { board: "coinbase", name: "Coinbase" },
  { board: "robinhood", name: "Robinhood" },
];

const SOURCE_NAMES = new Map(DEFAULT_SOURCES.map((source) => [source.board, source.name]));
const REFRESH_OPTIONS = new Set([2, 5, 15, 30]);
const STOP_WORDS = new Set(["and", "the", "of", "for", "in", "to", "a", "an", "with"]);

export function normalizeSearchConfig(input = {}) {
  const suppliedBoards = Array.isArray(input.boards)
    ? input.boards
    : typeof input.boards === "string"
      ? input.boards.split(/[,\n]/)
      : DEFAULT_SOURCES.map((source) => source.board);
  const boards = [...new Set(suppliedBoards
    .map((board) => String(board).trim().toLowerCase())
    .filter((board) => /^[a-z0-9_-]{2,80}$/.test(board)))]
    .slice(0, 12);
  const refreshMinutes = Number(input.refreshMinutes);

  return {
    boards,
    query: String(input.query || "").trim().slice(0, 160),
    location: String(input.location || "").trim().slice(0, 160),
    autoRefresh: input.autoRefresh !== false,
    refreshMinutes: REFRESH_OPTIONS.has(refreshMinutes) ? refreshMinutes : 5,
  };
}

export async function searchPublishedRoles(input, {
  discoverFn,
  profile = {},
  now = () => new Date(),
} = {}) {
  if (typeof discoverFn !== "function") throw new Error("A discovery adapter is required.");
  const config = normalizeSearchConfig(input);
  const outcomes = await Promise.all(config.boards.map(async (board) => {
    const result = await discoverFn(board, { limit: 500 });
    return {
      board,
      name: SOURCE_NAMES.get(board) || humanize(board),
      ok: !result.error,
      error: result.error,
      jobs: result.jobs || [],
    };
  }));

  const queryGroups = config.query
    ? config.query.split(",").map(words).filter((group) => group.length > 0)
    : (Array.isArray(profile.targetRoles) ? profile.targetRoles.map(words).filter((group) => group.length > 0) : []);
  const locationGroups = config.location.split(",").map(words).filter((group) => group.length > 0);
  const unique = new Map();
  for (const source of outcomes) {
    for (const job of source.jobs) {
      if (!job.url || unique.has(job.url)) continue;
      const titleTerms = new Set(words(job.title));
      const groupMatches = queryGroups.map((group) => ({
        terms: group,
        matched: group.filter((term) => titleTerms.has(term)),
      }));
      const completeMatches = groupMatches.filter((match) => match.matched.length === match.terms.length);
      if (queryGroups.length > 0 && completeMatches.length === 0) continue;
      const bestMatch = (completeMatches.length > 0 ? completeMatches : groupMatches)
        .sort((a, b) => (b.matched.length / b.terms.length) - (a.matched.length / a.terms.length))[0];
      const locationText = new Set(words(job.location));
      if (locationGroups.length > 0 && !locationGroups.some((group) => group.every((term) => locationText.has(term)))) continue;
      const profileMatch = roleRelevance(job.title, profile);
      const queryScore = bestMatch ? Math.round((bestMatch.matched.length / bestMatch.terms.length) * 100) : null;
      unique.set(job.url, {
        ...job,
        company: source.name,
        relevance: queryScore === null ? profileMatch : {
          matched: bestMatch.matched,
          totalTerms: bestMatch.terms.length,
          score: queryScore,
        },
        verificationStatus: "unverified",
      });
    }
  }

  const matchedJobs = [...unique.values()].sort((a, b) => {
    const score = (b.relevance?.score || 0) - (a.relevance?.score || 0);
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

function words(value) {
  return (String(value).toLowerCase().match(/[a-z0-9+#.]{2,}/g) || []).filter((word) => !STOP_WORDS.has(word));
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function humanize(value) {
  return String(value).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
