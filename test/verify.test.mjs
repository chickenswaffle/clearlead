import test from "node:test";
import assert from "node:assert/strict";
import { verifyPosting } from "../src/verify.mjs";

const clock = () => new Date("2026-08-24T18:00:00.000Z");
const fake = (status, html, url = "https://jobs.example.test/role") => async () => new Response(html, { status, headers: { "content-type": "text/html" } });

test("marks a role live only when a job detail signal is present", async () => {
  const result = await verifyPosting("https://jobs.example.test/role", { fetchFn: fake(200, "<h1>Staff Engineer</h1><p>Job Description</p><button>Apply now</button>"), now: clock });
  assert.equal(result.status, "live");
  assert.equal(result.httpStatus, 200);
  assert.match(result.reason, /apply or role-detail/i);
});

test("marks explicit closed evidence as closed", async () => {
  const result = await verifyPosting("https://jobs.example.test/expired", { fetchFn: fake(200, "<h1>This position is closed</h1>"), now: clock });
  assert.equal(result.status, "closed");
});

test("reports a bot challenge as blocked, not silently waiting", async () => {
  const result = await verifyPosting("https://jobs.example.test/challenge", { fetchFn: fake(200, "<h1>Checking your browser before accessing</h1>"), now: clock });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /bot challenge/i);
});

test("does not lie when a page loads without job evidence", async () => {
  const result = await verifyPosting("https://jobs.example.test/unknown", { fetchFn: fake(200, "<h1>Welcome</h1>"), now: clock });
  assert.equal(result.status, "inconclusive");
  assert.match(result.reason, /no reliable/i);
});

test("treats a network failure as actionable inconclusive", async () => {
  const result = await verifyPosting("https://jobs.example.test/offline", { fetchFn: async () => { throw new Error("offline"); }, now: clock });
  assert.equal(result.status, "inconclusive");
  assert.match(result.reason, /could not be reached/i);
});
