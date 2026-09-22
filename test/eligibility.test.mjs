import test from "node:test";
import assert from "node:assert/strict";
import { evaluateJobEligibility, requiredSectorsFromProfile } from "../src/eligibility.mjs";

const NOW = new Date("2026-09-22T12:00:00Z");

test("qualified recent roles pass with explicit eligibility evidence", () => {
  const result = evaluateJobEligibility({
    title: "IT Support Specialist",
    company: "North Texas Medical Center",
    description: "Support hospital users, endpoints, and network access.",
    postedAt: "2026-09-18T12:00:00Z",
  }, {
    resume: { text: "IT support, Windows, networking, and customer service." },
    profile: { mustHaves: ["hospital or healthcare"] },
    plan: { seniority: "entry", requiredSectors: ["healthcare"] },
    now: NOW,
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.matchedSectors, ["healthcare"]);
});

test("SkillBridge roles are rejected without candidate program evidence", () => {
  const result = evaluateJobEligibility({
    title: "Technical Support Specialist - DoD SkillBridge",
    description: "This opportunity is available through the DoD SkillBridge program.",
    postedAt: "2026-09-18T12:00:00Z",
  }, { resume: { text: "Technical support and networking." }, now: NOW });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => reason.code === "skillbridge-only"));
});

test("candidate evidence permits relevant special-program roles", () => {
  const result = evaluateJobEligibility({
    title: "Technical Support Specialist - DoD SkillBridge",
    postedAt: "2026-09-18T12:00:00Z",
  }, { resume: { text: "Transitioning service member approved for DoD SkillBridge." }, now: NOW });
  assert.equal(result.eligible, true);
});

test("stale roles and senior roles are hard rejections", () => {
  const stale = evaluateJobEligibility({ title: "IT Support Specialist", postedAt: "2026-01-01T00:00:00Z" }, { now: NOW });
  const senior = evaluateJobEligibility({ title: "Senior IT Support Manager", postedAt: "2026-09-20T00:00:00Z" }, { plan: { seniority: "entry" }, now: NOW });
  assert.ok(stale.reasons.some((reason) => reason.code === "stale-posting"));
  assert.ok(senior.reasons.some((reason) => reason.code === "seniority-mismatch"));
});

test("entry searches flag contradictory five-plus-year requirements for review", () => {
  const result = evaluateJobEligibility({
    title: "L1 IT Support",
    description: "Entry level role. Bachelor's degree; 5+ years' experience in desktop support, or equivalent experience.",
    postedAt: "2026-09-20T00:00:00Z",
  }, { plan: { seniority: "entry" }, now: NOW });
  assert.equal(result.eligible, true);
  assert.ok(result.warnings.some((warning) => warning.code === "heavy-experience-requirement"));
});

test("active clearance requirements fail closed without matching evidence", () => {
  const result = evaluateJobEligibility({
    title: "Help Desk Technician",
    description: "An active Secret security clearance is required.",
    postedAt: "2026-09-20T00:00:00Z",
  }, { resume: { text: "Windows and Active Directory support." }, now: NOW });
  assert.ok(result.reasons.some((reason) => reason.code === "clearance-required"));
});

test("profile sector language becomes an any-of hard sector gate", () => {
  const profile = { mustHaves: ["hospital or healthcare", "school or school district"] };
  assert.deepEqual(requiredSectorsFromProfile(profile), ["healthcare", "education"]);
  const result = evaluateJobEligibility({
    title: "Help Desk Technician",
    company: "Retail Warehouse",
    description: "Support store employees.",
    postedAt: "2026-09-20T00:00:00Z",
  }, { profile, now: NOW });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => reason.code === "required-sector-mismatch"));
});

test("generic education requirements do not impersonate an education employer", () => {
  const result = evaluateJobEligibility({
    title: "Technical Support Analyst",
    company: "Industrial Technology Corp",
    description: "Education: high school diploma required. Medical and dental benefits are available.",
    postedAt: "2026-09-20T00:00:00Z",
  }, {
    profile: { mustHaves: ["hospital or healthcare", "school or school district"] },
    now: NOW,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.matchedSectors, []);
});

test("serving a sector in prose does not impersonate an employer in that sector", () => {
  const result = evaluateJobEligibility({
    title: "Technical Support Specialist",
    company: "Generic Video Systems",
    description: "Our customers include hospitals, schools, universities, and medical centers.",
    postedAt: "2026-09-20T00:00:00Z",
  }, {
    profile: { mustHaves: ["hospital or healthcare", "school or school district"] },
    now: NOW,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.matchedSectors, []);
});
