// Employer career-site adapters. Many large employers (airports, airlines,
// cities, hospitals) never reach the broad job feeds, but their own career
// sites run on a handful of platforms with public, unauthenticated search
// endpoints. Each adapter returns the same shape as the feeds in sources.mjs:
// { source, board, jobs, error, queryMode, note }.

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) ClearLead/0.3 Safari/537.36";
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
const SLUG_RE = /^[a-z0-9_-]{1,80}$/i;
export const EMPLOYER_SITE_TYPES = ["phenom", "workday", "icims"];

export function normalizeEmployerSite(input = {}) {
  if (!input || typeof input !== "object") return null;
  const type = String(input.type || "").toLowerCase();
  const host = validHost(input.host);
  const name = clean(input.name, 120) || host;
  if (!EMPLOYER_SITE_TYPES.includes(type) || !host) return null;
  const base = { type, host, name };
  if (input.careersUrl && isHttpUrl(input.careersUrl)) base.careersUrl = String(input.careersUrl).slice(0, 400);
  if (input.defaultLocation) base.defaultLocation = clean(input.defaultLocation, 120);
  if (type === "phenom") {
    return { ...base, ...(SLUG_RE.test(input.refNum || "") ? { refNum: String(input.refNum) } : {}), lang: /^[a-z]{2}_[a-z]{2}$/i.test(input.lang || "") ? input.lang.toLowerCase() : "en_us", country: /^[a-z]{2}$/i.test(input.country || "") ? input.country.toLowerCase() : "us" };
  }
  if (type === "workday") {
    if (!host.endsWith(".myworkdayjobs.com") || !SLUG_RE.test(input.tenant || "") || !SLUG_RE.test(input.site || "")) return null;
    return { ...base, tenant: String(input.tenant), site: String(input.site), searchText: clean(input.searchText, 120), locationFacets: strings(input.locationFacets).map((value) => clean(value, 120)).slice(0, 8) };
  }
  if (!host.endsWith(".icims.com")) return null;
  return { ...base, searchLocation: /^[0-9-]{1,40}$/.test(input.searchLocation || "") ? input.searchLocation : "", searchKeyword: clean(input.searchKeyword, 120) };
}

export function employerSiteId(site) {
  if (site.type === "workday") return `${site.host}/${site.site}${site.locationFacets?.length ? `#${site.locationFacets.join("+")}` : ""}`;
  return site.host;
}

export async function discoverEmployerSite(site, options = {}) {
  const normalized = normalizeEmployerSite(site);
  if (!normalized) return failure(String(site?.type || "employer"), String(site?.host || ""), "This employer careers site is not configured correctly.");
  if (normalized.type === "phenom") return discoverPhenom(normalized, options);
  if (normalized.type === "workday") return discoverWorkday(normalized, options);
  return discoverIcims(normalized, options);
}

