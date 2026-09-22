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
import { createResumePdf } from "./resume-pdf.mjs";
import { applicationProfileReadiness } from "./application-profile.mjs";
import { createSearchPlan } from "./search-plan.mjs";
import { formatReadiness, runtimeReadiness } from "./doctor.mjs";
import { browserVerificationFromEvidence } from "./browser-verification.mjs";
import { candidateTruthSummary } from "./candidate-truth.mjs";
import { createResumeDocx, docxMimeType } from "./resume-docx.mjs";

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
  const runtime = runtimeReadiness({ rootDir: root });
  let currentAutofillPack = null;
  let latestBrowserVerification = null;

  async function executeSearch(requested, plan = null) {
    const resume = store.resume();
    if (!resumeSummary(resume).ready) return { status: 409, payload: { error: "Add your resume first so ClearLead can rank this search." } };
    const config = store.saveSearchConfig(requested);
    const search = await searchPublishedRoles({ ...config, ...(plan ? { plan } : {}) }, {
      discoverSourceFn: sourceDiscovery,
      discoverFn: sourceDiscovery ? undefined : greenhouseFn,
      profile: store.profile(),
      resume,
      applicationProfile: store.applicationProfile(),
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
    setSecurityHeaders(res);
    const url = new URL(req.url, "http://127.0.0.1");
    const extensionSessionApi = url.pathname === "/api/extension/session";
    const extensionPackApi = url.pathname === "/api/extension/pack";
    const extensionVerifyApi = url.pathname === "/api/extension/verify";
    const extensionTransitionApi = url.pathname === "/api/extension/transition";
    const extensionRunApi = url.pathname === "/api/extension/run";
    const extensionTokenApi = extensionSessionApi || extensionVerifyApi || extensionTransitionApi;
    const extensionCapabilityApi = extensionPackApi || extensionRunApi;
    const extensionApi = extensionTokenApi || extensionCapabilityApi;
    const extensionRequestOrigin = extensionOrigin(req);
    if (extensionRequestOrigin) res.setHeader("access-control-allow-origin", extensionRequestOrigin);
    if (req.method === "OPTIONS" && extensionApi && extensionRequestOrigin) {
      res.writeHead(204, { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600" });
      return res.end();
    }
    if (extensionApi) {
      if (!extensionRequestOrigin || !isLocalHost(req)) return json(res, 401, { error: "Pair the ClearLead extension again from the local app." });
      if (extensionTokenApi) {
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
      const tailoredPdfRoute = url.pathname.match(/^\/api\/tailored\/([a-f0-9-]{36})\/pdf$/i);
      const tailoredDocxRoute = url.pathname.match(/^\/api\/tailored\/([a-f0-9-]{36})\/docx$/i);
      const tailoredDefaultRoute = url.pathname.match(/^\/api\/tailored\/([a-f0-9-]{36})\/default$/i);
      const kitResumePdfRoute = url.pathname.match(/^\/api\/kits\/([a-f0-9-]{36})\/resume\/pdf$/i);
      const kitResumeDocxRoute = url.pathname.match(/^\/api\/kits\/([a-f0-9-]{36})\/resume\/docx$/i);
      const resumeApplicationRoute = url.pathname.match(/^\/api\/application\/runs\/([a-f0-9-]{36})\/resume$/i);
      if (req.method === "GET" && tailoredPdfRoute) {
        const item = store.tailoredFile(tailoredPdfRoute[1]);
        if (!item) return json(res, 404, { error: "Tailored draft not found." });
        const contents = fs.readFileSync(item.file, "utf8");
        const filename = downloadFilename(url.searchParams.get("name"), item.filename, "pdf");
        const pdf = await createResumePdf(contents, { title: `${item.title || "Tailored resume"} resume`, author: store.applicationProfile().fullName || "" });
        return sendBufferDownload(res, pdf, filename, "application/pdf");
      }
      if (req.method === "GET" && tailoredDocxRoute) {
        const item = store.tailoredFile(tailoredDocxRoute[1]);
        if (!item) return json(res, 404, { error: "Tailored draft not found." });
        const filename = downloadFilename(url.searchParams.get("name"), item.filename, "docx");
        const document = createResumeDocx(fs.readFileSync(item.file, "utf8"), { title: `${item.title || "Tailored resume"} resume`, author: store.applicationProfile().fullName || "" });
        return sendBufferDownload(res, document, filename, docxMimeType());
      }
      if (req.method === "POST" && tailoredDefaultRoute) {
        const request = await body(req);
        const item = store.tailoredFile(tailoredDefaultRoute[1]);
        if (!item) return json(res, 404, { error: "Tailored draft not found." });
        const filename = downloadFilename(request.filename, item.filename, "md");
        const savedDefault = store.saveResumeAsDefault({ text: fs.readFileSync(item.file, "utf8"), filename });
        const resume = savedDefault.resume;
        return json(res, 200, {
          ok: true,
          resume: resumeSummary(resume),
          readiness: combinedReadiness(store.profile(), resumeSummary(resume)),
          undoId: savedDefault.undoId,
          message: `${filename} is now your local default resume. Future searches and tailored drafts will start from it.`,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/resume/default/restore") {
        const request = await body(req);
        const resume = store.restoreResumeBackup(request.undoId);
        return json(res, 200, {
          ok: true,
          resume: resumeSummary(resume),
          readiness: combinedReadiness(store.profile(), resumeSummary(resume)),
          message: `${resume.filename} was restored as your default resume.`,
        });
      }
      if (req.method === "GET" && /^\/api\/tailored\/[a-f0-9-]{36}$/i.test(url.pathname)) {
        const item = store.tailoredFile(url.pathname.split("/").pop());
        if (!item) return json(res, 404, { error: "Tailored draft not found." });
        return sendDownload(res, item.file, downloadFilename(url.searchParams.get("name"), item.filename, "md"), "text/markdown");
      }
      if (req.method === "GET" && kitResumePdfRoute) {
        const item = store.applicationKitFile(kitResumePdfRoute[1], "resume");
        if (!item) return json(res, 404, { error: "AI resume draft not found." });
        const filename = downloadFilename(url.searchParams.get("name"), item.filename, "pdf");
        const pdf = await createResumePdf(fs.readFileSync(item.file, "utf8"), { title: `${item.title || "Tailored resume"} resume`, author: store.applicationProfile().fullName || "" });
        return sendBufferDownload(res, pdf, filename, "application/pdf");
      }
      if (req.method === "GET" && kitResumeDocxRoute) {
        const item = store.applicationKitFile(kitResumeDocxRoute[1], "resume");
        if (!item) return json(res, 404, { error: "AI resume draft not found." });
        const filename = downloadFilename(url.searchParams.get("name"), item.filename, "docx");
        const document = createResumeDocx(fs.readFileSync(item.file, "utf8"), { title: `${item.title || "Tailored resume"} resume`, author: store.applicationProfile().fullName || "" });
        return sendBufferDownload(res, document, filename, docxMimeType());
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/kits/")) {
        const [, , , id, artifact] = url.pathname.split("/");
        const item = store.applicationKitFile(id, artifact);
        if (!item) return json(res, 404, { error: "Application-kit artifact not found." });
        return sendDownload(res, item.file, item.filename, item.type);
      }
      if (req.method === "GET" && url.pathname === "/api/ai") {
        return json(res, 200, { ...vault.status(), privacy: "Your key stays server-side. AI search is opt-in and sends only a compact skills/title index. Your full resume is sent only when you explicitly build an AI application kit." });
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
          candidateTruth: candidateTruthSummary(store.candidateTruth()),
          applicationReadiness: applicationProfileReadiness(applicationProfile),
          extensionPaired: activePairing(store.extensionPairing()),
          autofillPack: currentAutofillPack ? publicAutofillPack(currentAutofillPack) : null,
          applicationRuns: store.applicationRuns(),
          runtime,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/application-profile") {
        const applicationProfile = store.applicationProfile();
        return json(res, 200, { applicationProfile, readiness: applicationProfileReadiness(applicationProfile) });
      }
      if (req.method === "POST" && resumeApplicationRoute) {
        const run = store.applicationRun(resumeApplicationRoute[1]);
        if (!run) return json(res, 404, { error: "That application run is unavailable. Prepare the job again." });
        if (run.status === "complete") throw new Error("That application is already complete and cannot be resumed.");
        const applicationUrl = run.job?.applicationUrl;
        if (!applicationUrl) throw new Error("This older application run has no verified application URL. Verify the role again.");
        const postingUrl = run.job?.postingUrl || run.job?.url || applicationUrl;
        const verification = normalizeVerification(await verifyFn(postingUrl), postingUrl);
        if (verification.status !== "live") throw new Error(`The employer page could not be revalidated: ${verification.reason || verification.status}. Verify the role again before continuing.`);
        const applicationProfile = store.applicationProfile();
        const readiness = applicationProfileReadiness(applicationProfile);
        if (!readiness.ready) throw new Error(readiness.message);
        const resumeDraft = restoreApplicationResume(store, run);
        currentAutofillPack = createAutofillPack({
          verified: { job: run.job, lead: { ...verification, title: run.job.title, company: run.job.company, location: run.job.location, source: run.job.source } },
          applicationProfile,
          resumeDraft,
          candidateTruth: store.candidateTruth(),
          runId: run.id,
          applicationUrlOverride: applicationUrl,
        });
        const resumed = store.resumeApplicationRun(run.id, currentAutofillPack);
        return json(res, 200, { ...publicAutofillPack(currentAutofillPack), run: resumed });
      }
      if (req.method === "GET" && url.pathname === "/api/browser-verification") {
        if (!latestBrowserVerification || latestBrowserVerification.expiresAt <= Date.now()) {
          latestBrowserVerification = null;
          return json(res, 200, { verification: null });
        }
        return json(res, 200, { verification: latestBrowserVerification.outcome });
      }
      if (req.method === "POST" && url.pathname === "/api/verify") {
        const request = await body(req);
        const jobUrl = request.url;
        const verification = normalizeVerification(await verifyFn(jobUrl || ""), jobUrl || "");
        if (verification.status !== "live") return json(res, 200, verification);
        const discovered = findDiscoveredJob(discoveredJobs, jobUrl);
        const verifiedLead = {
          ...verification,
          title: shortText(discovered.title, 180),
          company: shortText(discovered.company, 100),
          location: shortText(discovered.location, 160),
          source: shortText(discovered.source, 40) || "pasted",
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
        if (verified.tailoredDraft) return json(res, 200, verified.tailoredDraft);
        if (!verified.job?.title) throw new Error("Tailoring requires a role discovered through the ranked search pool so its source metadata is trusted.");
        const resume = store.resume();
        const draft = tailorResume(resume.text, { ...verified.job, ...verified.lead, status: "live" }, { identity: store.applicationProfile(), profile: store.profile() });
        const saved = store.saveTailoredDraft(verified.lead, draft);
        verified.used.tailor = true;
        verified.tailoredDraft = {
          id: saved.id,
          filename: saved.filename,
          downloadUrl: saved.downloadUrl,
          pdfUrl: `/api/tailored/${saved.id}/pdf`,
          docxUrl: `/api/tailored/${saved.id}/docx`,
          createdAt: saved.createdAt,
          title: saved.title,
          company: saved.company,
          matchedTerms: saved.matchedTerms,
          absentTerms: saved.absentTerms,
          groundingNotes: saved.groundingNotes,
          requirementMatrix: saved.requirementMatrix,
          changes: saved.changes,
          tailoringAudit: saved.tailoringAudit,
          preview: saved.markdown,
        };
        return json(res, 200, verified.tailoredDraft);
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
          const kit = await buildApplicationKit({ resumeText: resume.text, job, profile: store.profile(), applicationProfile: store.applicationProfile(), generateText: (request) => aiClient.generate(secret, request) });
          const saved = store.saveApplicationKit(job, kit);
          consent.state = "used";
          verified.used.aiKit = true;
          return json(res, 200, {
            id: saved.id,
            createdAt: saved.createdAt,
            title: saved.title,
            company: saved.company,
            provider: secret.provider,
            model: secret.model,
            preview: saved.preview,
            matchedTerms: saved.matchedTerms,
            gaps: saved.gaps,
            requirementMatrix: saved.requirementMatrix,
            audit: saved.audit,
            pdfUrl: `/api/kits/${saved.id}/resume/pdf`,
            docxUrl: `/api/kits/${saved.id}/resume/docx`,
            downloads: Object.fromEntries(Object.entries(saved.files).map(([name, item]) => [name, item.downloadUrl])),
          });
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
          preferences: strings(profile.preferences),
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
        const { verificationId, draftId, kitId, filename } = await body(req);
        const verified = liveVerifications.get(verificationId);
        if (!verified || verified.expiresAt <= Date.now() || verified.lead.status !== "live" || !verified.job?.title) throw new Error("Verify this ranked role again before preparing autofill.");
        const applicationProfile = store.applicationProfile();
        const readiness = applicationProfileReadiness(applicationProfile);
        if (!readiness.ready) throw new Error(readiness.message);
        let resumeDraft = null;
        const verifiedJobUrl = verified.lead.finalUrl || verified.lead.url;
        if (draftId && kitId) throw new Error("Choose one tailored resume version for this application.");
        if (draftId) {
          const tailored = store.tailoredFile(draftId);
          if (!tailored) throw new Error("The selected tailored resume is no longer available. Build it again before applying.");
          if (!sameJobUrl(tailored.jobUrl, verifiedJobUrl)) throw new Error("That tailored resume belongs to a different job. Build or select the version for this verified role.");
          resumeDraft = {
            draftId,
            filename: downloadFilename(filename, tailored.filename, "pdf"),
            pdfUrl: `/api/tailored/${draftId}/pdf?name=${encodeURIComponent(downloadFilename(filename, tailored.filename, "pdf").replace(/\.pdf$/i, ""))}`,
          };
        } else if (kitId) {
          const tailored = store.applicationKitFile(kitId, "resume");
          if (!tailored) throw new Error("The selected AI resume is no longer available. Build it again before applying.");
          if (!sameJobUrl(tailored.jobUrl, verifiedJobUrl)) throw new Error("That AI resume belongs to a different job. Build or select the version for this verified role.");
          resumeDraft = {
            kitId,
            filename: downloadFilename(filename, tailored.filename, "pdf"),
            pdfUrl: `/api/kits/${kitId}/resume/pdf?name=${encodeURIComponent(downloadFilename(filename, tailored.filename, "pdf").replace(/\.pdf$/i, ""))}`,
          };
        }
        currentAutofillPack = createAutofillPack({ verified, applicationProfile, resumeDraft, candidateTruth: store.candidateTruth() });
        const run = store.startApplicationRun(currentAutofillPack);
        return json(res, 200, { ...publicAutofillPack(currentAutofillPack), run });
      }
      if (req.method === "GET" && url.pathname === "/api/extension/session") {
        if (!currentAutofillPack || currentAutofillPack.expiresAt <= Date.now()) return json(res, 200, { paired: true, packReady: false });
        const capability = randomBytes(32).toString("base64url");
        currentAutofillPack.capabilityHash = hashToken(capability);
        currentAutofillPack.capabilityOrigin = extensionRequestOrigin;
        return json(res, 200, { paired: true, packReady: true, capability, runId: currentAutofillPack.id, expiresAt: new Date(currentAutofillPack.expiresAt).toISOString(), job: currentAutofillPack.job, handoff: currentAutofillPack.handoff });
      }
      if (req.method === "GET" && url.pathname === "/api/extension/pack") {
        if (!currentAutofillPack || currentAutofillPack.expiresAt <= Date.now()) return json(res, 404, { error: "No current autofill pack. Prepare one from a verified job in ClearLead." });
        const { capabilityHash: _capabilityHash, capabilityOrigin: _capabilityOrigin, ...pack } = currentAutofillPack;
        return json(res, 200, pack);
      }
      if (req.method === "POST" && url.pathname === "/api/extension/run") {
        const request = await body(req);
        if (!currentAutofillPack || request.runId !== currentAutofillPack.id) throw new Error("That application run is no longer the active autofill session.");
        const run = store.recordApplicationRunReport(request.runId, request);
        return json(res, 200, { run });
      }
      if (req.method === "POST" && url.pathname === "/api/extension/transition") {
        const request = await body(req);
        const bound = bindApplicationTransition(currentAutofillPack, request);
        currentAutofillPack = bound.pack;
        const run = store.bindApplicationRunTransition(currentAutofillPack.id, currentAutofillPack, bound.evidence);
        return json(res, 200, { ...publicAutofillPack(currentAutofillPack), run, message: "This application form is now bound to the prepared job. Review the page, then fill safe fields." });
      }
      if (req.method === "POST" && url.pathname === "/api/extension/verify") {
        const request = await body(req);
        const job = findDiscoveredJob(discoveredJobs, request.pageUrl);
        const verification = browserVerificationFromEvidence(request, { job });
        if (!verification.finalUrl) return json(res, 400, { status: verification.status, error: verification.reason });
        const publicVerification = { ...verification, captureId: randomUUID() };
        if (verification.status === "live") {
          const verificationId = rememberVerification(liveVerifications, verification, job);
          publicVerification.verificationId = verificationId;
        }
        latestBrowserVerification = { outcome: publicVerification, expiresAt: Date.now() + 30 * 60 * 1000 };
        return json(res, 200, publicVerification);
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
        const customSources = Boolean(request.advanced && typeof request.advanced === "object");
        const requested = {
          ...previous,
          ...plan.searchConfig,
          ...advanced,
          smartPrompt: prompt,
          greenhouseBoards: customSources ? strings(advanced.greenhouseBoards || advanced.boards) : [],
          leverSites: customSources ? strings(advanced.leverSites) : [],
          ashbyBoards: customSources ? strings(advanced.ashbyBoards) : [],
          broadFeeds: ["jobledger", "ziprecruiter", ...strings(customSources ? advanced.broadFeeds : ["remotive"])].filter((value, index, values) => values.indexOf(value) === index),
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
  const runtime = runtimeReadiness({ rootDir: root });
  if (!runtime.coreReady) {
    console.error(formatReadiness(runtime));
    process.exitCode = 1;
  } else {
    if (!runtime.ready) console.warn(formatReadiness(runtime));
    const server = createAppServer({ dataDir });
    server.listen(port, "127.0.0.1", () => console.log(`ClearLead listening on http://localhost:${server.address().port}`));
  }
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
function createAutofillPack({ verified, applicationProfile, resumeDraft = null, candidateTruth = null, runId = null, applicationUrlOverride = "" }) {
  const job = { ...verified.job, ...verified.lead };
  const verifiedUrl = new URL(applicationUrlOverride || verified.lead.finalUrl || verified.lead.url);
  if (verifiedUrl.protocol !== "https:") throw new Error("Autofill requires a verified HTTPS application page.");
  verifiedUrl.hash = "";
  const applicationUrl = verifiedUrl.toString();
  const postingUrl = safeHttpsUrl(verified.job?.postingUrl || verified.job?.url || verified.lead.url) || applicationUrl;
  const resumeJobUrl = safeHttpsUrl(verified.job?.resumeJobUrl) || applicationUrl;
  const allowedPages = [`${verifiedUrl.origin}${normalizedPath(verifiedUrl.pathname)}${verifiedUrl.search}`];
  const navigation = applicationNavigationScope(verifiedUrl);
  const safeProfile = Object.fromEntries([
    "fullName", "firstName", "lastName", "email", "phone", "location", "city", "state", "postalCode", "country",
    "linkedinUrl", "githubUrl", "portfolioUrl",
  ].map((key) => [key, applicationProfile[key] || ""]));
  return {
    id: runId || randomUUID(),
    preparedAt: new Date().toISOString(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    job: { title: job.title, company: job.company, location: job.location, source: job.source, url: verified.job?.url || postingUrl, postingUrl, resumeJobUrl, finalUrl: applicationUrl, applicationUrl, handoffBound: verified.job?.handoffBound === true, checkedAt: job.checkedAt, httpStatus: job.httpStatus, reason: job.reason },
    allowedPages,
    navigation,
    handoff: { canBind: verified.job?.handoffBound !== true, bound: verified.job?.handoffBound === true },
    resume: resumeDraft,
    truth: candidateTruth ? { schema: candidateTruth.schema, fingerprint: candidateTruth.fingerprint.slice(0, 16) } : null,
    profile: safeProfile,
    policy: { submit: "never", safe: ["name", "email", "phone", "location", "public profile links"], review: ["work authorization", "sponsorship", "salary", "relocation", "free-text answers", "checkboxes", "radio buttons"], blocked: ["EEO/demographic", "disability", "veteran status", "race/ethnicity", "gender", "date of birth", "SSN", "legal attestations"] },
  };
}
function restoreApplicationResume(store, run) {
  const saved = run.resume;
  if (!saved) return null;
  const item = saved.draftId ? store.tailoredFile(saved.draftId) : saved.kitId ? store.applicationKitFile(saved.kitId, "resume") : null;
  if (!item) throw new Error("The selected resume for this application is no longer available. Verify the role and select a resume again.");
  if (!sameJobUrl(item.jobUrl, run.job.resumeJobUrl || run.job.applicationUrl)) throw new Error("The selected resume no longer matches this application. Verify the role and build a new tailored resume.");
  return { ...saved };
}
function publicAutofillPack(pack) {
  return { id: pack.id, preparedAt: pack.preparedAt, expiresAt: new Date(pack.expiresAt).toISOString(), job: pack.job, resume: pack.resume, truth: pack.truth, allowedPages: pack.allowedPages, navigation: pack.navigation, handoff: pack.handoff, policy: pack.policy };
}
function bindApplicationTransition(pack, input = {}) {
  if (!pack || pack.expiresAt <= Date.now()) throw new Error("Prepare the verified job again before binding an application page.");
  if (input.runId !== pack.id) throw new Error("This page does not belong to the active application run.");
  if (pack.handoff?.bound || pack.job?.handoffBound) throw new Error("An employer application page is already bound to this run.");
  if (input.userApproved !== true) throw new Error("Confirm the job-bound application page before binding it.");
  const target = new URL(String(input.pageUrl || ""));
  if (target.protocol !== "https:") throw new Error("Only a public HTTPS application page can be bound.");
  target.hash = "";
  const inspection = input.inspection && typeof input.inspection === "object" ? input.inspection : {};
  if (inspection.phase !== "application" || Number(inspection.fieldCount) < 1) throw new Error("Open the employer's application form before binding this page.");
  const referrerBound = [pack.job.applicationUrl, pack.job.postingUrl, ...(pack.allowedPages || [])].some((page) => sameJobUrl(input.referrer, page));
  const identityBound = applicationIdentityMatches(pack.job, `${input.pageTitle || ""} ${input.identityText || ""}`);
  if (!referrerBound && !identityBound) throw new Error("ClearLead could not prove that this application form belongs to the prepared job. Return to the posting and open Apply again.");
  const targetUrl = target.toString();
  const ats = atsHostScope(target.hostname);
  const job = { ...pack.job, applicationUrl: targetUrl, finalUrl: targetUrl, handoffBound: true };
  const boundPack = {
    ...pack,
    job,
    allowedPages: [targetUrl],
    navigation: applicationNavigationScope(target),
    handoff: { canBind: false, bound: true },
    capabilityHash: "",
    capabilityOrigin: "",
  };
  return { pack: boundPack, evidence: { pageUrl: targetUrl, atsFamily: ats.family, evidence: referrerBound ? "approved-referrer" : "approved-job-identity" } };
}
function applicationNavigationScope(page) {
  const pathname = normalizedPath(page.pathname);
  const ats = atsHostScope(page.hostname);
  const pathTokens = pathname.split("/").filter((part) => /^(?=.*\d)[a-z0-9_-]{6,}$/i.test(part));
  const queryTokens = [...page.searchParams.entries()]
    .filter(([key, value]) => /^(?:gh_)?(?:job|jobid|jid|posting|requisition|req|id)$/i.test(key) && value)
    .map(([key, value]) => `${key}=${value}`);
  const jobTokens = [...new Set([...pathTokens, ...queryTokens].map((part) => part.toLowerCase()).slice(-5))];
  if (pathname === "/" && !jobTokens.length) return null;
  return { multiPage: true, origin: page.origin, pathPrefix: pathname, jobTokens, atsFamily: ats.family, allowedHostSuffix: ats.suffix };
}
function atsHostScope(hostname) {
  const families = [
    ["greenhouse", "greenhouse.io"], ["lever", "lever.co"], ["ashby", "ashbyhq.com"],
    ["workday", "myworkdayjobs.com"], ["smartrecruiters", "smartrecruiters.com"],
  ];
  const match = families.find(([, suffix]) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  return match ? { family: match[0], suffix: match[1] } : { family: "generic", suffix: "" };
}
function applicationIdentityMatches(job, evidence) {
  const text = String(evidence || "").toLowerCase();
  const stop = new Set(["and", "the", "for", "with", "job", "role", "application", "careers", "career", "at", "inc", "llc", "company"]);
  const tokens = (value) => [...new Set(String(value || "").toLowerCase().match(/[a-z0-9+#]{2,}/g) || [])].filter((token) => !stop.has(token));
  const title = tokens(job.title);
  const company = tokens(job.company);
  const titleMatches = title.filter((token) => text.includes(token)).length;
  const companyMatches = company.filter((token) => text.includes(token)).length;
  const titleBound = title.length > 0 && titleMatches >= Math.min(2, title.length) && titleMatches / title.length >= 0.6;
  const companyBound = company.length > 0 && companyMatches >= Math.min(1, company.length);
  return titleBound || (companyBound && titleMatches >= 1);
}
function safeHttpsUrl(value) { try { const page = new URL(value); return page.protocol === "https:" ? page.toString() : ""; } catch { return ""; } }
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
        verification = normalizeVerification(await verifyFn(applicationTarget(job)), applicationTarget(job));
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
function findDiscoveredJob(cache, value) {
  const target = comparablePage(value);
  if (!target) return {};
  const exact = cache.get(target);
  if (exact) return exact;
  for (const job of new Set(cache.values())) {
    if (comparablePage(job.url) === target || comparablePage(applicationTarget(job)) === target) return job;
  }
  return {};
}
function comparablePage(value) {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) return "";
    parsed.hash = "";
    parsed.pathname = normalizedPath(parsed.pathname);
    return parsed.toString();
  } catch { return ""; }
}
export function verificationPriority(job) {
  return ({ live: 0, unverified: 1, inconclusive: 1, blocked: 1, closed: 2 })[job.verificationStatus || "unverified"] ?? 1;
}
function normalizeVerification(value, requestedUrl) {
  const verification = value && typeof value === "object" ? { ...value } : {};
  const statuses = new Set(["live", "closed", "blocked", "inconclusive"]);
  if (!statuses.has(verification.status)) {
    return { status: "inconclusive", url: requestedUrl, checkedAt: new Date().toISOString(), reason: "Verifier returned an invalid outcome. Retry, open the source, or discard it.", signals: [] };
  }
  if (verification.status === "live" && !completeLiveEvidence(verification)) {
    return {
      ...verification,
      status: "inconclusive",
      url: verification.url || requestedUrl,
      checkedAt: validDate(verification.checkedAt) ? verification.checkedAt : new Date().toISOString(),
      reason: "The verifier reported this role as live without complete HTTP, timestamp, final URL, and rationale evidence. Retry, open the source, or discard it.",
      signals: Array.isArray(verification.signals) ? verification.signals : [],
    };
  }
  return verification;
}
function completeLiveEvidence(verification) {
  return Number.isInteger(verification.httpStatus) && verification.httpStatus >= 200 && verification.httpStatus < 300 &&
    safeHttpUrl(verification.finalUrl) && validDate(verification.checkedAt) && shortText(verification.reason, 2).length >= 2;
}
function safeHttpUrl(value) { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } }
function sameJobUrl(left, right) {
  try {
    const normalize = (value) => {
      const parsed = new URL(value);
      parsed.hash = "";
      parsed.searchParams.sort();
      return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}${parsed.search}`;
    };
    return normalize(left) === normalize(right);
  } catch { return false; }
}
function validDate(value) { return Number.isFinite(Date.parse(value || "")); }
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
function setSecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
function sendFile(res, file, type) { res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(fs.readFileSync(file)); }
function sendDownload(res, file, filename, type) { res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "content-disposition": `attachment; filename="${filename.replace(/[^a-z0-9_.-]/gi, "-")}"`, "cache-control": "no-store", pragma: "no-cache" }); res.end(fs.readFileSync(file)); }
function sendBufferDownload(res, buffer, filename, type) { res.writeHead(200, { "content-type": type, "content-length": buffer.length, "content-disposition": `attachment; filename="${filename.replace(/[^a-z0-9_.-]/gi, "-")}"`, "cache-control": "no-store", pragma: "no-cache" }); res.end(buffer); }
function downloadFilename(requested, fallback, extension) {
  const withoutExtension = String(requested || fallback || "tailored-resume").trim().replace(/\.(?:md|pdf)$/i, "");
  const safe = withoutExtension.replace(/[^a-z0-9_. -]/gi, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 120) || "tailored-resume";
  return `${safe}.${extension}`;
}
function body(req) { return new Promise((resolve, reject) => { let raw = ""; req.on("data", (part) => { raw += part; if (raw.length > 500_000) { reject(new Error("Request body is too large.")); req.destroy(); } }); req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON")); } }); req.on("error", reject); }); }
function binaryBody(req, limit) { return new Promise((resolve, reject) => { const chunks = []; let size = 0; let tooLarge = false; req.on("data", (part) => { size += part.length; if (size > limit) { tooLarge = true; chunks.length = 0; } else if (!tooLarge) chunks.push(part); }); req.on("end", () => tooLarge ? reject(new Error(`Resume PDF is too large. Use a file under ${Math.floor(limit / 1024 / 1024)} MB.`)) : resolve(Buffer.concat(chunks))); req.on("error", reject); }); }
