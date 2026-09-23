import test from "node:test";
import assert from "node:assert/strict";
import { analyzeQualifications } from "../src/qualifications.mjs";

test("qualification analysis distinguishes proven, reviewable, and missing requirements", () => {
  const result = analyzeQualifications({
    title: "Support Technician",
    description: "Bachelor's degree or equivalent experience. 5+ years' experience. Security+ certification required.",
  }, {
    text: "Experience\nSupport Analyst\n03/2020 - Present\nEducation\nAssociate degree in technology",
    skills: ["Windows"],
  }, { now: new Date("2026-09-22T00:00:00Z") });
  assert.equal(result.items.find((item) => item.code === "experience-years").status, "uncertain");
  assert.equal(result.items.find((item) => item.code === "education").status, "uncertain");
  assert.equal(result.items.find((item) => item.code === "cert-security").status, "missing");
  assert.equal(result.penalty, 23);
  assert.match(result.items[0].postingEvidence, /5\+ years/);
  assert.match(result.items[0].candidateEvidence, /[67] years/);
});

test("matching degree and certification evidence are credited without inventing relevance", () => {
  const result = analyzeQualifications({ description: "Bachelor's degree required. ITIL certification required." }, { text: "Bachelor of Science\nITIL Foundation certified" });
  assert.deepEqual(result.items.map((item) => item.status), ["met", "met"]);
  assert.equal(result.penalty, 0);
});

test("preferred certifications are typed and do not become hard missing counts", () => {
  const result = analyzeQualifications({ description: "A+ and Network+ are highly desirable." }, { text: "Desktop support" });
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((item) => item.importance === "preferred" && item.status === "missing"));
  assert.equal(result.counts.missing, 0);
  assert.equal(result.counts.preferredMissing, 2);
});

test("spelled-out experience and required language cannot score as risk-free", () => {
  const result = analyzeQualifications({ description: "Five years experience required. Fluent Spanish required." }, { text: "Windows help desk" });
  assert.equal(result.items.find((item) => item.code === "experience-years").status, "missing");
  assert.equal(result.items.find((item) => item.code === "language-spanish").status, "missing");
  assert.equal(result.counts.missing, 2);
});

test("skills, clearance, and onsite location constraints remain individually auditable", () => {
  const result = analyzeQualifications({
    location: "Dallas, TX",
    description: "Kubernetes is required. Active security clearance required. This is an onsite role and local candidates are required.",
  }, { text: "Built Kubernetes services.\nActive security clearance." }, {
    applicationProfile: { city: "Dallas", state: "TX" },
  });
  assert.equal(result.items.find((item) => item.code === "skill-kubernetes").status, "met");
  assert.equal(result.items.find((item) => item.code === "security-clearance").status, "met");
  assert.equal(result.items.find((item) => item.code === "location").status, "met");
});

test("minimum-qualification sections make listed skills and domain-qualified experience required", () => {
  const result = analyzeQualifications({
    description: "Minimum Qualifications:\nActive Directory\n3 years of IT support experience",
  }, { text: "General customer support\n2024 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
  const experience = result.items.find((item) => item.code === "experience-years");
  const activeDirectory = result.items.find((item) => item.code === "skill-active-directory");
  assert.equal(experience.importance, "required");
  assert.equal(experience.status, "missing");
  assert.equal(activeDirectory.importance, "required");
  assert.equal(activeDirectory.status, "missing");
  assert.equal(result.counts.missing, 2);
});

test("negated availability conflicts with required weekend and overnight schedules", () => {
  for (const preference of ["No weekends", "Cannot work overnight"]) {
    const result = analyzeQualifications({ description: "Requirements:\nMust be available for weekends and overnight shifts." }, { text: "IT support" }, { profile: { preferences: [preference] } });
    const schedule = result.items.find((item) => item.code === "schedule");
    assert.equal(schedule.importance, "required");
    assert.equal(schedule.status, "missing");
    assert.match(schedule.explanation, /conflicts/i);
  }
});

test("required heading context stops at the next unrelated section", () => {
  const result = analyzeQualifications({ description: "Minimum Qualifications:\nActive Directory\nPreferred Skills:\nKubernetes" }, { text: "Active Directory" });
  assert.equal(result.items.find((item) => item.code === "skill-active-directory").importance, "required");
  assert.equal(result.items.find((item) => item.code === "skill-kubernetes").importance, "preferred");
});
