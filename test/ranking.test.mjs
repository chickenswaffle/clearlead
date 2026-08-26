import test from "node:test";
import assert from "node:assert/strict";
import { rankJob, dedupeJobs } from "../src/ranking.mjs";
import { normalizeResume } from "../src/resume.mjs";

const resume = normalizeResume({ text: "Senior platform engineer building Python, Kubernetes, AWS, PostgreSQL, distributed systems and observability. Led production engineering teams and reliable cloud deployments across complex products." });

test("resume ranking is explainable and deterministic", () => {
  const job = { title: "Senior Platform Engineer", location: "Remote US", description: "Build Python services on AWS and Kubernetes with PostgreSQL.", postedAt: "2026-08-25T00:00:00Z" };
  const first = rankJob(job, { resume, profile: { targetRoles: ["Platform Engineer"], locations: ["Remote"] }, now: new Date("2026-08-26T00:00:00Z") });
  const second = rankJob(job, { resume, profile: { targetRoles: ["Platform Engineer"], locations: ["Remote"] }, now: new Date("2026-08-26T00:00:00Z") });
  assert.deepEqual(first, second);
  assert.ok(first.score >= 60);
  assert.ok(first.matchedSkills.includes("python"));
  assert.deepEqual(Object.keys(first.breakdown), ["title", "resume", "location", "freshness"]);
});

test("dedupe removes exact URLs and aggregator copies", () => {
  const jobs = dedupeJobs([
    { company: "Acme", title: "Platform Engineer", location: "Remote", url: "https://one/job", description: "short" },
    { company: "Acme", title: "Senior Platform Engineer", location: "Remote", url: "https://two/job", description: "a much longer canonical description" },
    { company: "Other", title: "Copy", location: "Remote", url: "https://one/job" },
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, "https://two/job");
});
