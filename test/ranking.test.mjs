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
  assert.deepEqual(Object.keys(first.breakdown), ["title", "resume", "location", "freshness", "application", "qualifications"]);
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
  assert.equal(applicationPath({ url: "https://acme.applytojob.com/apply/123" }).kind, "direct");
});

test("expanded title lists credit the closest role instead of diluting obvious alignment", () => {
  const match = rankJob({ title: "L1 Pharmacy IT Support", company: "Hospital", location: "Dallas", url: "https://hospital.applytojob.com/apply/123", description: "Support pharmacy systems and hospital users.", postedAt: "2026-09-21T00:00:00Z" }, {
    resume: { skills: ["windows"], keywords: ["support"] },
    plan: { titles: ["IT support specialist", "help desk technician", "service desk analyst", "desktop support technician"], locations: ["Dallas"], sectors: ["healthcare"] },
    location: "Dallas",
    now: new Date("2026-09-22T00:00:00Z"),
  });
  assert.equal(match.breakdown.title, 100);
  assert.equal(match.application.kind, "direct");
  assert.ok(match.reasons.includes("Target title alignment"));
});

test("entry-level ranking surfaces and penalizes heavy experience requirements", () => {
  const base = { title: "L1 IT Support", company: "Hospital", location: "Dallas", url: "https://hospital.applytojob.com/apply/123", postedAt: "2026-09-21T00:00:00Z" };
  const options = { resume: { text: "Support Analyst\n03/2020 - Present", keywords: ["support"] }, plan: { titles: ["IT support specialist"], seniority: "entry" }, location: "Dallas", now: new Date("2026-09-22T00:00:00Z") };
  const normal = rankJob({ ...base, description: "Support hospital users and computers." }, options);
  const risky = rankJob({ ...base, description: "Support hospital users. Requires 5+ years of experience in desktop support." }, options);
  assert.equal(normal.score - risky.score, 29);
  assert.match(risky.risks[0], /5\+ years/);
  assert.equal(risky.qualifications.items.find((item) => item.code === "skill-desktop-support").status, "missing");
  assert.equal(risky.decision.code, "skip");
});

test("a missing explicitly required qualification produces a skip decision", () => {
  const match = rankJob({ title: "IT Support Specialist", company: "Hospital", location: "Dallas", url: "https://hospital.applytojob.com/apply/123", description: "Support users. Security+ certification required.", postedAt: "2026-09-21T00:00:00Z" }, {
    resume: { text: "Desktop support", keywords: ["support"] }, query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
  });
  assert.equal(match.qualifications.counts.missing, 1);
  assert.equal(match.decision.code, "skip");
});

test("section-based minimum qualifications cannot receive an apply decision when unsupported", () => {
  const match = rankJob({
    title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://acme.example/jobs/1",
    description: "Minimum Qualifications:\nActive Directory\n3 years of IT support experience",
  }, {
    resume: { text: "Customer support associate\n2024 - Present", keywords: ["support"] },
    query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
  });
  assert.equal(match.qualifications.counts.missing, 2);
  assert.equal(match.decision.code, "skip");
});

test("years-before-domain requirements cannot receive a priority-apply decision", () => {
  const match = rankJob({
    title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://acme.example/jobs/2",
    description: "Minimum Qualifications\n3+ years in IT support",
  }, {
    resume: { text: "IT Support Associate\n2025 - Present", keywords: ["it", "support"] },
    query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
  });
  assert.equal(match.qualifications.items.find((item) => item.code === "experience-years")?.status, "missing");
  assert.equal(match.qualifications.counts.missing, 1);
  assert.equal(match.decision.code, "skip");
});

test("negated posting requirements do not force a skip decision", () => {
  const match = rankJob({
    title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/3", postedAt: "2026-09-21T00:00:00Z",
    description: "Support Windows users. A+ certification is not required. No bachelor's degree is required.",
  }, {
    resume: { text: "IT support for Windows users", skills: ["windows"], keywords: ["it", "support", "users"] },
    query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
  });
  assert.equal(match.qualifications.counts.missing, 0);
  assert.notEqual(match.decision.code, "skip");
});

test("a negated degree clause cannot erase a separate experience requirement", () => {
  const match = rankJob({
    title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/4", postedAt: "2026-09-21T00:00:00Z",
    description: "No bachelor's degree is required, but 3+ years in IT support is required.",
  }, {
    resume: { text: "IT Support Associate\n2025 - Present", skills: ["windows"], keywords: ["it", "support"] },
    query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
  });
  assert.equal(match.qualifications.counts.missing, 1);
  assert.equal(match.decision.code, "skip");
});

test("company tenure and optional credentials do not force a skip decision", () => {
  for (const description of ["Our company brings 25 years in IT support to customers.", "A+ certification is optional."]) {
    const match = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/5", postedAt: "2026-09-21T00:00:00Z", description }, {
      resume: { text: "IT support for Windows users", skills: ["windows"], keywords: ["it", "support"] },
      query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
    });
    assert.equal(match.qualifications.counts.missing, 0, description);
    assert.equal(match.eligibility.warnings.some((warning) => warning.code === "heavy-experience-requirement"), false, description);
    assert.notEqual(match.decision.code, "skip", description);
  }
});

