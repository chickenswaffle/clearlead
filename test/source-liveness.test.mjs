import test from "node:test";
import assert from "node:assert/strict";
import { verifyPosting } from "../src/verify.mjs";

const sources = {
  lever: "https://jobs.lever.co/acme/one",
  ashby: "https://jobs.ashbyhq.com/acme/one",
  remotive: "https://remotive.com/remote-jobs/one",
  arbeitnow: "https://www.arbeitnow.com/jobs/one",
  jobledger: "https://jobs.example.com/employer-direct/one",
  ziprecruiter: "https://www.ziprecruiter.com/jobs/acme/support-technician-123456",
};
const cases = {
  live: { status: 200, body: "<h1>Platform Engineer</h1><h2>Responsibilities</h2><p>Build systems</p><button>Apply now</button>" },
  closed: { status: 200, body: "<h1>This role is no longer available</h1>" },
  blocked: { status: 403, body: "<h1>Verify you are human</h1><p>Captcha</p>" },
  inconclusive: { status: 503, body: "<h1>Temporary upstream problem</h1>" },
};

for (const [source, url] of Object.entries(sources)) {
  for (const [expected, fixture] of Object.entries(cases)) {
    test(`${source} ${expected} liveness fixture remains explicit`, async () => {
      const result = await verifyPosting(url, {
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchFn: async () => ({
          status: fixture.status,
          ok: fixture.status >= 200 && fixture.status < 300,
          headers: { get: () => null },
          text: async () => fixture.body,
        }),
        now: () => new Date("2026-08-26T12:00:00Z"),
      });
      assert.equal(result.status, expected);
    });
  }
}
