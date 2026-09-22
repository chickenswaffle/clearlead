import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createAppServer } from "../src/server.mjs";

test("search-first golden path reaches human final approval across restart without submitting", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-golden-journey-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const postingUrl = "https://remotive.com/remote-jobs/customer-support/it-support-specialist-123456";
  const applicationUrl = "https://job-boards.greenhouse.io/acme/jobs/123456";
  const verifiedUrls = [];
  const verifyFn = async (url) => {
    verifiedUrls.push(url);
    const isPostingRefresh = url === postingUrl;
    return {
      status: "live",
      url,
      finalUrl: postingUrl,
      httpStatus: 200,
      reason: isPostingRefresh ? "Fresh board posting evidence." : "Verified board posting entry.",
      checkedAt: "2026-09-22T15:00:00.000Z",
    };
  };
  const discoverSourceFn = async (source) => ({
    source: source.type,
    board: source.token,
    error: null,
    queryMode: source.type === "remotive" ? "full-feed-local-filtered" : "query-aligned",
    jobs: source.type === "remotive" ? [{
      source: "remotive",
      board: "remote",
      company: "Acme Health",
      title: "IT Support Specialist",
      location: "Dallas, TX",
      url: postingUrl,
      postedAt: "2026-09-21T12:00:00.000Z",
      description: "Windows troubleshooting and Active Directory are required. A+ certification is preferred. This is an onsite Dallas role supporting healthcare users.",
    }] : [],
  });
  const firstServer = createAppServer({ dataDir, discoverSourceFn, verifyFn });
  const resumeText = `# Taylor Example

## Summary
IT support specialist providing dependable technical support for busy teams and end users.

## Experience
- Troubleshot Windows devices, hardware, software, and network issues for employees.
- Managed Active Directory user accounts and documented ticket resolutions.
- Delivered customer-focused desktop support and device setup.

## Skills
Windows, Active Directory, troubleshooting, networking, hardware, technical support`;

  await direct(firstServer, "POST", "/api/resume", { text: resumeText, filename: "taylor-resume.md" });
  await direct(firstServer, "POST", "/api/profile", { targetRoles: ["IT Support Specialist"], locations: ["Dallas"], preferences: ["healthcare"], mustHaves: [] });
  await direct(firstServer, "POST", "/api/application-profile", { fullName: "Taylor Example", email: "taylor@example.com", phone: "+1 555 123 4567", city: "Dallas", state: "TX", country: "United States" });

  const search = await direct(firstServer, "POST", "/api/search/smart", { prompt: "entry level IT support jobs in Dallas", autoVerify: true, verifyLimit: 5 });
  assert.equal(search.status, 200);
  assert.equal(search.body.jobs.length, 1);
  const job = search.body.jobs[0];
  assert.equal(job.title, "IT Support Specialist");
  assert.notEqual(job.match.decision.code, "skip");
  assert.equal(job.match.qualifications.items.find((item) => item.code === "skill-windows").status, "met");
  assert.equal(job.verification.status, "live");

  const tailored = await direct(firstServer, "POST", "/api/tailor", { verificationId: job.verification.verificationId });
  assert.equal(tailored.status, 200);
  assert.ok(tailored.body.requirementMatrix.items.some((item) => item.code === "skill-active-directory" && item.status === "met"));
  assert.doesNotMatch(tailored.body.preview, /A\+ certification/i, "a missing preferred credential must not be inserted");

  const pairing = await direct(firstServer, "POST", "/api/extension/pair", {});
  const prepared = await direct(firstServer, "POST", "/api/application/prepare", {
    verificationId: job.verification.verificationId,
    draftId: tailored.body.id,
    filename: "Taylor-Acme-Support.pdf",
  });
  assert.equal(prepared.body.policy.submit, "never");
  assert.equal(prepared.body.job.postingUrl, postingUrl);
  assert.equal(prepared.body.job.applicationUrl, postingUrl, "default board results begin bound to the verified board page");
  const runId = prepared.body.run.id;
  const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const initialSession = await direct(firstServer, "GET", "/api/extension/session", null, { origin, authorization: `Bearer ${pairing.body.token}` });
  const bound = await direct(firstServer, "POST", "/api/extension/transition", {
    runId: initialSession.body.runId,
    pageUrl: applicationUrl,
    pageTitle: "IT Support Specialist — Acme Health",
    identityText: "Apply for IT Support Specialist at Acme Health",
    referrer: postingUrl,
    inspection: { atsFamily: "greenhouse", phase: "application", fieldCount: 5 },
    userApproved: true,
  }, { origin, authorization: `Bearer ${pairing.body.token}` });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.job.applicationUrl, applicationUrl);
  const firstSession = await direct(firstServer, "GET", "/api/extension/session", null, { origin, authorization: `Bearer ${pairing.body.token}` });
  const firstReport = await direct(firstServer, "POST", "/api/extension/run", {
    runId,
    pageUrl: `${applicationUrl}/application?step=1`,
    inspection: { atsFamily: "greenhouse", phase: "application", stepKey: "greenhouse:contact", stepLabel: "Contact", requiredCount: 3, emptyRequiredCount: 1, nextControlCount: 1, submitControlCount: 0 },
    fill: { filled: 2, review: 1, blocked: 0, manual: 1 },
  }, { origin, authorization: `Bearer ${firstSession.body.capability}` });
  assert.equal(firstReport.body.run.status, "needs_review");

  const restartedServer = createAppServer({ dataDir, discoverSourceFn, verifyFn });
  const resumed = await direct(restartedServer, "POST", `/api/application/runs/${runId}/resume`, {});
  assert.equal(resumed.body.run.status, "in_progress");
  assert.equal(resumed.body.job.applicationUrl, applicationUrl);
  assert.equal(verifiedUrls.at(-1), postingUrl, "restart must revalidate the posting, not the standalone application form");
  const resumedSession = await direct(restartedServer, "GET", "/api/extension/session", null, { origin, authorization: `Bearer ${pairing.body.token}` });
  const ready = await direct(restartedServer, "POST", "/api/extension/run", {
    runId,
    pageUrl: `${applicationUrl}/application?step=2`,
    inspection: { atsFamily: "greenhouse", phase: "application", stepKey: "greenhouse:review", stepLabel: "Review", requiredCount: 3, emptyRequiredCount: 0, nextControlCount: 0, submitControlCount: 1 },
    fill: { filled: 0, review: 0, blocked: 0, manual: 0 },
  }, { origin, authorization: `Bearer ${resumedSession.body.capability}` });
  assert.equal(ready.body.run.status, "ready_for_final_approval");
  assert.notEqual(ready.body.run.status, "complete");
  assert.match(ready.body.run.lastEvent.stepLabel, /Review/);

  const persisted = fs.readFileSync(path.join(dataDir, "application-runs.json"), "utf8");
  assert.doesNotMatch(persisted, /taylor@example\.com|555 123 4567/i, "application field values must not be stored in run history");
  assert.doesNotMatch(persisted, /submit_clicked|submitted_by_clearlead/i);
});

function direct(server, method, url, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === null ? "" : JSON.stringify(payload || {});
    const request = Readable.from(body ? [Buffer.from(body)] : []);
    request.method = method;
    request.url = url;
    request.headers = { host: "127.0.0.1:4173", ...(method === "POST" ? { "content-type": "application/json" } : {}), ...extraHeaders };
    const response = {
      headers: {}, statusCode: 200,
      setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
      writeHead(status, headers = {}) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); },
      end(value = "") { const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value); let parsed = text; try { parsed = JSON.parse(text); } catch {} resolve({ status: this.statusCode, headers: this.headers, body: parsed }); },
    };
    request.on("error", reject);
    server.emit("request", request, response);
  });
}