// Phenom People (careers.<employer>.com/us/en/...). The site's own search page
// calls POST /widgets with ddoKey=refineSearch; job pages embed phApp.ddo JSON.
export async function discoverPhenom(site, options = {}) {
  const { fetchFn = fetch, timeoutMs = 20_000, maxJobs = 500, enrichLimit = 150, plan } = options;
  const lang2 = site.lang.slice(0, 2);
  let refNum = site.refNum;
  if (!refNum) {
    const page = await getText(`https://${site.host}/${site.country}/${lang2}/search-results`, { fetchFn, timeoutMs });
    refNum = page.text?.match(/"refNum"\s*:\s*"([A-Za-z0-9_-]{2,40})"/)?.[1];
    if (!refNum) return failure("phenom", site.host, page.error || `${site.name} did not expose a readable Phenom site identifier.`);
  }
  const rows = new Map();
  let total = Infinity;
  for (let from = 0; from < Math.min(total, maxJobs); from += 100) {
    const response = await postJson(`https://${site.host}/widgets`, {
      lang: site.lang, deviceType: "desktop", country: site.country, pageName: "search-results", ddoKey: "refineSearch",
      sortBy: "", subsearch: "", from, jobs: true, counts: false, all_fields: [], size: 100, clearAll: false,
      jdsource: "facets", isSliderEnable: false, pageId: "page11", siteType: "external", keywords: "", global: true,
      selected_fields: {}, locationData: {}, refNum,
    }, { fetchFn, timeoutMs });
    if (response.error) {
      if (!rows.size) return failure("phenom", site.host, `${site.name}: ${response.error}`);
      break;
    }
    const block = response.payload?.refineSearch;
    total = Number(block?.totalHits) || 0;
    const page = Array.isArray(block?.data?.jobs) ? block.data.jobs : [];
    if (!page.length) break;
    let added = 0;
    for (const row of page) if (row?.jobId && !rows.has(row.jobId)) { rows.set(row.jobId, row); added += 1; }
    if (!added) break;
  }
  const jobs = [...rows.values()].map((row) => ({
    source: "phenom",
    board: site.host,
    company: site.name,
    title: clean(row.title, 200) || "Untitled role",
    location: clean(row.location || row.cityStateCountry || [row.city, row.state].filter(Boolean).join(", "), 200) || site.defaultLocation || "Location not listed",
    url: `https://${site.host}/${site.country}/${lang2}/job/${encodeURIComponent(row.jobId)}`,
    applyUrl: isHttpUrl(row.applyUrl) ? row.applyUrl : "",
    postedAt: iso(row.postedDate || row.dateCreated),
    description: clean(row.descriptionTeaser, 2_000),
    category: clean(row.category, 120),
    department: clean(row.department, 160),
    employmentType: clean(row.type, 80),
  })).filter((job) => isHttpUrl(job.url));
  await enrich(jobs, { limit: enrichLimit, plan }, async (job) => {
    const page = await getText(job.url, { fetchFn, timeoutMs });
    const ddo = page.text ? embeddedJson(page.text, /phApp\.ddo\s*=\s*/) : null;
    const detail = ddo?.jobDetail?.data?.job;
    if (!detail) return;
    job.description = stripHtml(detail.description || detail.jobDescription || "").slice(0, 80_000) || job.description;
    job.salary = job.salary || extractPay(job.description);
  });
  return { source: "phenom", board: site.host, jobs, error: null, queryMode: "employer-site-full", note: noteFor(site, jobs.length, total) };
}

// Workday (<tenant>.wdN.myworkdayjobs.com/<site>). The public career site is
// a client of the CXS JSON API, which needs no session for search or detail.
export async function discoverWorkday(site, options = {}) {
  const { fetchFn = fetch, timeoutMs = 20_000, maxJobs = 400, enrichLimit = 120, plan, now = () => new Date() } = options;
  const api = `https://${site.host}/wday/cxs/${site.tenant}/${site.site}`;
  const appliedFacets = {};
  if (site.locationFacets?.length) {
    const probe = await postJson(`${api}/jobs`, { appliedFacets: {}, limit: 1, offset: 0, searchText: "" }, { fetchFn, timeoutMs });
    if (probe.error) return failure("workday", employerSiteId(site), `${site.name}: ${probe.error}`);
    const wanted = new Set(site.locationFacets.map((value) => value.toLowerCase()));
    for (const { parameter, id } of facetValues(probe.payload?.facets).filter((value) => wanted.has(value.descriptor.toLowerCase()))) {
      (appliedFacets[parameter] ||= []).push(id);
    }
    if (!Object.keys(appliedFacets).length) return failure("workday", employerSiteId(site), `${site.name} no longer lists the location filter "${site.locationFacets.join(", ")}". Open the careers site to check where these jobs moved.`);
  }
  const rows = new Map();
  let total = Infinity;
  for (let offset = 0; offset < Math.min(total, maxJobs); offset += 20) {
    const response = await postJson(`${api}/jobs`, { appliedFacets, limit: 20, offset, searchText: site.searchText || "" }, { fetchFn, timeoutMs });
    if (response.error) {
      if (!rows.size) return failure("workday", employerSiteId(site), `${site.name}: ${response.error}`);
      break;
    }
    if (offset === 0) total = Number(response.payload?.total) || 0;
    const page = Array.isArray(response.payload?.jobPostings) ? response.payload.jobPostings : [];
    if (!page.length) break;
    for (const row of page) if (row?.externalPath) rows.set(row.externalPath, row);
  }
  const jobs = [...rows.values()].map((row) => ({
    source: "workday",
    board: employerSiteId(site),
    company: site.name,
    title: clean(row.title, 200) || "Untitled role",
    location: workdayLocation(row.locationsText, site.defaultLocation),
    url: `https://${site.host}/${site.site}${row.externalPath}`,
    applyUrl: `https://${site.host}/${site.site}${row.externalPath}/apply`,
    postedAt: workdayRelativeDate(row.postedOn, now()),
    description: "",
    externalPath: row.externalPath,
  }));
  await enrich(jobs, { limit: enrichLimit, plan }, async (job) => {
    const detail = await getJson(`${api}${job.externalPath}`, { fetchFn, timeoutMs });
    const info = detail.payload?.jobPostingInfo;
    if (!info) return;
    job.description = stripHtml(info.jobDescription).slice(0, 80_000);
    job.postedAt = iso(info.startDate) || job.postedAt;
    job.closesAt = iso(info.endDate);
    job.employmentType = clean(info.timeType, 80);
    job.location = workdayLocation(info.location, site.defaultLocation) || job.location;
    job.salary = extractPay(job.description);
  });
  for (const job of jobs) delete job.externalPath;
  return { source: "workday", board: employerSiteId(site), jobs, error: null, queryMode: "employer-site-full", note: noteFor(site, jobs.length, total) };
}

