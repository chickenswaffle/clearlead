import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createAppServer } from "../src/server.mjs";

test("application copilot pairs by hash and serves only verified-job-bound packs", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-direct-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = createAppServer({
    dataDir,
    verifyFn: async (url) => ({ status: "live", url, finalUrl: url, httpStatus: 200, reason: "Direct fixture is live.", checkedAt: "2026-08-27T12:00:00.000Z" }),
    discoverFn: async (board) => ({ source: "greenhouse", board, error: null, jobs: [{ source: "greenhouse", board, company: "Acme", title: "Platform Engineer", location: "Remote", url: "https://boards.greenhouse.io/acme/apply?job=1", applyUrl: "http://attacker.example/collect", description: "Python Kubernetes platform engineering" }] }),
  });
  const resume = "# Taylor Example\n\nPlatform engineer with extensive experience building reliable cloud services and production systems.\n\n- Built Python services on Kubernetes for product teams.\n- Improved deployment reliability and observability.";
  const home = await direct(server, "GET", "/", null);
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.equal(home.headers["x-frame-options"], "DENY");
  assert.match(home.headers["content-security-policy"], /frame-ancestors 'none'/);
  await direct(server, "POST", "/api/resume", { text: resume, filename: "resume.md" });
  const search = await direct(server, "POST", "/api/search", { boards: ["acme"], query: "platform", autoVerify: true, verifyLimit: 5 });
  const verificationId = search.body.jobs[0].verification.verificationId;
  const profile = await direct(server, "POST", "/api/application-profile", { fullName: "Taylor Example", email: "taylor@example.com", phone: "+1 555 123 4567", city: "Chicago", state: "IL", country: "United States" });
  assert.equal(profile.body.readiness.ready, true);
  const pairing = await direct(server, "POST", "/api/extension/pair", {});
  assert.equal(pairing.status, 200);
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, "extension-pairing.json"), "utf8"), new RegExp(pairing.body.token));
  const prepared = await direct(server, "POST", "/api/application/prepare", { verificationId });
  assert.equal(prepared.body.policy.submit, "never");
  assert.deepEqual(prepared.body.allowedPages, ["https://boards.greenhouse.io/acme/apply?job=1"]);
  const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const session = await direct(server, "GET", "/api/extension/session", null, { origin, authorization: `Bearer ${pairing.body.token}` });
  assert.equal(session.status, 200);
  assert.equal(session.body.packReady, true);
  const pack = await direct(server, "GET", "/api/extension/pack", null, { origin, authorization: `Bearer ${session.body.capability}` });
  assert.equal(pack.status, 200);
  assert.equal(pack.headers["access-control-allow-origin"], origin);
  assert.equal(pack.body.profile.email, "taylor@example.com");
  assert.equal(pack.body.profile.desiredSalary, undefined);
  assert.equal(pack.body.profile.workAuthorization, undefined);
  assert.equal(pack.body.job.applicationUrl, "https://boards.greenhouse.io/acme/apply?job=1");
  assert.doesNotMatch(JSON.stringify(pack.body), /attacker\.example/);
  assert.equal(pack.body.job.finalUrl, "https://boards.greenhouse.io/acme/apply?job=1");
  const wrongExtension = await direct(server, "GET", "/api/extension/session", null, { origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", authorization: `Bearer ${pairing.body.token}` });
  assert.equal(wrongExtension.status, 401);
  const denied = await direct(server, "GET", "/api/extension/pack", null, { origin, authorization: `Bearer ${pairing.body.token}` });
  assert.equal(denied.status, 401);
});

