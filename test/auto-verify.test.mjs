import test from "node:test";
import assert from "node:assert/strict";
import { autoVerify, verificationPriority } from "../src/server.mjs";

test("automatic verification is limited to the ranked slice and capped at three concurrent checks", async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const verifyFn = async (url) => {
    calls.push(url);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { status: "live", url, finalUrl: url, httpStatus: 200, checkedAt: "2026-08-26T12:00:00Z", reason: "fixture live" };
  };
  const jobs = Array.from({ length: 9 }, (_, index) => ({
    title: `Role ${index}`, company: "Acme", location: "Remote", source: "fixture", board: "fixture",
    url: `https://jobs.example/${index}`, postedAt: "2026-08-26T00:00:00Z", firstSeenAt: "2026-08-26T01:00:00Z",
  }));
  const result = await autoVerify(jobs, 5, verifyFn, new Map(), new Map());
  assert.equal(calls.length, 5);
  assert.ok(peak <= 3);
  assert.equal(result.filter((job) => job.verification?.status === "live").length, 5);
  assert.equal(result[5].verification, undefined);
});

test("automatic verification contains verifier failures as inconclusive outcomes", async () => {
  const [job] = await autoVerify([{ title: "Role", company: "Acme", url: "https://jobs.example/one" }], 1, async () => { throw new Error("boom"); }, new Map(), new Map());
  assert.equal(job.verification.status, "inconclusive");
  assert.match(job.verification.reason, /Retry/);
});

test("automatic verification refuses to call a role live without complete evidence", async () => {
  const verifications = new Map();
  const [job] = await autoVerify(
    [{ title: "Role", company: "Acme", url: "https://jobs.example/one" }],
    1,
    async (url) => ({ status: "live", url, finalUrl: url, checkedAt: "2026-08-26T12:00:00Z", reason: "missing HTTP evidence" }),
    verifications,
    new Map(),
  );
  assert.equal(job.verification.status, "inconclusive");
  assert.match(job.verification.reason, /without complete HTTP/i);
  assert.equal(job.verification.verificationId, undefined);
  assert.equal(verifications.size, 0);
});

test("a redirect response is not sufficient final live evidence", async () => {
  const [job] = await autoVerify(
    [{ title: "Role", company: "Acme", url: "https://jobs.example/one" }],
    1,
    async (url) => ({ status: "live", url, finalUrl: url, httpStatus: 302, checkedAt: "2026-08-26T12:00:00Z", reason: "redirect" }),
    new Map(),
    new Map(),
  );
  assert.equal(job.verification.status, "inconclusive");
  assert.equal(job.verification.verificationId, undefined);
});

test("verification ordering boosts live jobs without hiding blocked or inconclusive top matches", () => {
  const jobs = [
    { verificationStatus: "unverified", match: { score: 70 } },
    { verificationStatus: "blocked", match: { score: 90 } },
    { verificationStatus: "closed", match: { score: 100 } },
    { verificationStatus: "live", match: { score: 50 } },
    { verificationStatus: "inconclusive", match: { score: 80 } },
  ];
  jobs.sort((left, right) => verificationPriority(left) - verificationPriority(right) || right.match.score - left.match.score);
  assert.deepEqual(jobs.map((job) => job.verificationStatus), ["live", "blocked", "inconclusive", "unverified", "closed"]);
});