// iCIMS (<portal>.icims.com/jobs/search). The iframe view is server-rendered
// HTML; job pages carry schema.org JobPosting JSON-LD.
export async function discoverIcims(site, options = {}) {
  const { fetchFn = fetch, timeoutMs = 20_000, maxPages = 25, enrichLimit = 120, plan } = options;
  const rows = new Map();
  let firstError = "";
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ ss: "1", in_iframe: "1", pr: String(page) });
    if (site.searchLocation) params.set("searchLocation", site.searchLocation);
    if (site.searchKeyword) params.set("searchKeyword", site.searchKeyword);
    const response = await getText(`https://${site.host}/jobs/search?${params}`, { fetchFn, timeoutMs });
    if (response.error) { firstError ||= response.error; break; }
    let added = 0;
    for (const card of parseIcimsCards(response.text, site.host)) if (!rows.has(card.id)) { rows.set(card.id, card); added += 1; }
    if (!added) break;
  }
  if (!rows.size && firstError) return failure("icims", site.host, `${site.name}: ${firstError}`);
  const jobs = [...rows.values()].map((card) => ({
    source: "icims",
    board: site.host,
    company: site.name,
    title: card.title,
    location: card.location || site.defaultLocation || "Location not listed",
    url: card.url,
    applyUrl: card.url,
    postedAt: null,
    description: "",
    category: card.category,
    employmentType: card.employmentType,
  }));
  await enrich(jobs, { limit: enrichLimit, plan }, async (job) => {
    const page = await getText(`${job.url}?in_iframe=1`, { fetchFn, timeoutMs });
    const posting = page.text ? jobPostingLd(page.text) : null;
    if (!posting) return;
    job.description = stripHtml(posting.description).slice(0, 80_000);
    job.postedAt = iso(posting.datePosted);
    job.closesAt = iso(posting.validThrough);
    job.employmentType = job.employmentType || clean(Array.isArray(posting.employmentType) ? posting.employmentType.join(", ") : posting.employmentType, 80);
    job.salary = extractPay(job.description);
  });
  return { source: "icims", board: site.host, jobs, error: null, queryMode: "employer-site-full", note: noteFor(site, jobs.length, rows.size) };
}

// Resolve a careers URL (often suggested by the AI planner) to a supported
// adapter. Never trusts the suggestion: the platform must be observable.
export async function detectCareerSite(url, { fetchFn = fetch, timeoutMs = 15_000, name = "", depth = 0 } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: "Not a valid URL." }; }
  if (!/^https?:$/.test(parsed.protocol) || !validHost(parsed.hostname)) return { ok: false, reason: "Only public https careers sites are supported." };
  const host = parsed.hostname.toLowerCase();
  const label = clean(name, 120) || host;
  const fromUrl = siteFromUrl(parsed, label);
  if (fromUrl) return { ok: true, site: fromUrl };
  const page = await getText(parsed.toString(), { fetchFn, timeoutMs });
  if (page.error) return { ok: false, reason: page.error };
  const finalUrl = safeUrl(page.finalUrl);
  if (finalUrl && finalUrl.hostname !== host) {
    const redirected = siteFromUrl(finalUrl, label);
    if (redirected) return { ok: true, site: redirected };
  }
  const refNum = page.text.match(/"refNum"\s*:\s*"([A-Za-z0-9_-]{2,40})"/)?.[1];
  if (refNum && /phApp|phenom/i.test(page.text)) {
    return { ok: true, site: normalizeEmployerSite({ type: "phenom", host: (finalUrl || parsed).hostname, refNum, name: label, careersUrl: url }) };
  }
  if (depth < 1) {
    const linked = [...page.text.matchAll(/https?:\/\/[a-z0-9.-]+\.(?:myworkdayjobs\.com\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?|icims\.com\/jobs|greenhouse\.io\/[a-z0-9_-]+|lever\.co\/[a-z0-9_-]+|ashbyhq\.com\/[a-z0-9_-]+)/gi)].map((match) => match[0]);
    for (const candidate of [...new Set(linked)].slice(0, 4)) {
      const detected = await detectCareerSite(candidate, { fetchFn, timeoutMs, name: label, depth: depth + 1 });
      if (detected.ok) return detected;
    }
  }
  return { ok: false, reason: `${label}'s careers site uses a platform ClearLead cannot search yet.` };
}