test("smart search expands one prompt, passes the plan to broad sources, and returns descriptions", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-smart-direct-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const seenPlans = [];
  let providerCalls = 0;
  const server = createAppServer({
    dataDir,
    aiClient: {
      testConnection: async () => ({ ok: true }),
      generate: async () => { providerCalls += 1; return JSON.stringify({ titles: ["IT Support Specialist", "Help Desk Technician"], keywords: ["troubleshooting"], sectors: ["education"] }); },
    },
    discoverSourceFn: async (source, options) => {
      if (source.type !== "jobledger") return { source: source.type, board: source.token, error: null, jobs: [] };
      seenPlans.push(options.plan);
      return { source: "jobledger", board: "employer-direct", error: null, jobs: [{ source: "jobledger", board: "workday", company: "Dallas School", title: "IT Support Specialist", location: "Dallas", url: "https://jobs.example.edu/apply/1", description: "Support students, teachers, Windows devices, and school networks." }] };
    },
  });
  const resume = "# Taylor Example\n\nIT support professional with extensive experience troubleshooting Windows devices, networks, software, customer requests, ticket resolution, documentation, and reliable user support across busy organizations.";
  await direct(server, "POST", "/api/resume", { text: resume, filename: "resume.md" });
  await direct(server, "POST", "/api/ai/provider", { provider: "openai", model: "test-model", apiKey: "sk-test-value-long-enough-for-local-vault" });
  const local = await direct(server, "POST", "/api/search/smart", { prompt: "entry level tech jobs in DFW schools", autoVerify: false });
  assert.equal(local.body.plan.mode, "local");
  assert.equal(providerCalls, 0, "configured providers are opt-in per smart search");
  const search = await direct(server, "POST", "/api/search/smart", { prompt: "entry level tech jobs in DFW schools", useAI: true, autoVerify: false });
  assert.equal(search.status, 200);
  assert.equal(search.body.plan.mode, "ai");
  assert.equal(providerCalls, 1);
  assert.ok(seenPlans[0].locations.includes("Dallas"));
  assert.equal(search.body.jobs[0].company, "Dallas School");
  assert.match(search.body.jobs[0].description, /students, teachers/);
  assert.ok(search.body.config.broadFeeds.includes("jobledger"));
  assert.equal(search.body.config.smartPrompt, "entry level tech jobs in DFW schools");
  const reloaded = await direct(server, "GET", "/api/leads", null);
  assert.equal(reloaded.body.searchConfig.smartPrompt, "entry level tech jobs in DFW schools");
});

test("a corrupt optional provider vault falls back to local smart search", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-corrupt-vault-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "credentials.enc"), "not valid encrypted json", { mode: 0o600 });
  const server = createAppServer({
    dataDir,
    discoverSourceFn: async (source) => ({ source: source.type, board: source.token, error: null, jobs: source.type === "jobledger" ? [{ source: "jobledger", company: "Acme", title: "IT Support Specialist", location: "Dallas", url: "https://jobs.example/apply/1", description: "Windows user support" }] : [] }),
  });
  await direct(server, "POST", "/api/resume", { text: "Experienced IT support professional troubleshooting Windows computers, networks, software, users, tickets, customer issues, documentation, systems, hardware, and service requests. Delivers reliable customer service, device setup, account maintenance, technical training, incident ownership, and clear resolution notes for busy teams.", filename: "resume.md" });
  const search = await direct(server, "POST", "/api/search/smart", { prompt: "entry level tech jobs in DFW", useAI: true, autoVerify: false });
  assert.equal(search.status, 200);
  assert.equal(search.body.plan.mode, "local");
  assert.equal(search.body.jobs.length, 1);
});

test("a distinct HTTPS apply URL is verified and becomes the exact autofill page", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-apply-target-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const verifiedUrls = [];
  const server = createAppServer({
    dataDir,
    verifyFn: async (url) => { verifiedUrls.push(url); return { status: "live", url, finalUrl: "https://apply.example.com/form/step-one?job=7", httpStatus: 200, reason: "Application form is live.", checkedAt: "2026-08-27T12:00:00.000Z" }; },
    discoverFn: async (board) => ({ source: "greenhouse", board, error: null, jobs: [{ source: "greenhouse", board, company: "Acme", title: "IT Support Specialist", location: "Dallas", url: "https://jobs.example.com/posting/7", applyUrl: "https://apply.example.com/start?job=7", description: "Windows network and user support" }] }),
  });
  await direct(server, "POST", "/api/resume", { text: "Experienced IT support professional troubleshooting Windows computers, networks, software, users, tickets, customer issues, documentation, systems, hardware, and service requests. Delivers reliable customer service, device setup, account maintenance, technical training, incident ownership, and clear resolution notes for busy teams.", filename: "resume.md" });
  await direct(server, "POST", "/api/application-profile", { fullName: "Taylor Example", email: "taylor@example.com" });
  const search = await direct(server, "POST", "/api/search", { boards: ["acme"], query: "IT support specialist", autoVerify: true, verifyLimit: 1 });
  assert.deepEqual(verifiedUrls, ["https://apply.example.com/start?job=7"]);
  const prepared = await direct(server, "POST", "/api/application/prepare", { verificationId: search.body.jobs[0].verification.verificationId });
  assert.equal(prepared.body.job.applicationUrl, "https://apply.example.com/form/step-one?job=7");
  assert.deepEqual(prepared.body.allowedPages, ["https://apply.example.com/form/step-one?job=7"]);
});

test("the direct verifier cannot issue a save capability for incomplete live evidence", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-incomplete-direct-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const server = createAppServer({
    dataDir,
    verifyFn: async (url) => ({ status: "live", url, finalUrl: url, reason: "Missing a check timestamp and HTTP status." }),
  });
  const result = await direct(server, "POST", "/api/verify", { url: "https://jobs.example.com/role" });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "inconclusive");
  assert.equal(result.body.verificationId, undefined);
  assert.match(result.body.reason, /without complete HTTP/i);
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
