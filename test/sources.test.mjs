import test from "node:test";
import assert from "node:assert/strict";
import { discoverLever, discoverAshby, discoverRemotive, discoverArbeitnow, createSourceDiscovery } from "../src/sources.mjs";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("Lever fixture maps a published posting without claiming liveness", async () => {
  const result = await discoverLever("acme", { fetchFn: async () => response([{ id: "1", text: "Platform Engineer", categories: { location: "Remote" }, hostedUrl: "https://jobs.lever.co/acme/1", descriptionPlain: "Python systems", createdAt: 1787700000000 }]) });
  assert.equal(result.jobs[0].source, "lever");
  assert.equal(result.jobs[0].title, "Platform Engineer");
  assert.equal("status" in result.jobs[0], false);
});

test("Ashby fixture drops hidden and unsafe postings", async () => {
  const result = await discoverAshby("acme", { fetchFn: async () => response({ jobs: [
    { title: "Listed", location: "Chicago", isListed: true, jobUrl: "https://jobs.ashbyhq.com/acme/1", descriptionPlain: "SQL" },
    { title: "Hidden", isListed: false, jobUrl: "https://jobs.ashbyhq.com/acme/2" },
    { title: "Unsafe", isListed: true, jobUrl: "file:///tmp/job" },
  ] }) });
  assert.deepEqual(result.jobs.map((job) => job.title), ["Listed"]);
});

test("broad feed fixtures normalize Remotive and Arbeitnow", async () => {
  const remotive = await discoverRemotive({ fetchFn: async () => response({ jobs: [{ title: "AI Engineer", company_name: "Acme", url: "https://remotive.com/job/1", candidate_required_location: "Worldwide", description: "<p>Python</p>" }] }) });
  const arbeitnow = await discoverArbeitnow({ fetchFn: async () => response({ data: [{ title: "Data Engineer", company_name: "Beta", url: "https://arbeitnow.com/job/2", location: "Berlin", description: "<b>SQL</b>", created_at: 1787700000 }] }) });
  assert.equal(remotive.jobs[0].description, "Python");
  assert.equal(arbeitnow.jobs[0].description, "SQL");
});

test("source failures stay explicit and successful feeds are cached", async () => {
  let calls = 0;
  const discover = createSourceDiscovery({ fetchFn: async () => { calls += 1; return response({ jobs: [] }); }, now: () => 1000 });
  await discover({ type: "remotive" });
  const cached = await discover({ type: "remotive" });
  assert.equal(calls, 1);
  assert.equal(cached.cached, true);
  const failed = await discoverLever("acme", { fetchFn: async () => response({}, 503) });
  assert.match(failed.error, /HTTP 503/);
  assert.deepEqual(failed.jobs, []);
});
