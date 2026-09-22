import { discoverGreenhouse } from "./greenhouse.mjs";

const TOKEN_RE = /^[a-z0-9_-]{2,80}$/i;
const CACHE_TTL = { greenhouse: 10 * 60_000, lever: 10 * 60_000, ashby: 10 * 60_000, jobledger: 5 * 60_000, ziprecruiter: 15 * 60_000, remotive: 6 * 60 * 60_000, arbeitnow: 60 * 60_000 };

export const DEFAULT_SOURCE_CONFIG = {
  greenhouseBoards: [],
  leverSites: [],
  ashbyBoards: [],
  broadFeeds: ["jobledger", "ziprecruiter", "remotive"],
};

export function createSourceDiscovery({ fetchFn = fetch, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async function discover(source, options = {}) {
    const planKey = source.type === "jobledger"
      ? `:${JSON.stringify({ queries: options.plan?.ledgerQueries || [], filters: options.plan?.filters || {} })}`
      : "";
    const key = `${source.type}:${source.token || source.type}${planKey}`;
    const cached = cache.get(key);
    const ttl = CACHE_TTL[source.type] || 10 * 60_000;
    if (cached && now() - cached.at < ttl) return { ...cached.value, cached: true };
    let value;
    if (source.type === "greenhouse") value = await discoverGreenhouse(source.token, { ...options, fetchFn });
    else if (source.type === "lever") value = await discoverLever(source.token, { ...options, fetchFn });
    else if (source.type === "ashby") value = await discoverAshby(source.token, { ...options, fetchFn });
    else if (source.type === "jobledger") value = await discoverJobLedger({ ...options, fetchFn });
    else if (source.type === "ziprecruiter") value = await discoverZipRecruiter({ ...options, fetchFn });
    else if (source.type === "remotive") value = await discoverRemotive({ ...options, fetchFn });
    else if (source.type === "arbeitnow") value = await discoverArbeitnow({ ...options, fetchFn });
    else value = { source: source.type, board: source.token || "", jobs: [], error: "Unknown job source." };
    if (!value.error) cache.set(key, { at: now(), value });
    return value;
  };
}

export async function discoverZipRecruiter(options = {}) {
  const { fetchFn = fetch, timeoutMs = 15_000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn("https://api.ziprecruiter.com/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "user-agent": "ClearLead/0.2 (+local job discovery)" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_jobs", arguments: {} } }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const suffix = response.status === 429 ? " The public endpoint is rate-limited; retry later." : "";
      return { source: "ziprecruiter", board: "public-mcp", jobs: [], error: `ZipRecruiter returned HTTP ${response.status}.${suffix}` };
    }
    const payload = parseMcpPayload(await response.text());
    if (payload?.error) return { source: "ziprecruiter", board: "public-mcp", jobs: [], error: `ZipRecruiter search failed: ${text(payload.error.message, "unknown MCP error")}` };
    const rows = findJobRows(payload?.result);
    const seen = new Set();
    const jobs = rows.map(normalizeZipJob).filter((job) => isHttpUrl(job.url) && !seen.has(job.url) && seen.add(job.url));
    return {
      source: "ziprecruiter",
      board: "public-mcp",
      jobs,
      error: null,
      queryMode: "supplemental-unfiltered",
      note: "Supplemental unfiltered sample: ZipRecruiter's public MCP does not accept this search query, so ClearLead filters and ranks its small result page locally.",
    };
  } catch (error) {
    return { source: "ziprecruiter", board: "public-mcp", jobs: [], error: error?.name === "AbortError" ? "ZipRecruiter timed out. Retry this source." : "Could not reach ZipRecruiter from this machine. Retry this source." };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverJobLedger(options = {}) {
  const { fetchFn = fetch, timeoutMs = 20_000, plan = {} } = options;
  const queries = (Array.isArray(plan.ledgerQueries) ? plan.ledgerQueries : []).map((value) => text(value).slice(0, 80)).filter(Boolean).slice(0, 5);
  const searches = queries.length ? queries : [""];
  const outcomes = await Promise.all(searches.map(async (query) => {
    const params = new URLSearchParams({ limit: "50", include_description: "true" });
    if (query) params.set("q", query);
    if (/^[A-Z]{2}$/i.test(plan.filters?.country || "")) params.set("country", String(plan.filters.country).toUpperCase());
    if (/^[A-Z]{2}$/i.test(plan.filters?.state || "")) params.set("state", String(plan.filters.state).toUpperCase());
    return fetchJson(`https://api.jobopportunitiesapi.org/public/jobs?${params}`, { fetchFn, timeoutMs, type: "jobledger" });
  }));
  const failures = outcomes.filter((item) => item.error);
  const rows = outcomes.flatMap((item) => Array.isArray(item.payload?.data) ? item.payload.data : []);
  const seen = new Set();
  const jobs = rows.map((job) => ({
    source: "jobledger",
    board: text(job.source, "employer-direct"),
    company: text(job.company, "Company not listed"),
    title: text(job.title, "Untitled role"),
    location: text(job.location, [job.city, job.state, job.country].filter(Boolean).join(", ") || "Location not listed"),
    url: text(job.apply_url),
    applyUrl: text(job.apply_url),
    postedAt: iso(job.posted_at),
    description: text(job.description).slice(0, 80_000),
    workplaceType: text(job.remote),
    seniority: text(job.seniority),
    category: text(job.category),
    salary: salaryText(job),
    provider: text(job.source),
  })).filter((job) => isHttpUrl(job.url) && !seen.has(job.url) && seen.add(job.url));
  if (!jobs.length && failures.length === outcomes.length) return { source: "jobledger", board: "employer-direct", jobs: [], error: failures[0].error };
  return { source: "jobledger", board: "employer-direct", jobs, error: null };
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
    type: "remotive", board: "remote", endpoint: "https://remotive.com/api/remote-jobs?limit=250", options, queryMode: "full-feed-local-filtered",
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
    type: "arbeitnow", board: "europe", endpoint: "https://www.arbeitnow.com/api/job-board-api", options, queryMode: "full-feed-local-filtered",
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

async function fetchJobs({ type, board, endpoint, options, map, queryMode = "" }) {
  const { fetchFn = fetch, timeoutMs = 15_000, limit = 500 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint, { headers: { accept: "application/json", "user-agent": "ClearLead/0.2 (+local job discovery)" }, signal: controller.signal });
    if (!response.ok) return { source: type, board, jobs: [], error: `${humanize(type)} returned HTTP ${response.status}. Retry or remove this source.` };
    const jobs = map(await response.json()).filter((job) => isHttpUrl(job.url)).slice(0, Math.min(Math.max(Number(limit) || 500, 1), 1000));
    return { source: type, board, jobs, error: null, ...(queryMode ? { queryMode } : {}) };
  } catch (error) {
    return { source: type, board, jobs: [], error: error?.name === "AbortError" ? `${humanize(type)} timed out. Retry this source.` : `Could not reach ${humanize(type)} from this machine. Retry this source.` };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(endpoint, { fetchFn, timeoutMs, type }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint, { headers: { accept: "application/json", "user-agent": "ClearLead/0.2 (+local job discovery)" }, signal: controller.signal });
    if (!response.ok) return { payload: null, error: `${humanize(type)} returned HTTP ${response.status}.` };
    return { payload: await response.json(), error: null };
  } catch (error) {
    return { payload: null, error: error?.name === "AbortError" ? `${humanize(type)} timed out.` : `Could not reach ${humanize(type)} from this machine.` };
  } finally {
    clearTimeout(timer);
  }
}

function parseMcpPayload(value) {
  const source = String(value || "").trim();
  const candidates = source.startsWith("data:")
    ? source.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [source];
  for (const candidate of candidates.reverse()) {
    try { return JSON.parse(candidate); } catch {}
  }
  throw new Error("ZipRecruiter returned an unreadable MCP response.");
}

function findJobRows(result) {
  const candidates = [];
  const visit = (value, depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      if (value.some((item) => item && typeof item === "object" && jobUrl(item))) candidates.push(value);
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try { visit(JSON.parse(trimmed), depth + 1); } catch {}
      }
      return;
    }
    if (typeof value === "object") for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(result);
  return candidates.sort((left, right) => right.length - left.length)[0] || [];
}

