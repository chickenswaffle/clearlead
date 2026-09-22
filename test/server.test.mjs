import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAppServer } from "../src/server.mjs";

test("profile, discovery, verification, and review queue work through the real API", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-api-"));
  const verifyFn = async (url) => ({
    status: "live",
    url,
    finalUrl: url,
    httpStatus: 200,
    reason: "Test fixture contains a job-detail signal.",
    checkedAt: "2026-08-26T12:00:00.000Z",
  });
  const discoverFn = async (board) => ({
    source: "greenhouse",
    board,
    error: null,
    jobs: [{
      source: "greenhouse",
      board,
      title: "Staff Platform Engineer",
      location: "Remote",
      url: "https://boards.greenhouse.io/example/jobs/123",
      postedAt: null,
    }],
  });
  const server = createAppServer({ dataDir, verifyFn, discoverFn });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const initial = await getJson(`${base}/api/leads`);
  assert.equal(initial.readiness.ready, false);
  assert.deepEqual(initial.leads, []);

  const hostileHostStatus = await rawStatus(server.address().port, { host: "attacker.example" });
  assert.equal(hostileHostStatus, 403);

  const hostileOrigin = await fetch(`${base}/api/leads`, { headers: { origin: "https://attacker.example" } });
  assert.equal(hostileOrigin.status, 403);

  const wrongLocalOrigin = await fetch(`${base}/api/leads`, { headers: { origin: "http://127.0.0.1:9999" } });
  assert.equal(wrongLocalOrigin.status, 403);

  const plainMutation = await fetch(`${base}/api/profile`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(plainMutation.status, 415);

  const profile = await postJson(`${base}/api/profile`, {
    targetRoles: ["Staff Platform Engineer"],
    locations: ["Remote"],
    mustHaves: ["Salary listed"],
  });
  assert.equal(profile.readiness.ready, false);

  const resumeText = `# Jordan Example

## Summary
Staff platform engineer with ten years building distributed systems and reliable cloud infrastructure.

## Experience
- Built Python and Kubernetes services for production systems.
- Led platform engineering projects across product teams.
- Improved observability and deployment reliability.`;
  const resume = await postJson(`${base}/api/resume`, { text: resumeText, filename: "resume.md" });
  assert.equal(resume.resume.ready, true);
  assert.equal(resume.readiness.ready, true);

  const firstSearch = await postJson(`${base}/api/search`, {
    boards: ["example"],
    query: "staff platform",
    location: "remote",
    autoRefresh: true,
    refreshMinutes: 5,
  });
  assert.equal(firstSearch.total, 1);
  assert.equal(firstSearch.newCount, 0);
  assert.equal(firstSearch.jobs[0].isNew, false);
  assert.equal(firstSearch.jobs[0].verificationStatus, "live");
  assert.equal(firstSearch.checkedCount, 1);
  assert.equal(firstSearch.verifiedCount, 1);

  const secondSearch = await postJson(`${base}/api/search`, firstSearch.config);
  assert.equal(secondSearch.newCount, 0);
  assert.equal(secondSearch.jobs[0].isNew, false);

  const discovery = await postJson(`${base}/api/discover/greenhouse`, { board: "example" });
  assert.equal(discovery.jobs[0].relevance.score, 100);
  assert.equal("status" in discovery.jobs[0], false);

  const check = await postJson(`${base}/api/verify`, { url: discovery.jobs[0].url });
  assert.equal(check.status, "live");
  assert.equal(typeof check.verificationId, "string");
  assert.equal(check.source, "greenhouse");
  assert.equal(check.board, "example");
  assert.equal(check.company, "Example");
  assert.equal(typeof check.firstSeenAt, "string");
  const application = await postJson(`${base}/api/application-profile`, { fullName: "Taylor Example", email: "taylor@example.com", phone: "+1 555 123 4567", linkedinUrl: "https://linkedin.com/in/taylor", workAuthorization: "unknown" });
  assert.equal(application.readiness.ready, true);
  const pairing = await postJson(`${base}/api/extension/pair`, {});
  assert.equal(typeof pairing.token, "string");
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, "extension-pairing.json"), "utf8"), new RegExp(pairing.token));
  const prepared = await postJson(`${base}/api/application/prepare`, { verificationId: check.verificationId });
  assert.equal(prepared.policy.submit, "never");
  assert.equal(prepared.truth.schema, "clearlead-candidate-truth/v1");
  assert.equal(prepared.truth.fingerprint.length, 16);
  assert.deepEqual(prepared.allowedPages, [new URL(check.finalUrl).origin + new URL(check.finalUrl).pathname]);
  const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const extensionSessionResponse = await fetch(`${base}/api/extension/session`, { headers: { origin: extensionOrigin, authorization: `Bearer ${pairing.token}` } });
  assert.equal(extensionSessionResponse.status, 200);
  const extensionSession = await extensionSessionResponse.json();
  const extensionPackResponse = await fetch(`${base}/api/extension/pack`, { headers: { origin: extensionOrigin, authorization: `Bearer ${extensionSession.capability}` } });
  assert.equal(extensionPackResponse.status, 200);
  assert.equal(extensionPackResponse.headers.get("access-control-allow-origin"), extensionOrigin);
  const extensionPack = await extensionPackResponse.json();
  assert.equal(extensionPack.profile.email, "taylor@example.com");
  assert.equal(extensionPack.policy.submit, "never");
  const rejectedExtension = await fetch(`${base}/api/extension/pack`, { headers: { origin: extensionOrigin, authorization: "Bearer wrong-token" } });
  assert.equal(rejectedExtension.status, 401);
  const saved = await postJson(`${base}/api/leads`, { verificationId: check.verificationId });
  assert.equal(saved.saved, true);

  const draft = await postJson(`${base}/api/tailor`, { verificationId: check.verificationId });
  assert.match(draft.filename, /example-staff-platform-engineer/);
  assert.match(draft.groundingNotes.join(" "), /no claims or metrics were invented/i);
  assert.doesNotMatch(draft.preview, /Grounding report|Verified source/);
  const download = await fetch(`${base}${draft.downloadUrl}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(download.headers.get("pragma"), "no-cache");
  const downloadedMarkdown = await download.text();
  assert.match(downloadedMarkdown, /Built Python and Kubernetes services/);
  assert.equal(draft.preview, downloadedMarkdown);
  const namedDownload = await fetch(`${base}${draft.downloadUrl}?name=Platform%20Support%20Resume`);
  assert.match(namedDownload.headers.get("content-disposition"), /Platform-Support-Resume\.md/);
  const hostileName = await fetch(`${base}${draft.downloadUrl}?name=..%2F..%2Fevil%0D%0AX-Test%3Ayes`);
  assert.equal(hostileName.headers.get("content-disposition"), 'attachment; filename="evil-X-Test-yes.md"');
  assert.doesNotMatch(hostileName.headers.get("content-disposition"), /[\/\r\n]/);
  const pdfDownload = await fetch(`${base}${draft.pdfUrl}?name=Platform%20Support%20Resume`);
  assert.equal(pdfDownload.status, 200);
  assert.equal(pdfDownload.headers.get("content-type"), "application/pdf");
  assert.match(pdfDownload.headers.get("content-disposition"), /Platform-Support-Resume\.pdf/);
  assert.equal(Buffer.from(await pdfDownload.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  const madeDefault = await postJson(`${base}/api/tailored/${draft.id}/default`, { filename: "Platform Support Resume.md" });
  assert.equal(madeDefault.resume.filename, "Platform-Support-Resume.md");
  assert.match(madeDefault.message, /local default resume/i);
  assert.equal(typeof madeDefault.undoId, "string");
  const preparedWithResume = await postJson(`${base}/api/application/prepare`, { verificationId: check.verificationId, draftId: draft.id, filename: "Platform Support Resume.pdf" });
  assert.equal(preparedWithResume.resume.draftId, draft.id);
  assert.equal(preparedWithResume.resume.filename, "Platform-Support-Resume.pdf");
  assert.match(preparedWithResume.resume.pdfUrl, new RegExp(draft.id));
  const tailoredMetadataPath = path.join(dataDir, "tailored", `${draft.id}.json`);
  const tailoredMetadata = JSON.parse(fs.readFileSync(tailoredMetadataPath, "utf8"));
  assert.equal(tailoredMetadata.jobUrl, check.finalUrl);
  fs.writeFileSync(tailoredMetadataPath, JSON.stringify({ ...tailoredMetadata, jobUrl: "https://jobs.example/different-role" }));
  const mismatchedDraft = await fetch(`${base}/api/application/prepare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verificationId: check.verificationId, draftId: draft.id }) });
  assert.equal(mismatchedDraft.status, 400);
  assert.match((await mismatchedDraft.json()).error, /different job/);
  fs.writeFileSync(tailoredMetadataPath, JSON.stringify(tailoredMetadata));
  const restoredDefault = await postJson(`${base}/api/resume/default/restore`, { undoId: madeDefault.undoId });
  assert.equal(restoredDefault.resume.filename, "resume.md");
  const repeatedSave = await fetch(`${base}/api/leads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verificationId: check.verificationId }) });
  assert.equal(repeatedSave.status, 400);
  assert.match((await repeatedSave.json()).error, /already used/);
  const repeatedTailor = await fetch(`${base}/api/tailor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verificationId: check.verificationId }) });
  assert.equal(repeatedTailor.status, 200);
  assert.equal((await repeatedTailor.json()).id, draft.id);

  const queue = await getJson(`${base}/api/leads`);
  assert.equal(queue.leads.length, 1);
  assert.equal(queue.candidateTruth.schema, "clearlead-candidate-truth/v1");
  assert.equal(queue.candidateTruth.ready, true);
  assert.ok(queue.candidateTruth.factCount > 0);
  assert.equal(queue.leads[0].source, "greenhouse");
  assert.equal(queue.leads[0].board, "example");

  const manualCheck = await postJson(`${base}/api/verify`, {
    url: "https://jobs.example/manual",
    title: "Forged Chief Executive Officer",
    company: "Forged Company",
    location: "Forged Location",
    source: "forged-source",
    board: "forged-board",
    firstSeenAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(manualCheck.source, "pasted");
  assert.equal(manualCheck.board, "");
  assert.equal(manualCheck.title, "");
  assert.equal(manualCheck.company, "");
  assert.equal(manualCheck.location, "");
  assert.equal(manualCheck.firstSeenAt, "");

  const rejected = await fetch(`${base}/api/leads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verificationId: "forged", status: "live" }),
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Run the live verifier/);
});

test("a total source outage does not establish a false new-role baseline", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-outage-"));
  let outage = true;
  const discoverFn = async (board) => outage
    ? { source: "greenhouse", board, jobs: [], error: "offline" }
    : { source: "greenhouse", board, error: null, jobs: [{
      source: "greenhouse", board, title: "Platform Engineer", location: "Remote",
      url: "https://jobs.example/recovered", postedAt: null,
    }] };
  const server = createAppServer({ dataDir, discoverFn });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await postJson(`${base}/api/resume`, { text: "Platform engineer with extensive experience building cloud systems.\n- Built reliable distributed services with Python and Kubernetes.\n- Led production operations and observability improvements across engineering teams.", filename: "resume.md" });
  const failed = await postJson(`${base}/api/search`, { boards: ["example"], query: "platform engineer", autoVerify: false });
  assert.equal(failed.outage, true);
  assert.equal((await getJson(`${base}/api/leads`)).searchStatus.lastRunAt, null);
  outage = false;
  const recovered = await postJson(`${base}/api/search`, failed.config);
  assert.equal(recovered.outage, false);
  assert.equal(recovered.newCount, 0);
  assert.equal(recovered.jobs[0].isNew, false);
});

test("AI provider setup and application kits require consent and keep credentials private", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-ai-api-"));
  const verifyFn = async (url) => ({ status: "live", url, finalUrl: url, httpStatus: 200, reason: "Live job fixture.", checkedAt: "2026-08-26T12:00:00.000Z" });
  const discoverFn = async (board) => ({ source: "greenhouse", board, error: null, jobs: [{
    source: "greenhouse", board, company: "Acme", title: "Platform Engineer", location: "Remote",
    url: "https://boards.greenhouse.io/acme/jobs/ai-1", description: "Python Kubernetes reliability engineering", postedAt: "2026-08-25T12:00:00.000Z",
  }] });
  const aiClient = {
    testConnection: async (secret) => ({ ok: true, provider: secret.provider, model: secret.model, message: "Fixture provider accepted the key. No resume data was sent." }),
    generate: async () => JSON.stringify({
      summary_source_ids: ["L004"],
      priority_source_ids: ["L007"],
      fit: { strength_source_ids: ["L004", "L007"] },
      cover_letter: { source_ids: ["L004", "L007"] },
      interview_prep: { evidence_source_ids: ["L007"] },
    }),
  };
  const server = createAppServer({ dataDir, verifyFn, discoverFn, aiClient });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const resumeText = `# Taylor Example

## Summary
Platform engineer building reliable Python services.

## Experience
- Built Python services on Kubernetes for production systems.
- Improved deployment reliability by 30% across product teams.`;
  await postJson(`${base}/api/resume`, { text: resumeText, filename: "resume.md" });
  const search = await postJson(`${base}/api/search`, { boards: ["acme"], query: "platform", autoVerify: true, verifyLimit: 5 });
  const verificationId = search.jobs[0].verification.verificationId;

  const provider = await postJson(`${base}/api/ai/provider`, { provider: "openrouter", model: "fixture/model", apiKey: "sk-fixture-private-1234" });
  assert.equal(provider.keyHint, "••••1234");
  assert.equal("apiKey" in provider, false);
  const publicProvider = await getJson(`${base}/api/ai`);
  assert.equal("apiKey" in publicProvider, false);
  assert.doesNotMatch(JSON.stringify(publicProvider), /fixture-private/);
  const tested = await postJson(`${base}/api/ai/test`, {});
  assert.equal(tested.ok, true);

  const withoutConsent = await fetch(`${base}/api/ai/kit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verificationId }) });
  assert.equal(withoutConsent.status, 400);
  assert.match((await withoutConsent.json()).error, /authorization is missing/);

  const staleConsent = await postJson(`${base}/api/ai/consent`, { verificationId });
  assert.equal(staleConsent.provider, "openrouter");
  assert.equal(staleConsent.jobUrl, "https://boards.greenhouse.io/acme/jobs/ai-1");
  await postJson(`${base}/api/ai/provider`, { provider: "openrouter", model: "changed/model", apiKey: "" });
  const changedProvider = await fetch(`${base}/api/ai/kit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verificationId, consentId: staleConsent.consentId }) });
  assert.equal(changedProvider.status, 400);
  assert.match((await changedProvider.json()).error, /no longer matches/);
  await postJson(`${base}/api/ai/provider`, { provider: "openrouter", model: "fixture/model", apiKey: "" });
  const consent = await postJson(`${base}/api/ai/consent`, { verificationId });
  const kit = await postJson(`${base}/api/ai/kit`, { verificationId, consentId: consent.consentId });
  assert.equal(kit.provider, "openrouter");
  assert.equal(kit.audit.rejected, 0);
  assert.deepEqual(Object.keys(kit.downloads).sort(), ["claim-audit", "cover-letter", "fit-report", "interview-prep", "resume"]);
  const resumeDownload = await fetch(`${base}${kit.downloads.resume}`);
  assert.equal(resumeDownload.status, 200);
  const aiResumeText = await resumeDownload.text();
  assert.match(aiResumeText, /Built Python services on Kubernetes for production systems/);
  assert.doesNotMatch(aiResumeText, /Grounding note|Verified source|Source selections accepted/);
  const aiPdf = await fetch(`${base}${kit.pdfUrl}?name=AI%20Platform%20Resume`);
  assert.equal(aiPdf.status, 200);
  assert.equal(aiPdf.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await aiPdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  await postJson(`${base}/api/application-profile`, { fullName: "Taylor Example", email: "taylor@example.com", phone: "+1 555 123 4567" });
  const preparedAi = await postJson(`${base}/api/application/prepare`, { verificationId, kitId: kit.id, filename: "AI Platform Resume.pdf" });
  assert.equal(preparedAi.resume.kitId, kit.id);
  assert.equal(preparedAi.resume.filename, "AI-Platform-Resume.pdf");
  assert.match(preparedAi.resume.pdfUrl, new RegExp(kit.id));

  const repeated = await fetch(`${base}/api/ai/kit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verificationId, consentId: consent.consentId }) });
  assert.equal(repeated.status, 400);
  assert.match((await repeated.json()).error, /already building or built/);

  fs.writeFileSync(path.join(dataDir, "credentials.enc"), "corrupt vault", { mode: 0o600 });
  const brokenAi = await fetch(`${base}/api/ai`);
  assert.equal(brokenAi.status, 400);
  const coreState = await fetch(`${base}/api/leads`);
  assert.equal(coreState.status, 200);
  const removed = await postJson(`${base}/api/ai/provider/remove`, {});
  assert.equal(removed.configured, false);
});

test("PDF resume upload extracts a review preview and does not persist it", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-pdf-api-"));
  let received = null;
  const server = createAppServer({ dataDir, extractPdfFn: async (buffer) => {
    received = buffer;
    return { text: "Taylor Example\nPlatform engineer with extensive experience building reliable Python and Kubernetes production services across multiple product teams.", pageCount: 2, wordCount: 17, warnings: ["Review formatting."] };
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/resume/pdf`, { method: "POST", headers: { "content-type": "application/pdf" }, body: Buffer.from("%PDF-fixture") });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.persisted, false);
  assert.equal(preview.pageCount, 2);
  assert.match(preview.text, /Taylor Example/);
  assert.equal(received.toString(), "%PDF-fixture");
  assert.equal((await getJson(`${base}/api/leads`)).resume.ready, false);
  const wrongType = await fetch(`${base}/api/resume/pdf`, { method: "POST", headers: { "content-type": "text/plain" }, body: "fake" });
  assert.equal(wrongType.status, 415);
});

async function getJson(url) {
  return (await fetch(url)).json();
}

async function postJson(url, value) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  assert.equal(response.ok, true);
  return response.json();
}

function rawStatus(port, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: "/api/leads", headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}
