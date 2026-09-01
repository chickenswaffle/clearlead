import test from "node:test";
import assert from "node:assert/strict";
import { analyzeResume, normalizeResume, resumeSummary, terms } from "../src/resume.mjs";

const text = `# Taylor Example

Senior software engineer with experience building machine learning and data engineering systems.

## Experience
- Built Python services on AWS with Docker and Kubernetes.
- Led React and TypeScript product delivery.
- Designed PostgreSQL data models and Kafka pipelines.`;

test("resume intake stays deterministic and exposes only a summary", () => {
  const resume = normalizeResume({ text, filename: "resume.md" }, () => new Date("2026-08-26T12:00:00Z"));
  assert.equal(resume.ready, true);
  assert.ok(resume.skills.includes("python"));
  assert.ok(resume.skills.includes("kubernetes"));
  const summary = resumeSummary(resume);
  assert.equal("text" in summary, false);
  assert.equal(summary.filename, "resume.md");
});

test("short resume text is not considered ready", () => {
  assert.equal(analyzeResume("Python engineer").ready, false);
});

test("ranking terms exclude generic prose that creates fake resume matches", () => {
  assert.deepEqual(terms("Experience across teams by working in support with Python"), ["teams", "support", "python"]);
});
