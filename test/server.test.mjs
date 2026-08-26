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
  const saved = await postJson(`${base}/api/leads`, { verificationId: check.verificationId });
  assert.equal(saved.saved, true);

  const draft = await postJson(`${base}/api/tailor`, { verificationId: check.verificationId });
  assert.match(draft.filename, /example-staff-platform-engineer/);
  assert.match(draft.preview, /no claims or metrics were invented/i);
  const download = await fetch(`${base}${draft.downloadUrl}`);
  assert.equal(download.status, 200);
  assert.match(await download.text(), /Built Python and Kubernetes services/);
  const repeatedSave = await fetch(`${base}/api/leads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verificationId: check.verificationId }) });
  assert.equal(repeatedSave.status, 400);
  assert.match((await repeatedSave.json()).error, /already used/);
  const repeatedTailor = await fetch(`${base}/api/tailor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verificationId: check.verificationId }) });
  assert.equal(repeatedTailor.status, 400);
  assert.match((await repeatedTailor.json()).error, /already created/);

  const queue = await getJson(`${base}/api/leads`);
  assert.equal(queue.leads.length, 1);
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
  assert.equal(manualCheck.source, "");
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
  assert.match(await resumeDownload.text(), /Built Python services on Kubernetes for production systems/);

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
