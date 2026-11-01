import test from "node:test";
import assert from "node:assert/strict";
import { verifyPosting } from "../src/verify.mjs";

const clock = () => new Date("2026-08-24T18:00:00.000Z");
const fake = (status, html, url = "https://jobs.example.test/role") => async () => new Response(html, { status, headers: { "content-type": "text/html" } });
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const options = (fetchFn) => ({ fetchFn, lookupFn: publicLookup, now: clock });

test("marks a role live only when a job detail signal is present", async () => {
  const result = await verifyPosting("https://jobs.example.test/role", options(fake(200, "<h1>Staff Engineer</h1><p>Job Description</p><button>Apply now</button>")));
  assert.equal(result.status, "live");
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.signals, ["apply action", "job description"]);
});

test("uses Workday's public job API when its apply button is client-rendered", async () => {
  const pageUrl = "https://motorolasolutions.wd5.myworkdayjobs.com/careers/job/Allen-TX-TX139/Technical-Support-Analyst--Hybrid-_R67087";
  const requested = [];
  const fetchFn = async (url, options) => {
    requested.push({ url: String(url), accept: options.headers.accept });
    if (String(url).includes("/wday/cxs/")) {
      return new Response(JSON.stringify({ jobPostingInfo: {
        jobPostingId: "Technical-Support-Analyst--Hybrid-_R67087",
        canApply: true,
        posted: true,
        jobDescription: "Technical support role with networking, troubleshooting, and customer incident responsibilities.",
      } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response('<h1>Technical Support Analyst</h1><h2>Job Description</h2><script type="application/ld+json">{"@type":"JobPosting"}</script>', { status: 200 });
  };
  const result = await verifyPosting(pageUrl, { fetchFn, lookupFn: publicLookup, now: clock });
  assert.equal(result.status, "live");
  assert.equal(result.verificationMethod, "workday public job API");
  assert.deepEqual(result.signals, ["apply action", "job description", "job schema"]);
  assert.match(requested[1].url, /\/wday\/cxs\/motorolasolutions\/careers\/job\/Allen-TX-TX139\/Technical-Support-Analyst--Hybrid-_R67087$/);
  assert.equal(requested[1].accept, "application/json");
});

test("Workday apply links are verified against the posting they apply to", async () => {
  const requested = [];
  const fetchFn = async (url) => {
    requested.push(String(url));
    if (String(url).includes("/wday/cxs/")) {
      return new Response(JSON.stringify({ jobPostingInfo: { jobPostingId: "Executive-Assistant_JR102116", canApply: true, posted: true, jobDescription: "Support the executive team with calendars, travel, and board materials." } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("<html><body><div id='root'></div></body></html>", { status: 200 });
  };
  const result = await verifyPosting("https://dfwairport.wd5.myworkdayjobs.com/External/job/Airport-Headquarters/Executive-Assistant_JR102116/apply/autofillWithResume", { fetchFn, lookupFn: publicLookup, now: clock });
  assert.equal(result.status, "live");
  assert.equal(result.verificationMethod, "workday public job API");
  assert.match(requested[1], /\/wday\/cxs\/dfwairport\/External\/job\/Airport-Headquarters\/Executive-Assistant_JR102116$/);
});

test("does not trust mismatched or non-applicable Workday API data", async () => {
  const pageUrl = "https://acme.wd1.myworkdayjobs.com/jobs/job/Dallas/Support-Tech_R7";
  for (const posting of [
    { jobPostingId: "Different-Role_R8", canApply: true, posted: true, jobDescription: "Full job description with enough detail to otherwise qualify." },
    { jobPostingId: "Support-Tech_R7", canApply: false, posted: true, jobDescription: "Full job description with enough detail to otherwise qualify." },
  ]) {
    const fetchFn = async (url) => String(url).includes("/wday/cxs/")
      ? new Response(JSON.stringify({ jobPostingInfo: posting }), { status: 200 })
      : new Response("<h2>Job Description</h2>", { status: 200 });
    const result = await verifyPosting(pageUrl, { fetchFn, lookupFn: publicLookup, now: clock });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.signals.includes("apply action"), false);
  }
});

test("marks explicit closed evidence as closed", async () => {
  const result = await verifyPosting("https://jobs.example.test/expired", options(fake(200, "<h1>This position is closed</h1>")));
  assert.equal(result.status, "closed");
});

test("reports a bot challenge as blocked, not silently waiting", async () => {
  const result = await verifyPosting("https://jobs.example.test/challenge", options(fake(200, "<h1>Checking your browser before accessing</h1>")));
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /bot challenge/i);
});

test("does not lie when a page loads without job evidence", async () => {
  const result = await verifyPosting("https://jobs.example.test/unknown", options(fake(200, "<h1>Welcome</h1>")));
  assert.equal(result.status, "inconclusive");
  assert.match(result.reason, /both an apply action and job-detail evidence/i);
});

test("treats a network failure as actionable inconclusive", async () => {
  const result = await verifyPosting("https://jobs.example.test/offline", options(async () => { throw new Error("offline"); }));
  assert.equal(result.status, "inconclusive");
  assert.match(result.reason, /could not be reached/i);
});

test("does not call generic careers copy live without combined evidence", async () => {
  const result = await verifyPosting("https://jobs.example.test/careers", options(fake(200, "<h1>Careers</h1><p>Apply to join us.</p>")));
  assert.equal(result.status, "inconclusive");
  assert.deepEqual(result.signals, []);
});

test("requires an interactive application control instead of the verb apply in job prose", async () => {
  const result = await verifyPosting("https://jobs.example.test/security", options(fake(200, "<h1>Security Engineer</h1><h2>Responsibilities</h2><p>Apply security patches and document remediation.</p>")));
  assert.equal(result.status, "inconclusive");
  assert.equal(result.signals.includes("apply action"), false);
});

test("disabled, hidden, and unusable apply controls cannot establish liveness", async () => {
  for (const control of [
    '<button disabled>Apply now</button>',
    '<button aria-disabled="true">Apply now</button>',
    '<button hidden>Apply now</button>',
    '<button style="display:none">Apply now</button>',
    '<button class="hidden">Apply now</button>',
    '<a href="#">Apply now</a>',
  ]) {
    const result = await verifyPosting("https://jobs.example.test/unavailable-control", options(fake(200, `<h2>Responsibilities</h2>${control}`)));
    assert.equal(result.status, "inconclusive", control);
    assert.equal(result.signals.includes("apply action"), false, control);
  }
});

test("does not call legitimate job prose a bot challenge", async () => {
  const html = "<h1>Security Support Engineer</h1><h2>Responsibilities</h2><p>Troubleshoot access denied errors and explain CAPTCHA integrations.</p><a href='/apply'>Apply now</a>";
  const result = await verifyPosting("https://jobs.example.test/security-support", options(fake(200, html)));
  assert.equal(result.status, "live");
});

test("treats an HTTP access restriction as blocked even without challenge copy", async () => {
  const result = await verifyPosting("https://jobs.example.test/restricted", options(fake(403, "<h1>Forbidden</h1>")));
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /HTTP 403|access/i);
});

test("does not treat ordinary 404 or Cloudflare job text as status evidence", async () => {
  const result = await verifyPosting("https://jobs.example.test/cloud-role", options(fake(200, "<h1>Cloudflare Engineer</h1><p>Own our 404 strategy.</p>")));
  assert.equal(result.status, "inconclusive");
});

test("blocks loopback, private DNS answers, and private redirect targets", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  };
  const redirected = await verifyPosting("https://jobs.example.test/role", { fetchFn, lookupFn: publicLookup, now: clock });
  assert.equal(redirected.status, "inconclusive");
  assert.match(redirected.reason, /private, local, or reserved/i);
  assert.equal(calls, 1);

  const privateDns = await verifyPosting("https://jobs.example.test/role", {
    fetchFn: async () => { throw new Error("should not fetch"); },
    lookupFn: async () => [{ address: "10.0.0.5", family: 4 }],
    now: clock,
  });
  assert.match(privateDns.reason, /private, local, or reserved/i);
});
