import test from "node:test";
import assert from "node:assert/strict";
import { discoverLever, discoverAshby, discoverRemotive, discoverArbeitnow, discoverJobLedger, discoverZipRecruiter, createSourceDiscovery } from "../src/sources.mjs";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function textResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => typeof payload === "string" ? payload : JSON.stringify(payload) };
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

test("public job ledger fans out expanded terms and normalizes employer-direct descriptions", async () => {
  const urls = [];
  const ledger = await discoverJobLedger({
    plan: { ledgerQueries: ["help desk", "technical support"], filters: { country: "US", state: "TX" } },
    fetchFn: async (url) => {
      urls.push(String(url));
      return response({ data: [{ title: "Technical Support Specialist", company: "Hospital One", location: "Dallas", apply_url: "https://example.org/apply/1", source: "workday", posted_at: "2026-08-20T00:00:00Z", description: "Support hospital computers and users." }] });
    },
  });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /country=US/);
  assert.match(urls[0], /state=TX/);
  assert.equal(ledger.jobs.length, 1, "duplicate listings from query fan-out are removed");
  assert.equal(ledger.jobs[0].description, "Support hospital computers and users.");
  assert.equal(ledger.jobs[0].board, "workday");
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

test("public job ledger cache is isolated by the generated search plan", async () => {
  let calls = 0;
  const discover = createSourceDiscovery({ fetchFn: async () => { calls += 1; return response({ data: [] }); }, now: () => 1000 });
  await discover({ type: "jobledger", token: "employer-direct" }, { plan: { ledgerQueries: ["help desk"], filters: { state: "TX" } } });
  await discover({ type: "jobledger", token: "employer-direct" }, { plan: { ledgerQueries: ["help desk"], filters: { state: "TX" } } });
  await discover({ type: "jobledger", token: "employer-direct" }, { plan: { ledgerQueries: ["data analyst"], filters: { state: "TX" } } });
  assert.equal(calls, 2);
});

test("ZipRecruiter public MCP results are normalized without claiming direct application", async () => {
  let request;
  const result = await discoverZipRecruiter({ fetchFn: async (_url, options) => {
    request = JSON.parse(options.body);
    return textResponse({ jsonrpc: "2.0", id: 1, result: { structuredContent: { jobs: [{ title: "IT Support Technician", company_name: "Hospital One", location: { city: "Dallas", state: "TX" }, job_url: "https://www.ziprecruiter.com/jobs/abc", description: "Support users and computers", posted_at: "2026-09-21T00:00:00Z" }] } } });
  } });
  assert.equal(request.params.name, "search_jobs");
  assert.deepEqual(request.params.arguments, {});
  assert.equal(result.jobs[0].company, "Hospital One");
  assert.equal(result.jobs[0].source, "ziprecruiter");
  assert.equal(result.queryMode, "supplemental-unfiltered");
  assert.match(result.note, /does not accept this search query/i);
});

test("ZipRecruiter rate limits remain explicit and non-fatal", async () => {
  const result = await discoverZipRecruiter({ fetchFn: async () => textResponse("Too Many Requests", 429) });
  assert.match(result.error, /rate-limited/i);
  assert.deepEqual(result.jobs, []);
});
