import { discoverGreenhouse } from "./greenhouse.mjs";

const TOKEN_RE = /^[a-z0-9_-]{2,80}$/i;
const CACHE_TTL = { greenhouse: 10 * 60_000, lever: 10 * 60_000, ashby: 10 * 60_000, remotive: 6 * 60 * 60_000, arbeitnow: 60 * 60_000 };

export const DEFAULT_SOURCE_CONFIG = {
  greenhouseBoards: ["figma", "datadog", "cloudflare", "discord", "lyft", "reddit", "coinbase", "robinhood"],
  leverSites: ["palantir"],
  ashbyBoards: ["ramp", "linear"],
  broadFeeds: ["remotive", "arbeitnow"],
};

export function createSourceDiscovery({ fetchFn = fetch, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async function discover(source, options = {}) {
    const key = `${source.type}:${source.token || source.type}`;
    const cached = cache.get(key);
    const ttl = CACHE_TTL[source.type] || 10 * 60_000;
    if (cached && now() - cached.at < ttl) return { ...cached.value, cached: true };
    let value;
    if (source.type === "greenhouse") value = await discoverGreenhouse(source.token, { ...options, fetchFn });
    else if (source.type === "lever") value = await discoverLever(source.token, { ...options, fetchFn });
    else if (source.type === "ashby") value = await discoverAshby(source.token, { ...options, fetchFn });
    else if (source.type === "remotive") value = await discoverRemotive({ ...options, fetchFn });
    else if (source.type === "arbeitnow") value = await discoverArbeitnow({ ...options, fetchFn });
    else value = { source: source.type, board: source.token || "", jobs: [], error: "Unknown job source." };
    if (!value.error) cache.set(key, { at: now(), value });
    return value;
  };
}

export async function discoverLever(site, options = {}) {
  const token = validToken(site, "Lever");
  if (!token.ok) return token.result;
  return fetchJobs({
    type: "lever", board: token.value,
    endpoint: `https://api.lever.co/v0/postings/${encodeURIComponent(token.value)}?mode=json&limit=250`,
    options,
    map(payload) {
      return (Array.isArray(payload) ? payload : []).map((job) => ({
        source: "lever", board: token.value, company: humanize(token.value),
        title: text(job.text, "Untitled role"), location: text(job.categories?.location, "Location not listed"),
        url: text(job.hostedUrl), applyUrl: text(job.applyUrl), postedAt: epoch(job.createdAt),
        description: text(job.descriptionPlain || job.openingPlain), workplaceType: text(job.workplaceType),
      }));
    },
  });
}

export async function discoverAshby(board, options = {}) {
  const token = validToken(board, "Ashby");
  if (!token.ok) return token.result;
  return fetchJobs({
    type: "ashby", board: token.value,
    endpoint: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token.value)}?includeCompensation=true`,
    options,
    map(payload) {
      return (Array.isArray(payload?.jobs) ? payload.jobs : []).filter((job) => job.isListed !== false).map((job) => ({
        source: "ashby", board: token.value, company: humanize(token.value),
        title: text(job.title, "Untitled role"), location: text(job.location, "Location not listed"),
        url: text(job.jobUrl), applyUrl: text(job.applyUrl), postedAt: iso(job.publishedAt),
        description: text(job.descriptionPlain), department: text(job.department), team: text(job.team),
      }));
    },
  });
}

export async function discoverRemotive(options = {}) {
  return fetchJobs({
    type: "remotive", board: "remote", endpoint: "https://remotive.com/api/remote-jobs?limit=250", options,
    map(payload) {
      return (Array.isArray(payload?.jobs) ? payload.jobs : []).map((job) => ({
        source: "remotive", board: "remote", company: text(job.company_name, "Company not listed"),
        title: text(job.title, "Untitled role"), location: text(job.candidate_required_location, "Remote"),
        url: text(job.url), postedAt: iso(job.publication_date), description: stripHtml(job.description), salary: text(job.salary),
      }));
    },
  });
}

export async function discoverArbeitnow(options = {}) {
  return fetchJobs({
    type: "arbeitnow", board: "europe", endpoint: "https://www.arbeitnow.com/api/job-board-api", options,
    map(payload) {
      return (Array.isArray(payload?.data) ? payload.data : []).map((job) => ({
        source: "arbeitnow", board: "europe", company: text(job.company_name, "Company not listed"),
        title: text(job.title, "Untitled role"), location: text(job.location, job.remote ? "Remote" : "Location not listed"),
        url: text(job.url), postedAt: epoch(job.created_at, true), description: stripHtml(job.description),
        workplaceType: job.remote ? "remote" : "unspecified",
      }));
    },
  });
}

async function fetchJobs({ type, board, endpoint, options, map }) {
  const { fetchFn = fetch, timeoutMs = 15_000, limit = 500 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint, { headers: { accept: "application/json", "user-agent": "ClearLead/0.2 (+local job discovery)" }, signal: controller.signal });
    if (!response.ok) return { source: type, board, jobs: [], error: `${humanize(type)} returned HTTP ${response.status}. Retry or remove this source.` };
    const jobs = map(await response.json()).filter((job) => isHttpUrl(job.url)).slice(0, Math.min(Math.max(Number(limit) || 500, 1), 1000));
    return { source: type, board, jobs, error: null };
  } catch (error) {
    return { source: type, board, jobs: [], error: error?.name === "AbortError" ? `${humanize(type)} timed out. Retry this source.` : `Could not reach ${humanize(type)} from this machine. Retry this source.` };
  } finally {
    clearTimeout(timer);
  }
}

function validToken(value, name) {
  const token = String(value || "").trim().toLowerCase();
  return TOKEN_RE.test(token)
    ? { ok: true, value: token }
    : { ok: false, result: { source: name.toLowerCase(), board: token, jobs: [], error: `Enter a valid ${name} board token.` } };
}
function text(value, fallback = "") { const output = String(value || "").trim(); return output || fallback; }
function stripHtml(value) { return text(value).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim(); }
function iso(value) { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }
function epoch(value, seconds = false) { const parsed = Number(value); if (!Number.isFinite(parsed)) return null; return new Date(parsed * (seconds ? 1000 : 1)).toISOString(); }
function humanize(value) { return String(value).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function isHttpUrl(value) { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } }
