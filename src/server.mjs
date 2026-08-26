import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.mjs";
import { verifyPosting } from "./verify.mjs";
import { discoverGreenhouse } from "./greenhouse.mjs";
import { profileReadiness, roleRelevance } from "./profile.mjs";
import { searchPublishedRoles } from "./search.mjs";
import { createSourceDiscovery } from "./sources.mjs";
import { resumeSummary } from "./resume.mjs";
import { tailorResume } from "./tailor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createAppServer({
  dataDir = path.join(root, "data"),
  verifyFn = verifyPosting,
  discoverFn,
  discoverSourceFn,
} = {}) {
  const store = createStore(dataDir);
  const greenhouseFn = discoverFn || discoverGreenhouse;
  const sourceDiscovery = discoverSourceFn || (discoverFn ? null : createSourceDiscovery());
  const liveVerifications = new Map();
  const discoveredJobs = new Map();

  return http.createServer(async (req, res) => {
    if (!isTrustedLocalRequest(req)) return json(res, 403, { error: "ClearLead only accepts requests from this local app." });
    if (req.method === "POST" && !/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] || ""))) {
      return json(res, 415, { error: "ClearLead mutation requests require application/json." });
    }
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/") return sendFile(res, path.join(root, "public", "index.html"), "text/html");
      if (req.method === "GET" && url.pathname === "/app.js") return sendFile(res, path.join(root, "public", "app.js"), "text/javascript");
      if (req.method === "GET" && url.pathname === "/styles.css") return sendFile(res, path.join(root, "public", "styles.css"), "text/css");
      if (req.method === "GET" && url.pathname.startsWith("/api/tailored/")) {
        const item = store.tailoredFile(url.pathname.split("/").pop());
        if (!item) return json(res, 404, { error: "Tailored draft not found." });
        return sendDownload(res, item.file, item.filename, "text/markdown");
      }
      if (req.method === "GET" && url.pathname === "/api/leads") {
        const profile = store.profile();
        const resume = resumeSummary(store.resume());
        return json(res, 200, {
          leads: store.leads(),
          profile,
          resume,
          readiness: combinedReadiness(profile, resume),
          searchConfig: store.searchConfig(),
          searchStatus: store.searchStatus(),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/verify") {
        const request = await body(req);
        const jobUrl = request.url;
        const verification = await verifyFn(jobUrl || "");
        if (verification.status !== "live") return json(res, 200, verification);
        const discovered = discoveredJobs.get(jobUrl) || {};
        const verifiedLead = {
          ...verification,
          title: shortText(discovered.title, 180),
          company: shortText(discovered.company, 100),
          location: shortText(discovered.location, 160),
          source: shortText(discovered.source, 40),
          board: shortText(discovered.board, 80),
          postedAt: isoDate(discovered.postedAt),
          firstSeenAt: isoDate(discovered.firstSeenAt),
        };
        const verificationId = rememberVerification(liveVerifications, verifiedLead, discovered);
        return json(res, 200, { ...verifiedLead, verificationId });
      }
      if (req.method === "POST" && url.pathname === "/api/leads") {
        const { verificationId } = await body(req);
        const verified = liveVerifications.get(verificationId);
        if (!verified || verified.expiresAt <= Date.now()) {
          liveVerifications.delete(verificationId);
          throw new Error("Run the live verifier again before saving this lead.");
        }
        if (verified.used.save) throw new Error("This verification was already used to save the lead. Verify again for another save action.");
        const saved = store.saveLiveLead(verified.lead);
        verified.used.save = true;
        return json(res, 200, saved);
      }
      if (req.method === "POST" && url.pathname === "/api/resume") {
        const request = await body(req);
        const resume = store.saveResume({ text: request.text, filename: request.filename });
        return json(res, 200, { ok: true, resume: resumeSummary(resume), readiness: combinedReadiness(store.profile(), resumeSummary(resume)) });
      }
      if (req.method === "POST" && url.pathname === "/api/tailor") {
        const { verificationId } = await body(req);
        const verified = liveVerifications.get(verificationId);
        if (!verified || verified.expiresAt <= Date.now() || verified.lead.status !== "live") {
          throw new Error("Verify this role again before creating a tailored resume draft.");
        }
        if (verified.used.tailor) throw new Error("This verification already created a tailored draft. Verify again to create another draft.");
        if (!verified.job?.title) throw new Error("Tailoring requires a role discovered through the ranked search pool so its source metadata is trusted.");
        const resume = store.resume();
        const draft = tailorResume(resume.text, { ...verified.job, ...verified.lead, status: "live" });
        const saved = store.saveTailoredDraft(verified.lead, draft);
        verified.used.tailor = true;
        return json(res, 200, {
          id: saved.id,
          filename: saved.filename,
          downloadUrl: saved.downloadUrl,
          createdAt: saved.createdAt,
          matchedTerms: saved.matchedTerms,
          absentTerms: saved.absentTerms,
          preview: saved.markdown.slice(0, 12_000),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/profile") {
        const profile = await body(req);
        store.saveProfile({
          targetRoles: strings(profile.targetRoles),
          locations: strings(profile.locations),
          mustHaves: strings(profile.mustHaves),
        });
        const saved = store.profile();
        return json(res, 200, { ok: true, profile: saved, readiness: combinedReadiness(saved, resumeSummary(store.resume())) });
      }
      if (req.method === "POST" && url.pathname === "/api/discover/greenhouse") {
        const { board } = await body(req);
        const discovery = await greenhouseFn(board);
        const profile = store.profile();
        return json(res, 200, {
          ...discovery,
          jobs: discovery.jobs.map((job) => ({ ...job, relevance: roleRelevance(job.title, profile) })),
          readiness: profileReadiness(profile),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/search") {
        const requested = await body(req);
        const resume = store.resume();
        if (!resumeSummary(resume).ready) return json(res, 409, { error: "Add your resume first so ClearLead can rank this search." });
        const config = store.saveSearchConfig(requested);
        const search = await searchPublishedRoles(config, {
          discoverSourceFn: sourceDiscovery,
          discoverFn: sourceDiscovery ? undefined : greenhouseFn,
          profile: store.profile(),
          resume,
        });
        if (search.outage) {
          const { allJobs: _allJobs, ...publicSearch } = search;
          return json(res, 200, { ...publicSearch, config, jobs: [], total: 0, newCount: 0 });
        }
        const annotated = store.recordSearch(search.allJobs, search.searchedAt);
        const byUrl = new Map(annotated.map((job) => [job.url, job]));
        let jobs = search.jobs.map((job) => byUrl.get(job.url));
        rememberDiscovered(discoveredJobs, annotated);
        if (config.autoVerify && config.verifyLimit > 0) {
          jobs = await autoVerify(jobs, config.verifyLimit, verifyFn, liveVerifications, discoveredJobs);
        }
        const { allJobs: _allJobs, ...publicSearch } = search;
        return json(res, 200, {
          ...publicSearch,
          config,
          jobs: jobs.map(publicJob),
          total: jobs.length,
          newCount: jobs.filter((job) => job.isNew).length,
          verifiedCount: jobs.filter((job) => job.verification?.status === "live").length,
          checkedCount: jobs.filter((job) => job.verification).length,
        });
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : "Request failed" });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const dataDir = process.env.CLEARLEAD_DATA_DIR
    ? path.resolve(process.env.CLEARLEAD_DATA_DIR)
    : path.join(root, "data");
  const server = createAppServer({ dataDir });
  server.listen(port, "127.0.0.1", () => console.log(`ClearLead listening on http://localhost:${server.address().port}`));
}

function strings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []; }
function shortText(value, limit) { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
function isoDate(value) { const time = Date.parse(value || ""); return Number.isFinite(time) ? new Date(time).toISOString() : ""; }
function isTrustedLocalRequest(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}
function rememberDiscovered(cache, jobs) {
  for (const job of jobs) {
    cache.delete(job.url);
    cache.set(job.url, job);
  }
  while (cache.size > 10_000) cache.delete(cache.keys().next().value);
}
function pruneVerifications(verifications) {
  const now = Date.now();
  for (const [id, verification] of verifications) {
    if (verification.expiresAt <= now) verifications.delete(id);
  }
}
function rememberVerification(verifications, lead, job = {}) {
  const verificationId = randomUUID();
  pruneVerifications(verifications);
  verifications.set(verificationId, { lead, job, used: { save: false, tailor: false }, expiresAt: Date.now() + 30 * 60 * 1000 });
  return verificationId;
}
export async function autoVerify(jobs, limit, verifyFn, verifications, discoveredJobs) {
  const selected = jobs.slice(0, Math.min(limit, jobs.length));
  const outcomes = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < selected.length) {
      const job = selected[cursor++];
      let verification;
      try {
        verification = await verifyFn(job.url);
      } catch {
        verification = { status: "inconclusive", url: job.url, checkedAt: new Date().toISOString(), reason: "Verifier failed unexpectedly. Retry, open the source, or discard it.", signals: [] };
      }
      const publicVerification = { ...verification };
      if (verification.status === "live") {
        const lead = {
          ...verification,
          title: shortText(job.title, 180), company: shortText(job.company, 100), location: shortText(job.location, 160),
          source: shortText(job.source, 40), board: shortText(job.board, 80), postedAt: isoDate(job.postedAt), firstSeenAt: isoDate(job.firstSeenAt),
        };
        publicVerification.verificationId = rememberVerification(verifications, lead, discoveredJobs.get(job.url) || job);
      }
      outcomes.set(job.url, publicVerification);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, selected.length) }, () => worker()));
  return jobs.map((job) => outcomes.has(job.url) ? { ...job, verification: outcomes.get(job.url), verificationStatus: outcomes.get(job.url).status } : job);
}
function publicJob(job) {
  const { description: _description, applyUrl: _applyUrl, ...visible } = job;
  return visible;
}
function combinedReadiness(profile, resume) {
  const targeting = profileReadiness(profile);
  const missing = [...(!resume.ready ? ["resume"] : []), ...targeting.missing];
  return {
    ready: resume.ready,
    missing,
    message: resume.ready
      ? targeting.ready ? "Ready — ranking uses your resume and target roles." : "Resume ready — add target roles for sharper title matching, or search now from resume evidence."
      : "Resume required — paste it below before searching the job pool.",
  };
}
function json(res, status, value) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
function sendFile(res, file, type) { res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(fs.readFileSync(file)); }
function sendDownload(res, file, filename, type) { res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "content-disposition": `attachment; filename="${filename.replace(/[^a-z0-9_.-]/gi, "-")}"` }); res.end(fs.readFileSync(file)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ""; req.on("data", (part) => { raw += part; if (raw.length > 500_000) { reject(new Error("Request body is too large.")); req.destroy(); } }); req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON")); } }); req.on("error", reject); }); }