function normalizeZipJob(job) {
  const location = typeof job.location === "object" ? [job.location.city, job.location.state, job.location.country].filter(Boolean).join(", ") : job.location;
  return {
    source: "ziprecruiter", board: "public-mcp",
    company: text(job.company_name || job.companyName || job.company, "Company not listed"),
    title: text(job.title || job.name, "Untitled role"),
    location: text(location || job.job_location, "Location not listed"),
    url: text(jobUrl(job)), applyUrl: text(job.apply_url || job.applyUrl || job.url),
    postedAt: iso(job.posted_at || job.postedAt || job.date_posted || job.datePosted),
    description: stripHtml(job.description || job.snippet || job.summary),
    salary: text(job.salary || job.salary_text), workplaceType: text(job.workplace_type || job.workplaceType),
  };
}

function jobUrl(job) { return job?.job_url || job?.jobUrl || job?.listing_url || job?.listingUrl || job?.apply_url || job?.applyUrl || job?.url || ""; }

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
function salaryText(job) {
  if (!Number.isFinite(Number(job?.salary_min)) && !Number.isFinite(Number(job?.salary_max))) return "";
  const currency = text(job.salary_currency, "USD");
  const period = text(job.salary_period, "year");
  return `${currency} ${job.salary_min ?? ""}${job.salary_max && job.salary_max !== job.salary_min ? `–${job.salary_max}` : ""} / ${period}`;
}
