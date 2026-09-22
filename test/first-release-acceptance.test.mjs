import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppServer } from "../src/server.mjs";

test("fresh local app keeps pasted URLs as an evidence-backed fallback with no setup dependency", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-first-release-"));
  const checkedAt = "2026-08-31T15:30:00.000Z";
  const verifyFn = async (url) => {
    if (url.endsWith("/live")) return { status: "live", url, finalUrl: `${url}?canonical=1`, httpStatus: 200, checkedAt, reason: "Live evidence: apply action + job description.", signals: ["apply action", "job description"] };
    if (url.endsWith("/closed")) return { status: "closed", url, finalUrl: url, httpStatus: 410, checkedAt, reason: "Source returned HTTP 410.", signals: ["HTTP 410"] };
    if (url.endsWith("/blocked")) return { status: "blocked", url, finalUrl: url, httpStatus: 403, checkedAt, reason: "The source presented a bot challenge; open it in your browser.", signals: ["access challenge"] };
    return { status: "inconclusive", url, finalUrl: url, httpStatus: 503, checkedAt, reason: "Source returned HTTP 503; retry, open the source, or discard it.", signals: [] };
  };
  const server = createAppServer({ dataDir, verifyFn });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const home = await fetch(base);
  const html = await home.text();
  assert.equal(home.status, 200);
  assert.ok(html.indexOf('id="resume"') < html.indexOf('id="search"'));
  assert.ok(html.indexOf('id="search"') < html.indexOf('id="verify-panel"'));
  assert.match(html, /I already have a job link/);
  assert.deepEqual(fs.readdirSync(dataDir), []);

  const live = await post(base, "/api/verify", { url: "https://jobs.example.test/live" });
  assert.equal(live.status, "live");
  assert.equal(live.source, "pasted");
  assert.equal(live.httpStatus, 200);
  assert.equal(live.finalUrl, "https://jobs.example.test/live?canonical=1");
  assert.equal(typeof live.verificationId, "string");

  const saved = await post(base, "/api/leads", { verificationId: live.verificationId });
  assert.equal(saved.saved, true);
  assert.equal(saved.lead.source, "pasted");
  assert.equal(saved.lead.checkedAt, checkedAt);
  assert.equal(saved.lead.httpStatus, 200);
  assert.equal(saved.lead.finalUrl, live.finalUrl);
  assert.equal(saved.lead.reason, live.reason);

  for (const state of ["closed", "blocked", "inconclusive"]) {
    const outcome = await post(base, "/api/verify", { url: `https://jobs.example.test/${state}` });
    assert.equal(outcome.status, state);
    assert.equal("verificationId" in outcome, false, `${state} must never receive a save capability`);
  }

  const forgedSave = await fetch(`${base}/api/leads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verificationId: "not-issued" }),
  });
  assert.equal(forgedSave.status, 400);
  assert.match((await forgedSave.json()).error, /Run the live verifier again/);

  const state = await (await fetch(`${base}/api/leads`)).json();
  assert.equal(state.leads.length, 1);
  assert.equal(state.resume.ready, false);
  assert.equal(state.profile.targetRoles.length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, "credentials.enc")), false);
});

async function post(base, route, payload) {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.ok, true);
  return response.json();
}