function siteFromUrl(parsed, name) {
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (host.endsWith(".myworkdayjobs.com")) {
    const site = segments.find((segment) => !/^[a-z]{2}-[A-Z]{2}$/.test(segment));
    return normalizeEmployerSite({ type: "workday", host, tenant: host.split(".")[0], site, name, careersUrl: parsed.toString() });
  }
  if (host.endsWith(".icims.com")) return normalizeEmployerSite({ type: "icims", host, name, careersUrl: parsed.toString() });
  if (/(^|\.)greenhouse\.io$/.test(host) && SLUG_RE.test(segments[0] || "")) return { type: "greenhouse", token: segments[0].toLowerCase(), name };
  if (host === "jobs.lever.co" && SLUG_RE.test(segments[0] || "")) return { type: "lever", token: segments[0].toLowerCase(), name };
  if (host === "jobs.ashbyhq.com" && SLUG_RE.test(segments[0] || "")) return { type: "ashby", token: segments[0].toLowerCase(), name };
  return null;
}

export function parseIcimsCards(html, host) {
  const cards = [];
  for (const chunk of String(html || "").split("iCIMS_JobCardItem").slice(1)) {
    const link = chunk.match(/href="(https:\/\/[^"]+?\/jobs\/(\d+)\/[^"?]+\/job)[^"]*"/);
    const heading = chunk.match(/<h3[^>]*>\s*([\s\S]*?)\s*<\/h3>/);
    if (!link || !heading) continue;
    let linkHost = "";
    try { linkHost = new URL(link[1]).hostname.toLowerCase(); } catch {}
    if (linkHost !== host) continue;
    const location = chunk.match(/Job Locations<\/span>\s*<span[^>]*>\s*([^<]+)/)?.[1] || "";
    const category = chunk.match(/>Category<\/dt>\s*<dd[^>]*><span[^>]*>\s*([^<]+)/)?.[1] || "";
    const employmentType = chunk.match(/>Position Type[^<]*<\/dt>\s*<dd[^>]*><span[^>]*>\s*([^<]+)/)?.[1] || "";
    cards.push({ id: link[2], url: link[1], title: decode(stripHtml(heading[1])), location: icimsLocation(decode(location)), category: clean(decode(category), 120), employmentType: clean(decode(employmentType), 80) });
  }
  return cards;
}

export function icimsLocation(value) {
  return String(value || "").split("|").map((part) => {
    const match = part.trim().match(/^([A-Z]{2})-([A-Z]{2})-(.+)$/);
    return match ? `${match[3].trim()}, ${match[2]}, ${match[1]}` : part.trim();
  }).filter(Boolean).join(" | ").slice(0, 300);
}

export function workdayRelativeDate(value, now = new Date()) {
  const textValue = String(value || "").toLowerCase();
  const day = 86_400_000;
  const base = new Date(now).getTime();
  if (/today/.test(textValue)) return new Date(base).toISOString();
  if (/yesterday/.test(textValue)) return new Date(base - day).toISOString();
  const plus = textValue.match(/(\d+)\+\s*days?/);
  if (plus) return null;
  const days = textValue.match(/(\d+)\s*days?/);
  return days ? new Date(base - Number(days[1]) * day).toISOString() : null;
}

export function extractPay(value) {
  const textValue = String(value || "");
  const match = textValue.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)(?:\s*(?:-|–|—|to)\s*\$?\s?(\d[\d,]*(?:\.\d{1,2})?))?\s*(?:\/|per|an?)\s*(hour|hr|year|yr|annually|annum)\b/i);
  if (!match) return "";
  const period = /^(hour|hr)$/i.test(match[3]) ? "hour" : "year";
  return `$${match[1]}${match[2] ? `–$${match[2]}` : ""} / ${period}`;
}

