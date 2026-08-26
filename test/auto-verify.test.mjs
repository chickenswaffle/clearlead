import test from "node:test";
import assert from "node:assert/strict";
import { autoVerify } from "../src/server.mjs";

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
    return { status: "live", url, finalUrl: url, checkedAt: "2026-08-26T12:00:00Z", reason: "fixture live" };
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
