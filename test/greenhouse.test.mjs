import test from "node:test";
import assert from "node:assert/strict";
import { discoverGreenhouse } from "../src/greenhouse.mjs";

test("Greenhouse discovery maps published jobs without calling them live", async () => {
  const fetchFn = async () => new Response(JSON.stringify({
    jobs: [{
      title: "Staff Platform Engineer",
      location: { name: "Remote" },
      absolute_url: "https://boards.greenhouse.io/example/jobs/123",
      updated_at: "2026-08-26T12:00:00Z",
    }],
  }), { status: 200 });

  const result = await discoverGreenhouse("example", { fetchFn });
  assert.equal(result.error, null);
  assert.deepEqual(result.jobs, [{
    source: "greenhouse",
    board: "example",
    title: "Staff Platform Engineer",
    location: "Remote",
    url: "https://boards.greenhouse.io/example/jobs/123",
    postedAt: "2026-08-26T12:00:00Z",
  }]);
  assert.equal("status" in result.jobs[0], false);
});

test("Greenhouse failures are explicit and return no jobs", async () => {
  const result = await discoverGreenhouse("missing", {
    fetchFn: async () => new Response("not found", { status: 404 }),
  });
  assert.deepEqual(result.jobs, []);
  assert.match(result.error, /HTTP 404/);
});

test("Greenhouse discovery drops non-http source URLs", async () => {
  const fetchFn = async () => new Response(JSON.stringify({
    jobs: [{ title: "Unsafe role", absolute_url: "javascript:alert(1)" }],
  }), { status: 200 });
  const result = await discoverGreenhouse("example", { fetchFn });
  assert.deepEqual(result.jobs, []);
});

test("Greenhouse transient failures give an actionable outcome", async () => {
  const result = await discoverGreenhouse("example", {
    timeoutMs: 5,
    fetchFn: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const timeout = new Error("timed out");
        timeout.name = "AbortError";
        reject(timeout);
      }, { once: true });
    }),
  });
  assert.deepEqual(result.jobs, []);
  assert.match(result.error, /timed out.*retry or discard/i);
});
