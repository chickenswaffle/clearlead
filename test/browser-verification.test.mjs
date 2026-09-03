import test from "node:test";
import assert from "node:assert/strict";
import { browserVerificationFromEvidence } from "../src/browser-verification.mjs";

const now = () => new Date("2026-09-01T16:00:00.000Z");

test("paired browser capture calls a rendered role live only with complete evidence", () => {
  const result = browserVerificationFromEvidence({
    pageUrl: "https://jobs.example.com/apply/7#application",
    pageTitle: "Support Technician",
    httpStatus: 200,
    signals: ["apply action", "responsibilities", "untrusted signal"],
    fullPageText: "must never travel through the boundary",
  }, { job: { source: "jobledger", company: "Acme", title: "Support Technician", url: "https://jobs.example.com/apply/7" }, now });
  assert.equal(result.status, "live");
  assert.equal(result.finalUrl, "https://jobs.example.com/apply/7");
  assert.equal(result.verificationMethod, "paired browser capture");
  assert.equal(result.trustedJobMetadata, true);
  assert.deepEqual(result.signals, ["apply action", "responsibilities"]);
  assert.equal("fullPageText" in result, false);
});

test("paired browser capture keeps an unsolved challenge blocked and actionable", () => {
  const result = browserVerificationFromEvidence({ pageUrl: "https://jobs.example.com/7", httpStatus: 200, signals: ["access challenge"] }, { now });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /Complete it manually/i);
});

test("paired browser capture is inconclusive without HTTP, apply, and detail evidence", () => {
  const result = browserVerificationFromEvidence({ pageUrl: "https://jobs.example.com/7", signals: ["job description"] }, { now });
  assert.equal(result.status, "inconclusive");
  assert.match(result.reason, /2xx navigation status/);
  assert.match(result.reason, /usable apply action/);
});

test("paired browser capture recognizes explicit closed evidence", () => {
  const result = browserVerificationFromEvidence({ pageUrl: "https://jobs.example.com/7", httpStatus: 200, signals: ["closed language"] }, { now });
  assert.equal(result.status, "closed");
});

test("paired browser capture rejects local and private destinations", () => {
  for (const pageUrl of ["http://127.0.0.1:4173/", "https://localhost/job", "https://172.20.1.2/job", "https://[::1]/job"]) {
    const result = browserVerificationFromEvidence({ pageUrl, httpStatus: 200, signals: ["apply action", "job description"] }, { now });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.finalUrl, undefined);
    assert.match(result.reason, /public HTTPS job URL/i);
  }
});
