import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidateTruth, candidateTruthSummary } from "../src/candidate-truth.mjs";

const resume = `# Taylor Candidate
taylor@example.com | Dallas, TX

## Summary
IT support specialist focused on reliable endpoint service.

## Experience
Support Technician | Acme
2022 - Present
- Resolved 95% of tickets within SLA across 100+ endpoints.
- Reduced repeat incidents by 30% through documentation.

## Skills
Windows, Linux, Active Directory`;

test("candidate truth preserves source facts, metrics, and review boundaries", () => {
  const truth = buildCandidateTruth({
    resume: { text: resume, filename: "resume.md", savedAt: "2026-09-20T00:00:00Z" },
    applicationProfile: { fullName: "Taylor Candidate", email: "taylor@example.com", workAuthorization: "yes", needsSponsorship: "unknown", age18OrOlder: "yes", restrictiveAgreement: "no", workArrangement: "either", savedAt: "2026-09-20T00:00:00Z" },
    builtAt: "2026-09-22T00:00:00Z",
  });
  assert.equal(truth.schema, "clearlead-candidate-truth/v1");
  assert.equal(truth.fingerprint.length, 64);
  const sla = truth.facts.find((fact) => fact.sourceText.includes("95%"));
  assert.equal(sla.type, "achievement");
  assert.equal(sla.rewritable, true);
  assert.deepEqual(sla.immutableTokens, ["95%", "100+"]);
  const authorization = truth.answers.find((answer) => answer.key === "eligibility.workAuthorization");
  const sponsorship = truth.answers.find((answer) => answer.key === "eligibility.needsSponsorship");
  assert.equal(authorization.status, "known");
  assert.equal(authorization.reviewRequired, true);
  assert.equal(sponsorship.status, "unknown");
  assert.equal(truth.answers.find((answer) => answer.key === "eligibility.age18OrOlder").value, "yes");
  assert.equal(truth.answers.find((answer) => answer.key === "eligibility.restrictiveAgreement").value, "no");
  assert.equal(truth.answers.find((answer) => answer.key === "preference.workArrangement").value, "either");
});

test("candidate truth summary exposes counts without resume or contact text", () => {
  const truth = buildCandidateTruth({ resume: { text: resume }, applicationProfile: { fullName: "Taylor Candidate", email: "taylor@example.com" } });
  const summary = candidateTruthSummary(truth);
  assert.equal(summary.ready, true);
  assert.ok(summary.factCount >= 8);
  assert.ok(summary.claimCount >= 3);
  assert.ok(summary.metricCount >= 3);
  assert.equal(JSON.stringify(summary).includes("taylor@example.com"), false);
});
