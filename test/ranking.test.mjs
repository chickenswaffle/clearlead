import test from "node:test";
import assert from "node:assert/strict";
import { rankJob, dedupeJobs, applicationPath } from "../src/ranking.mjs";
import { normalizeResume } from "../src/resume.mjs";

const resume = normalizeResume({ text: "Senior platform engineer building Python, Kubernetes, AWS, PostgreSQL, distributed systems and observability. Led production engineering teams and reliable cloud deployments across complex products." });

test("resume ranking is explainable and deterministic", () => {
  const job = { title: "Senior Platform Engineer", location: "Remote US", description: "Build Python services on AWS and Kubernetes with PostgreSQL.", postedAt: "2026-08-25T00:00:00Z" };
  const first = rankJob(job, { resume, profile: { targetRoles: ["Platform Engineer"], locations: ["Remote"] }, now: new Date("2026-08-26T00:00:00Z") });
  const second = rankJob(job, { resume, profile: { targetRoles: ["Platform Engineer"], locations: ["Remote"] }, now: new Date("2026-08-26T00:00:00Z") });
  assert.deepEqual(first, second);
  assert.ok(first.score >= 60);
  assert.ok(first.matchedSkills.includes("python"));
  assert.deepEqual(Object.keys(first.breakdown), ["title", "resume", "location", "freshness", "application"]);
  assert.equal(first.confidence.level, "medium");
  assert.ok(first.reasons.includes("Target title alignment"));
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

test("URL dedupe preserves potentially case-sensitive paths", () => {
  const jobs = dedupeJobs([
    { company: "Resideo", title: "Technical Support Specialist", location: "Irving, TX", url: "https://jobs.example.com/Sites/CX_1/job/19191" },
    { company: "Different employer", title: "Different role", location: "Irving", url: "https://jobs.example.com/sites/cx_1/job/19191" },
  ]);
  assert.equal(jobs.length, 2);
});

test("URL dedupe removes only unambiguous tracking and trailing-slash variants", () => {
  const jobs = dedupeJobs([
    { company: "Acme", title: "Support", location: "Dallas", url: "https://jobs.example.com/Sites/job/19191/?utm_source=feed" },
    { company: "Different employer", title: "Different role", location: "Irving", url: "https://jobs.example.com/Sites/job/19191" },
  ]);
  assert.equal(jobs.length, 1);
});

test("content dedupe recognizes company suffix, spacing, and city formatting variants", () => {
  const jobs = dedupeJobs([
    { company: "100000 SRS Distribution Inc.", title: "Service Desk Analyst", location: "McKinney, TX", url: "https://one.example/job/1", description: "short" },
    { company: "srsdistribution", title: "Service Desk Analyst", location: "McKinney, Texas", url: "https://two.example/jobs/99", description: "longer canonical description" },
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, "https://two.example/jobs/99");
});

test("dedupe prefers a direct employer ATS link over an aggregator copy", () => {
  const jobs = dedupeJobs([
    { company: "Acme", title: "IT Support Specialist", location: "Dallas", url: "https://www.indeed.com/viewjob?jk=123", description: "A longer copied description from the board." },
    { company: "Acme Inc.", title: "IT Support Specialist", location: "Dallas, TX", url: "https://acme.wd5.myworkdayjobs.com/jobs/job/Dallas/IT-Support_R123", description: "Employer posting." },
  ]);
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].url, /myworkdayjobs/);
  assert.equal(applicationPath(jobs[0]).kind, "direct");
});

test("application path labels board handoffs without calling them direct", () => {
  assert.equal(applicationPath({ url: "https://www.ziprecruiter.com/jobs/123" }).kind, "board");
  assert.equal(applicationPath({ url: "https://jobs.lever.co/acme/123" }).kind, "direct");
});
