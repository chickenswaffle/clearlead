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

  const profile = await postJson(`${base}/api/profile`, {
    targetRoles: ["Staff Platform Engineer"],
    locations: ["Remote"],
    mustHaves: ["Salary listed"],
  });
  assert.equal(profile.readiness.ready, true);

  const discovery = await postJson(`${base}/api/discover/greenhouse`, { board: "example" });
  assert.equal(discovery.jobs[0].relevance.score, 100);
  assert.equal("status" in discovery.jobs[0], false);

  const check = await postJson(`${base}/api/verify`, { url: discovery.jobs[0].url });
  assert.equal(check.status, "live");
  assert.equal(typeof check.verificationId, "string");
  const saved = await postJson(`${base}/api/leads`, { verificationId: check.verificationId });
  assert.equal(saved.saved, true);

  const queue = await getJson(`${base}/api/leads`);
  assert.equal(queue.leads.length, 1);

  const rejected = await fetch(`${base}/api/leads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verificationId: "forged", status: "live" }),
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Run the live verifier/);
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
