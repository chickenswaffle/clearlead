import http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import { createCredentialVault } from "./vault.mjs";
import { createProviderClient } from "./ai-providers.mjs";
import { buildApplicationKit } from "./ai-resume.mjs";
import { extractResumePdf } from "./pdf-resume.mjs";
import { applicationProfileReadiness } from "./application-profile.mjs";
import { createSearchPlan } from "./search-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createAppServer({
  dataDir = path.join(root, "data"),
  verifyFn = verifyPosting,
  discoverFn,
  discoverSourceFn,
  aiClient = createProviderClient(),
  extractPdfFn = extractResumePdf,
} = {}) {
  const store = createStore(dataDir);
  const vault = createCredentialVault(dataDir);
  const greenhouseFn = discoverFn || discoverGreenhouse;
  const sourceDiscovery = discoverSourceFn || (discoverFn ? null : createSourceDiscovery());
  const liveVerifications = new Map();
  const discoveredJobs = new Map();
  const aiConsents = new Map();
  let currentAutofillPack = null;

  async function executeSearch(requested, plan = null) {
    const resume = store.resume();
    if (!resumeSummary(resume).ready) return { status: 409, payload: { error: "Add your resume first so ClearLead can rank this search." } };
    const config = store.saveSearchConfig(requested);
    const search = await searchPublishedRoles({ ...config, ...(plan ? { plan } : {}) }, {
      discoverSourceFn: sourceDiscovery,
      discoverFn: sourceDiscovery ? undefined : greenhouseFn,
      profile: store.profile(),
      resume,
    });
    if (search.outage) {
      const { allJobs: _allJobs, ...publicSearch } = search;
      return { status: 200, payload: { ...publicSearch, config, ...(plan ? { plan } : {}), jobs: [], total: 0, newCount: 0 } };
    }
    const annotated = store.recordSearch(search.allJobs, search.searchedAt);
    const byUrl = new Map(annotated.map((job) => [job.url, job]));
    let jobs = search.jobs.map((job) => byUrl.get(job.url)).filter(Boolean);
    rememberDiscovered(discoveredJobs, annotated);
    if (config.autoVerify && config.verifyLimit > 0) {
      jobs = await autoVerify(jobs, config.verifyLimit, verifyFn, liveVerifications, discoveredJobs);
      jobs.sort((left, right) => verificationPriority(left) - verificationPriority(right) || (right.match?.score || 0) - (left.match?.score || 0));
    }
    const { allJobs: _allJobs, ...publicSearch } = search;
    return {
      status: 200,
      payload: {
        ...publicSearch,
        config,
        ...(plan ? { plan } : {}),
        jobs: jobs.map(publicJob),
        total: jobs.length,
        newCount: jobs.filter((job) => job.isNew).length,
        verifiedCount: jobs.filter((job) => job.verification?.status === "live").length,
        checkedCount: jobs.filter((job) => job.verification).length,
      },
    };
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const extensionSessionApi = url.pathname === "/api/extension/session";
    const extensionPackApi = url.pathname === "/api/extension/pack";
    const extensionApi = extensionSessionApi || extensionPackApi;
    const extensionRequestOrigin = extensionOrigin(req);
    if (extensionRequestOrigin) res.setHeader("access-control-allow-origin", extensionRequestOrigin);
    if (req.method === "OPTIONS" && extensionApi && extensionRequestOrigin) {
      res.writeHead(204, { "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600" });
      return res.end();
    }
    if (extensionApi) {
      if (!extensionRequestOrigin || !isLocalHost(req)) return json(res, 401, { error: "Pair the ClearLead extension again from the local app." });
      if (extensionSessionApi) {
        const pairing = store.extensionPairing();
        if (!validExtensionToken(req, pairing, extensionRequestOrigin)) return json(res, 401, { error: "Pair the ClearLead extension again from the local app." });
        if (!pairing.extensionOrigin) store.saveExtensionPairing({ ...pairing, extensionOrigin: extensionRequestOrigin });
      } else if (!validPackCapability(req, currentAutofillPack, extensionRequestOrigin)) return json(res, 401, { error: "Your autofill session expired. Prepare the job again in ClearLead." });
    } else if (!isTrustedLocalRequest(req)) return json(res, 403, { error: "ClearLead only accepts requests from this local app." });
    const isPdfUpload = req.method === "POST" && url.pathname === "/api/resume/pdf";
    if (req.method === "POST" && !isPdfUpload && !/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] || ""))) {
      return json(res, 415, { error: "ClearLead mutation requests require application/json." });
    }
    try {
      if (req.method === "GET" && url.pathname === "/") return sendFile(res, path.join(root, "public", "index.html"), "text/html");
      if (req.method === "GET" && url.pathname === "/app.js") return sendFile(res, path.join(root, "public", "app.js"), "text/javascript");
      if (req.method === "GET" && url.pathname === "/styles.css") return sendFile(res, path.join(root, "public", "styles.css"), "text/css");
      if (req.method === "GET" && url.pathname.startsWith("/api/tailored/")) {
        const item = store.tailoredFile(url.pathname.split("/").pop());
        if (!item) return json(res, 404, { error: "Tailored draft not found." });
        return sendDownload(res, item.file, item.filename, "text/markdown");
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/kits/")) {
        const [, , , id, artifact] = url.pathname.split("/");
        const item = store.applicationKitFile(id, artifact);
        if (!item) return json(res, 404, { error: "Application-kit artifact not found." });
        return sendDownload(res, item.file, item.filename, item.type);
      }
      if (req.method === "GET" && url.pathname === "/api/ai") {
        return json(res, 200, { ...vault.status(), privacy: "Your key stays server-side. Resume data is sent only when you explicitly build an AI application kit." });
      }
      if (req.method === "GET" && url.pathname === "/api/leads") {
        const profile = store.profile();
        const resume = resumeSummary(store.resume());
        const applicationProfile = store.applicationProfile();
        return json(res, 200, {
          leads: store.leads(),
          profile,
          resume,
          readiness: combinedReadiness(profile, resume),
          searchConfig: store.searchConfig(),
          searchStatus: store.searchStatus(),
          applicationProfile,
          applicationReadiness: applicationProfileReadiness(applicationProfile),
          extensionPaired: activePairing(store.extensionPairing()),
          autofillPack: currentAutofillPack ? publicAutofillPack(currentAutofillPack) : null,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/application-profile") {
        const applicationProfile = store.applicationProfile();
        return json(res, 200, { applicationProfile, readiness: applicationProfileReadiness(applicationProfile) });
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
      if (isPdfUpload) {
        if (!/^application\/pdf(?:;|$)/i.test(String(req.headers["content-type"] || ""))) return json(res, 415, { error: "Resume PDF uploads require application/pdf." });
        const extracted = await extractPdfFn(await binaryBody(req, 10 * 1024 * 1024));
        return json(res, 200, { ...extracted, persisted: false, message: `Extracted ${extracted.pageCount} page${extracted.pageCount === 1 ? "" : "s"}. Review the text before indexing it locally.` });
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
      if (req.method === "POST" && url.pathname === "/api/ai/provider") {
        const request = await body(req);
        const status = vault.save({ provider: request.provider, model: request.model, apiKey: request.apiKey });
        return json(res, 200, { ...status, message: "Provider saved in the local encrypted vault. No resume data was sent." });
      }
      if (req.method === "POST" && url.pathname === "/api/ai/test") {
        const secret = vault.load();
        if (!secret) throw new Error("Save a provider key before testing the connection.");
        return json(res, 200, await aiClient.testConnection(secret));
      }
      if (req.method === "POST" && url.pathname === "/api/ai/provider/remove") {
        return json(res, 200, { ...vault.remove(), message: "The encrypted provider credential was removed from ClearLead." });
      }
      if (req.method === "POST" && url.pathname === "/api/ai/consent") {
        const { verificationId } = await body(req);
        const verified = liveVerifications.get(verificationId);
        if (!verified || verified.expiresAt <= Date.now() || verified.lead.status !== "live" || !verified.job?.title) throw new Error("Verify this ranked role again before authorizing an AI application kit.");
        const secret = vault.load();
        if (!secret) throw new Error("Configure OpenRouter, OpenAI, or Anthropic before building an AI application kit.");
        const resume = store.resume();
        if (!resumeSummary(resume).ready) throw new Error("Add a complete resume before authorizing an AI application kit.");
        pruneAiConsents(aiConsents);
        const consentId = randomUUID();
        aiConsents.set(consentId, {
          verificationId,
          provider: secret.provider,
          model: secret.model,
          providerSavedAt: secret.savedAt,
          resumeSavedAt: resume.savedAt,
          jobUrl: verified.lead.finalUrl || verified.lead.url,
          state: "ready",
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
        return json(res, 200, { consentId, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), provider: secret.provider, model: secret.model, resumeSavedAt: resume.savedAt, jobUrl: verified.lead.finalUrl || verified.lead.url });
      }
      if (req.method === "POST" && url.pathname === "/api/ai/kit") {
        const { verificationId, consentId } = await body(req);
        const verified = liveVerifications.get(verificationId);
        if (!verified || verified.expiresAt <= Date.now() || verified.lead.status !== "live") {
          throw new Error("Verify this role again before building an AI application kit.");
        }
        if (verified.used.aiKit) throw new Error("This verification is already building or built an AI kit. Verify again to create another model draft.");
        if (!verified.job?.title) throw new Error("AI kits require a role discovered through the ranked search pool.");
        const secret = vault.load();
        if (!secret) throw new Error("Configure OpenRouter, OpenAI, or Anthropic before building an AI application kit.");
        const resume = store.resume();
        const consent = aiConsents.get(consentId);
        const jobUrl = verified.lead.finalUrl || verified.lead.url;
        if (!consent || consent.expiresAt <= Date.now() || consent.state !== "ready" || consent.verificationId !== verificationId || consent.provider !== secret.provider || consent.model !== secret.model || consent.providerSavedAt !== secret.savedAt || consent.resumeSavedAt !== resume.savedAt || consent.jobUrl !== jobUrl) {
          throw new Error("The AI authorization is missing, expired, or no longer matches this provider, resume, and verified job. Confirm the send again.");
        }
        consent.state = "in_progress";
        verified.used.aiKit = "in_progress";
        const job = { ...verified.job, ...verified.lead, status: "live" };
        try {
          const kit = await buildApplicationKit({ resumeText: resume.text, job, generateText: (request) => aiClient.generate(secret, request) });
          const saved = store.saveApplicationKit(job, kit);
          consent.state = "used";
          verified.used.aiKit = true;
          return json(res, 200, { id: saved.id, createdAt: saved.createdAt, provider: secret.provider, model: secret.model, preview: saved.preview, matchedTerms: saved.matchedTerms, gaps: saved.gaps, audit: saved.audit, downloads: Object.fromEntries(Object.entries(saved.files).map(([name, item]) => [name, item.downloadUrl])) });
        } catch (error) {
          if (consent.state === "in_progress") consent.state = "ready";
          if (verified.used.aiKit === "in_progress") verified.used.aiKit = false;
          throw error;
        }
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
      if (req.method === "POST" && url.pathname === "/api/application-profile") {
        const applicationProfile = store.saveApplicationProfile(await body(req));
        currentAutofillPack = null;
        return json(res, 200, { ok: true, applicationProfile, readiness: applicationProfileReadiness(applicationProfile) });
      }
      if (req.method === "POST" && url.pathname === "/api/extension/pair") {
        const token = randomBytes(32).toString("base64url");
        const pairedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        store.saveExtensionPairing({ tokenHash: hashToken(token), pairedAt, expiresAt, extensionOrigin: "" });
        return json(res, 200, { token, pairedAt, expiresAt, extensionPath: path.join(root, "extension"), message: "A new pairing token was created. Any older extension token is now invalid." });
      }
      if (req.method === "POST" && url.pathname === "/api/application/prepare") {
        const { verificationId } = await body(req);
        const verified = liveVerifications.get(verificationId);
        if (!verified || verified.expiresAt <= Date.now() || verified.lead.status !== "live" || !verified.job?.title) throw new Error("Verify this ranked role again before preparing autofill.");
        const applicationProfile = store.applicationProfile();
        const readiness = applicationProfileReadiness(applicationProfile);
        if (!readiness.ready) throw new Error(readiness.message);
        currentAutofillPack = createAutofillPack({ verified, applicationProfile });
        return json(res, 200, publicAutofillPack(currentAutofillPack));
      }
      if (req.method === "GET" && url.pathname === "/api/extension/session") {
        if (!currentAutofillPack || currentAutofillPack.expiresAt <= Date.now()) return json(res, 200, { paired: true, packReady: false });
        const capability = randomBytes(32).toString("base64url");
        currentAutofillPack.capabilityHash = hashToken(capability);
        currentAutofillPack.capabilityOrigin = extensionRequestOrigin;
        return json(res, 200, { paired: true, packReady: true, capability, expiresAt: new Date(currentAutofillPack.expiresAt).toISOString(), job: currentAutofillPack.job });
      }
      if (req.method === "GET" && url.pathname === "/api/extension/pack") {
        if (!currentAutofillPack || currentAutofillPack.expiresAt <= Date.now()) return json(res, 404, { error: "No current autofill pack. Prepare one from a verified job in ClearLead." });
        const { capabilityHash: _capabilityHash, capabilityOrigin: _capabilityOrigin, ...pack } = currentAutofillPack;
        return json(res, 200, pack);
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
        const outcome = await executeSearch(requested);
        return json(res, outcome.status, outcome.payload);
      }
      if (req.method === "POST" && url.pathname === "/api/search/smart") {
        const request = await body(req);
        const resume = store.resume();
        if (!resumeSummary(resume).ready) return json(res, 409, { error: "Add your resume first so ClearLead can rank this search." });
        const prompt = shortText(request.prompt, 500);
        if (!prompt) return json(res, 400, { error: "Type the kind of job you want first." });
        let secret = null;
        if (request.useAI === true) {
          try { secret = vault.load(); }
          catch { secret = null; }
        }
        const plan = await createSearchPlan(prompt, {
          resume: resumeSummary(resume),
          profile: store.profile(),
          generateText: secret ? (payload) => aiClient.generate(secret, payload) : undefined,
        });
        const previous = store.searchConfig();
        const advanced = request.advanced && typeof request.advanced === "object" ? request.advanced : {};
        const requested = {
          ...previous,
          ...plan.searchConfig,
          ...advanced,
          broadFeeds: ["jobledger", ...strings(advanced.broadFeeds || previous.broadFeeds)].filter((value, index, values) => values.indexOf(value) === index),
          autoVerify: request.autoVerify !== false,
          verifyLimit: Number(request.verifyLimit || previous.verifyLimit || 8),
        };
        const outcome = await executeSearch(requested, plan);
        return json(res, outcome.status, outcome.payload);
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
  if (!isLocalHost(req)) return false;
  const host = String(req.headers.host || "").toLowerCase();
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}
function isLocalHost(req) { return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || "").toLowerCase()); }
function extensionOrigin(req) {
  const origin = String(req.headers.origin || "");
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : "";
}
function hashToken(value) { return createHash("sha256").update(String(value || "")).digest("hex"); }
function activePairing(pairing) { return Boolean(pairing?.tokenHash) && Date.parse(pairing?.expiresAt || "") > Date.now(); }
function validExtensionToken(req, pairing, origin) {
  const supplied = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const expected = String(pairing?.tokenHash || "");
  if (!activePairing(pairing) || !supplied || !/^[a-f0-9]{64}$/.test(expected)) return false;
  if (pairing.extensionOrigin && pairing.extensionOrigin !== origin) return false;
  const actualBuffer = Buffer.from(hashToken(supplied), "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
function validPackCapability(req, pack, origin) {
  if (!pack || pack.expiresAt <= Date.now() || pack.capabilityOrigin !== origin) return false;
  const supplied = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const expected = String(pack.capabilityHash || "");
  if (!supplied || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const actualBuffer = Buffer.from(hashToken(supplied), "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
function createAutofillPack({ verified, applicationProfile }) {
  const job = { ...verified.job, ...verified.lead };
  const verifiedUrl = new URL(verified.lead.finalUrl || verified.lead.url);
  if (verifiedUrl.protocol !== "https:") throw new Error("Autofill requires a verified HTTPS application page.");
  verifiedUrl.hash = "";
  const applicationUrl = verifiedUrl.toString();
  const allowedPages = [`${verifiedUrl.origin}${normalizedPath(verifiedUrl.pathname)}${verifiedUrl.search}`];
  const safeProfile = Object.fromEntries([
    "fullName", "firstName", "lastName", "email", "phone", "location", "city", "state", "postalCode", "country",
    "linkedinUrl", "githubUrl", "portfolioUrl",
  ].map((key) => [key, applicationProfile[key] || ""]));
  return {
    id: randomUUID(),
    preparedAt: new Date().toISOString(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    job: { title: job.title, company: job.company, location: job.location, source: job.source, url: job.url, finalUrl: job.finalUrl, applicationUrl, checkedAt: job.checkedAt, reason: job.reason },
    allowedPages,
    profile: safeProfile,
    policy: { submit: "never", safe: ["name", "email", "phone", "location", "public profile links"], review: ["work authorization", "sponsorship", "salary", "relocation", "free-text answers", "checkboxes", "radio buttons"], blocked: ["EEO/demographic", "disability", "veteran status", "race/ethnicity", "gender", "date of birth", "SSN", "legal attestations"] },
  };
}
function publicAutofillPack(pack) {
  return { id: pack.id, preparedAt: pack.preparedAt, expiresAt: new Date(pack.expiresAt).toISOString(), job: pack.job, allowedPages: pack.allowedPages, policy: pack.policy };
}
function normalizedPath(value) { const pathValue = String(value || "/").replace(/\/{2,}/g, "/"); return pathValue.length > 1 ? pathValue.replace(/\/+$/, "") : "/"; }
function rememberDiscovered(cache, jobs) {
  for (const job of jobs) {
    cache.delete(job.url);
    cache.set(job.url, job);
    if (applicationTarget(job) !== job.url) {
      cache.delete(job.applyUrl);
      cache.set(job.applyUrl, job);
    }
  }
  while (cache.size > 10_000) cache.delete(cache.keys().next().value);
}
function pruneVerifications(verifications) {
  const now = Date.now();
  for (const [id, verification] of verifications) {
    if (verification.expiresAt <= now) verifications.delete(id);
  }
}
function pruneAiConsents(consents) {
  const now = Date.now();
  for (const [id, consent] of consents) if (consent.expiresAt <= now || consent.state === "used") consents.delete(id);
  while (consents.size > 2_000) consents.delete(consents.keys().next().value);
}
function rememberVerification(verifications, lead, job = {}) {
  const verificationId = randomUUID();
  pruneVerifications(verifications);
  verifications.set(verificationId, { lead, job, used: { save: false, tailor: false, aiKit: false }, expiresAt: Date.now() + 30 * 60 * 1000 });
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
        verification = await verifyFn(applicationTarget(job));
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
  return {
    ...job,
    description: shortText(job.description, 24_000),
    applyUrl: applicationTarget(job) !== job.url ? applicationTarget(job) : "",
  };
}
function applicationTarget(job) {
  try { return new URL(job.applyUrl).protocol === "https:" ? job.applyUrl : job.url; }
  catch { return job.url; }
}
function verificationPriority(job) {
  return ({ live: 0, unverified: 1, inconclusive: 2, blocked: 3, closed: 4 })[job.verificationStatus || "unverified"] ?? 2;
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
function json(res, status, value) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
function sendFile(res, file, type) { res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(fs.readFileSync(file)); }
function sendDownload(res, file, filename, type) { res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "content-disposition": `attachment; filename="${filename.replace(/[^a-z0-9_.-]/gi, "-")}"` }); res.end(fs.readFileSync(file)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ""; req.on("data", (part) => { raw += part; if (raw.length > 500_000) { reject(new Error("Request body is too large.")); req.destroy(); } }); req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON")); } }); req.on("error", reject); }); }
function binaryBody(req, limit) { return new Promise((resolve, reject) => { const chunks = []; let size = 0; let tooLarge = false; req.on("data", (part) => { size += part.length; if (size > limit) { tooLarge = true; chunks.length = 0; } else if (!tooLarge) chunks.push(part); }); req.on("end", () => tooLarge ? reject(new Error(`Resume PDF is too large. Use a file under ${Math.floor(limit / 1024 / 1024)} MB.`)) : resolve(Buffer.concat(chunks))); req.on("error", reject); }); }
