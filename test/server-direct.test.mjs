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