function workdayLocation(value, fallback = "") {
  const textValue = clean(value, 200);
  if (!textValue) return fallback || "Location not listed";
  // Some tenants publish internal facility codes ("AVICDRSPGS") instead of places.
  if (fallback && (/^[A-Z0-9 _-]{4,}$/.test(textValue) || /^\d+\s+locations?$/i.test(textValue))) return fallback;
  return textValue;
}

function facetValues(facets, parameter = "") {
  const output = [];
  for (const facet of Array.isArray(facets) ? facets : []) {
    const param = facet?.facetParameter || parameter;
    for (const value of Array.isArray(facet?.values) ? facet.values : []) {
      if (Array.isArray(value?.values)) output.push(...facetValues([value], value.facetParameter || param));
      else if (value?.id && value?.descriptor) output.push({ parameter: param, id: String(value.id), descriptor: String(value.descriptor) });
    }
  }
  return output;
}

async function enrich(jobs, { limit, plan }, worker) {
  if (!jobs.length || limit <= 0) return;
  const preferred = (Array.isArray(plan?.locations) ? plan.locations : []).map((value) => String(value).toLowerCase()).filter(Boolean);
  const ordered = [...jobs].sort((left, right) => locationRank(right, preferred) - locationRank(left, preferred));
  const queue = ordered.slice(0, limit);
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try { await worker(job); } catch {}
    }
  });
  await Promise.all(workers);
}

function locationRank(job, preferred) {
  if (!preferred.length) return 0;
  const location = String(job.location || "").toLowerCase();
  return preferred.some((value) => location.includes(value)) ? 1 : 0;
}

function noteFor(site, count, total) {
  const shown = Number.isFinite(total) && total > count ? `${count} of ${total}` : `${count}`;
  return `${shown} openings read directly from ${site.name}'s careers site.`;
}

export function embeddedJson(html, marker) {
  const match = marker.exec(html);
  if (!match) return null;
  const start = html.indexOf("{", match.index + match[0].length - 1);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

export function jobPostingLd(html) {
  for (const match of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const items = Array.isArray(parsed) ? parsed : parsed?.["@graph"] || [parsed];
      const posting = items.find((item) => /JobPosting/i.test(String(item?.["@type"] || "")) || (item?.title && item?.datePosted));
      if (posting) return posting;
    } catch {}
  }
  return null;
}

async function request(url, init, { fetchFn, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { redirect: "follow", ...init, headers: { "user-agent": USER_AGENT, "accept-language": "en-US,en;q=0.9", ...(init.headers || {}) }, signal: controller.signal });
    if (!response.ok) {
      const blocked = response.status === 401 || response.status === 403 || response.status === 429;
      return { error: blocked ? `the careers site refused automated access (HTTP ${response.status}). Open it in your browser instead.` : `the careers site returned HTTP ${response.status}. Retry this source.` };
    }
    return { response };
  } catch (error) {
    return { error: error?.name === "AbortError" ? "the careers site timed out. Retry this source." : "could not reach the careers site from this machine. Retry this source." };
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url, options) {
  const { response, error } = await request(url, { headers: { accept: "text/html,application/xhtml+xml" } }, options);
  if (error) return { error };
  try { return { text: await response.text(), finalUrl: response.url || url }; } catch { return { error: "the careers site sent an unreadable page." }; }
}
async function getJson(url, options) {
  const { response, error } = await request(url, { headers: { accept: "application/json" } }, options);
  if (error) return { error };
  try { return { payload: await response.json() }; } catch { return { error: "the careers site sent unreadable data." }; }
}
async function postJson(url, body, options) {
  const { response, error } = await request(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) }, options);
  if (error) return { error };
  try { return { payload: await response.json() }; } catch { return { error: "the careers site sent unreadable data." }; }
}

function failure(source, board, error) { return { source, board, jobs: [], error }; }
function validHost(value) {
  const host = String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!HOST_RE.test(host) || /^(?:localhost|.*\.local|.*\.internal)$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host)) return "";
  return host;
}
function safeUrl(value) { try { return new URL(value); } catch { return null; } }
function isHttpUrl(value) { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } }
function iso(value) { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }
function clean(value, limit = 500) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit); }
function strings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : []; }
function decode(value) {
  return String(value || "").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
export function stripHtml(value) {
  // Some JSON-LD descriptions carry entity-encoded markup ("&lt;p&gt;").
  const source = /&lt;\/?[a-z][^&]{0,40}&gt;/i.test(String(value || "")) ? decode(value) : String(value || "");
  return decode(source
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\s*(?:br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