test("generic qualification headings and explicit candidate tenure force a skip", () => {
  for (const description of ["Qualifications:\n3+ years in IT support", "The company requires candidates to have 5 years in IT support."]) {
    const match = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/6", postedAt: "2026-09-21T00:00:00Z", description }, {
      resume: { text: "IT Support Associate\n2025 - Present", skills: ["windows"], keywords: ["it", "support"] },
      query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
    });
    assert.equal(match.qualifications.counts.missing, 1, description);
    assert.equal(match.decision.code, "skip", description);
  }
});

test("named-company history and not-needed credentials remain actionable", () => {
  for (const description of ["Acme has 25 years of IT support experience.", "You do not need A+ certification.", "A+ certification is not needed."]) {
    const match = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/7", postedAt: "2026-09-21T00:00:00Z", description }, {
      resume: { text: "IT support for Windows users", skills: ["windows"], keywords: ["it", "support"] },
      query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
    });
    assert.equal(match.qualifications.counts.missing, 0, description);
    assert.notEqual(match.decision.code, "skip", description);
  }
});

test("no-comma certification and clause-scoped education requirements force a skip", () => {
  for (const description of ["A+ is optional but Network+ is required.", "Bachelor's degree is not required, but a high school diploma is required."]) {
    const match = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/8", postedAt: "2026-09-21T00:00:00Z", description }, {
      resume: { text: "IT Support Associate\n2025 - Present", skills: ["windows"], keywords: ["it", "support"] },
      query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
    });
    assert.equal(match.qualifications.counts.missing, 1, description);
    assert.equal(match.decision.code, "skip", description);
  }
});

test("candidate-has tenure is enforced while year-leading marketing remains actionable", () => {
  const options = {
    resume: { text: "IT Support Associate\n2025 - Present", skills: ["windows"], keywords: ["it", "support"] },
    query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
  };
  const required = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/9", postedAt: "2026-09-21T00:00:00Z", description: "The ideal candidate has 5+ years of IT support experience." }, options);
  const marketing = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/10", postedAt: "2026-09-21T00:00:00Z", description: "25 years of IT support experience powers Acme customer service." }, options);
  assert.equal(required.decision.code, "skip");
  assert.equal(marketing.qualifications.counts.missing, 0);
  assert.notEqual(marketing.decision.code, "skip");
});

test("and-polarity and natural candidate-tenure wording cannot rank apply", () => {
  for (const description of ["A+ is optional and Network+ is required.", "You should have 5+ years of IT support experience.", "We are looking for someone with 5+ years of IT support experience."]) {
    const match = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/11", postedAt: "2026-09-21T00:00:00Z", description }, {
      resume: { text: "IT Support Associate in Dallas\n2025 - Present", skills: ["windows"], keywords: ["it", "support"] },
      query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
    });
    assert.equal(match.qualifications.counts.missing, 1, description);
    assert.equal(match.decision.code, "skip", description);
  }
});

test("employment associate does not satisfy education while ten-year marketing stays visible", () => {
  const options = {
    resume: { text: "IT Support Associate in Dallas\n2025 - Present", skills: ["windows"], keywords: ["it", "support"] },
    query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
  };
  const degree = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/12", postedAt: "2026-09-21T00:00:00Z", description: "Associate degree is required." }, options);
  const marketing = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/13", postedAt: "2026-09-21T00:00:00Z", description: "10 years of IT support experience powers Acme customer service." }, options);
  assert.equal(degree.decision.code, "skip");
  assert.equal(marketing.qualifications.counts.missing, 0);
  assert.notEqual(marketing.decision.code, "skip");
});

test("qualified-and polarity and someone-who-has tenure cannot rank apply", () => {
  for (const description of ["A+ is optional for this role and Network+ is required.", "We are looking for someone who has 5+ years of IT support experience."]) {
    const match = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/14", postedAt: "2026-09-21T00:00:00Z", description }, {
      resume: { text: "Worked as an IT Support Specialist\n2025 - Present", skills: ["windows"], keywords: ["it", "support"] },
      query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
    });
    assert.equal(match.qualifications.counts.missing, 1, description);
    assert.equal(match.decision.code, "skip", description);
  }
});

test("ordinary as prose cannot satisfy an associate degree gate", () => {
  const match = rankJob({ title: "IT Support Specialist", company: "Acme", location: "Dallas", url: "https://jobs.lever.co/acme/15", postedAt: "2026-09-21T00:00:00Z", description: "Associate degree is required." }, {
    resume: { text: "Worked as an IT Support Specialist", skills: ["windows"], keywords: ["it", "support"] },
    query: "IT support specialist", location: "Dallas", now: new Date("2026-09-22T00:00:00Z"),
  });
  assert.equal(match.qualifications.items.find((item) => item.code === "education")?.status, "missing");
  assert.equal(match.decision.code, "skip");
});
