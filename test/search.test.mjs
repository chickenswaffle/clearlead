import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchConfig, searchPublishedRoles } from "../src/search.mjs";

test("search config validates, deduplicates, and caps company boards", () => {
  const config = normalizeSearchConfig({
    boards: ["Figma", "figma", "bad board", ...Array.from({ length: 20 }, (_, index) => `board-${index}`)],
    query: "  platform engineer  ",
    smartPrompt: "  platform jobs near me  ",
    refreshMinutes: 2,
  });
  assert.equal(config.boards[0], "figma");
  assert.equal(config.boards.includes("bad board"), false);
  assert.equal(config.boards.length, 20);
  assert.deepEqual(config.greenhouseBoards, config.boards);
  assert.equal(config.query, "platform engineer");
  assert.equal(config.smartPrompt, "platform jobs near me");
  assert.equal(config.refreshMinutes, 2);
  const expanded = Array.from({ length: 14 }, (_, index) => `technical support role ${index}`).join(", ");
  assert.equal(normalizeSearchConfig({ query: expanded }).query, expanded);
});

test("multi-board search filters, deduplicates, scores, and reports source failures", async () => {
  const discoverFn = async (board) => {
    if (board === "broken") return { jobs: [], error: "feed unavailable" };
    return {
      error: null,
      jobs: [
        { board, title: "Staff Platform Engineer", location: "Remote — US", url: "https://jobs.example/staff", postedAt: "2026-08-26T12:00:00Z" },
        { board, title: "Account Executive", location: "Remote — US", url: `https://jobs.example/${board}/sales`, postedAt: "2026-08-25T12:00:00Z" },
      ],
    };
  };
  const result = await searchPublishedRoles({
    boards: ["figma", "broken", "reddit"],
    query: "platform engineer",
    location: "remote",
  }, { discoverFn, now: () => new Date("2026-08-26T18:00:00Z") });

  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].title, "Staff Platform Engineer");
  assert.equal(result.jobs[0].relevance.score, 62);
  assert.equal(result.jobs[0].match.breakdown.title, 100);
  assert.equal(result.jobs[0].verificationStatus, "unverified");
  assert.equal(result.sources.find((source) => source.board === "broken").ok, false);
  assert.equal(result.funnel.discovered, 4);
  assert.equal(result.funnel.titleMismatch, 2);
  assert.equal(result.funnel.eligibleBeforeDedupe, 2);
  assert.equal(result.funnel.duplicatesRemoved, 1);
  assert.equal(result.funnel.fitSkipped, 0);
});

test("source diagnostics distinguish upstream query coverage from locally filtered pools", async () => {
  const result = await searchPublishedRoles({ broadFeeds: ["jobledger", "ziprecruiter", "remotive", "arbeitnow"], greenhouseBoards: ["acme"], query: "support" }, {
    discoverSourceFn: async (source) => ({
      jobs: [],
      error: null,
      queryMode: source.type === "ziprecruiter" ? "supplemental-unfiltered" : undefined,
      note: source.type === "ziprecruiter" ? "Filtered locally." : "",
    }),
    now: () => new Date("2026-09-22T12:00:00Z"),
  });
  assert.equal(result.sources.find((source) => source.type === "jobledger").queryMode, "query-aligned");
  assert.equal(result.sources.find((source) => source.type === "ziprecruiter").queryMode, "supplemental-unfiltered");
  assert.equal(result.sources.find((source) => source.type === "remotive").queryMode, "full-feed-local-filtered");
  assert.equal(result.sources.find((source) => source.type === "arbeitnow").queryMode, "full-feed-local-filtered");
  assert.equal(result.sources.find((source) => source.type === "greenhouse").queryMode, "employer-board-local-filtered");
});

test("search supports comma-separated role and location alternatives", async () => {
  const discoverFn = async () => ({ error: null, jobs: [
    { title: "Head of Applied AI", location: "New York, NY", url: "https://jobs.example/ai" },
    { title: "Platform Engineer", location: "New Jersey", url: "https://jobs.example/platform" },
  ] });
  const result = await searchPublishedRoles({
    boards: ["example"],
    query: "head of AI, platform engineer",
    location: "New York, Chicago",
  }, { discoverFn });
  assert.deepEqual(result.jobs.map((job) => job.url), ["https://jobs.example/ai"]);
});

test("search marks a complete source outage without inventing an empty result", async () => {
  const result = await searchPublishedRoles({ boards: ["one", "two"], query: "engineer" }, {
    discoverFn: async () => ({ jobs: [], error: "network down" }),
  });
  assert.equal(result.outage, true);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.sources.every((source) => source.ok === false), true);
});

test("smart support search retains related titles before ranking and excludes unrelated roles", async () => {
  const jobs = [
    { title: "IT Technician", location: "Dallas", url: "https://jobs.example/it-tech", description: "Troubleshoot Windows users" },
    { title: "End User Computing Technician", location: "Irving", url: "https://jobs.example/euc", description: "Desktop and device support" },
    { title: "Technology Support Associate", location: "Arlington", url: "https://jobs.example/associate", description: "Help employees with technical issues" },
    { title: "Staff Accountant", location: "Dallas", url: "https://jobs.example/accounting", description: "Prepare financial statements" },
    { title: "Patient Service Specialist", location: "Dallas", url: "https://jobs.example/patient-service", description: "Front desk scheduling and patient registration" },
    { title: "Machine Learning Systems Engineer", location: "Dallas", url: "https://jobs.example/ml-systems", description: "Build model platforms" },
    { title: "Partner Technology Solutions Engineer", location: "Dallas", url: "https://jobs.example/solutions", description: "Build partner integrations" },
    { title: "Senior IT Support Specialist", location: "Dallas", url: "https://jobs.example/senior-support", description: "Lead support operations" },
    { title: "IT Support Specialist", location: "Austin", url: "https://jobs.example/austin-support", description: "Troubleshoot Windows users" },
  ];
  const plan = { titles: ["IT Support Specialist", "Help Desk Technician", "Desktop Support Technician"], locations: ["Dallas", "Irving", "Arlington"], sectors: [], seniority: "entry", remote: false };
  const result = await searchPublishedRoles({ boards: ["example"], query: plan.titles.join(", "), location: plan.locations.join(", "), plan }, {
    discoverFn: async () => ({ error: null, jobs }),
    resume: { skills: ["windows"], keywords: ["troubleshoot", "desktop", "support"], roleHints: [] },
  });
  assert.deepEqual(new Set(result.jobs.map((job) => job.title)), new Set(["IT Technician", "End User Computing Technician", "Technology Support Associate", "IT Support Specialist"]));
  assert.equal(result.jobs.at(-1).location, "Austin", "outside-location matches remain visible but rank below preferred locations");
});

test("smart title recall keeps exact planned titles and common aliases", async () => {
  for (const [planned, published] of [
    ["junior developer", "Junior Developer"], ["computer technician", "PC Technician"], ["SOC analyst", "SOC Analyst"],
    ["business intelligence analyst", "BI Analyst"], ["field support technician", "Field Service Technician"], ["user support specialist", "End User Support Specialist"],
  ]) {
    const plan = { titles: [planned], locations: [], sectors: [], seniority: "entry", remote: false, locationRequired: false };
    const result = await searchPublishedRoles({ boards: ["example"], query: planned, plan }, {
      discoverFn: async () => ({ error: null, jobs: [{ title: published, location: "Dallas", url: `https://jobs.example/${encodeURIComponent(published)}`, description: "Technology support role" }] }),
    });
    assert.equal(result.jobs.length, 1, `${published} should survive title recall`);
  }
});

test("search excludes hard-ineligible roles and reports rejection reasons", async () => {
  const jobs = [
    { title: "Technical Support Specialist - DoD SkillBridge", company: "Defense Vendor", location: "Dallas", url: "https://jobs.example/skillbridge", description: "DoD SkillBridge only", postedAt: "2026-09-20T00:00:00Z" },
    { title: "IT Support Specialist", company: "Dallas Medical Center", location: "Dallas", url: "https://jobs.example/hospital", description: "Support hospital employees and clinical endpoints", postedAt: "2026-09-20T00:00:00Z" },
    { title: "IT Support Specialist", company: "Ancient Corp", location: "Dallas", url: "https://jobs.example/stale", description: "Support employees", postedAt: "2020-01-01T00:00:00Z" },
  ];
  const plan = { titles: ["IT Support Specialist", "Technical Support Specialist"], locations: ["Dallas"], sectors: ["healthcare"], requiredSectors: ["healthcare"], seniority: "entry", remote: false };
  const result = await searchPublishedRoles({ boards: ["example"], query: plan.titles.join(", "), location: "Dallas", plan }, {
    discoverFn: async () => ({ error: null, jobs }),
    profile: { mustHaves: ["hospital or healthcare"] },
    resume: { text: "IT support and Windows troubleshooting", keywords: ["support"], skills: ["windows"] },
    now: () => new Date("2026-09-22T12:00:00Z"),
  });
  assert.deepEqual(result.jobs.map((job) => job.url), ["https://jobs.example/hospital"]);
  assert.equal(result.rejectedCount, 2);
  assert.equal(result.funnel.hardRejected, 2);
  assert.ok(result.rejectionReasons.some((reason) => reason.code === "skillbridge-only" && reason.count === 1));
  assert.ok(result.rejectionReasons.some((reason) => reason.code === "stale-posting" && reason.count === 1));
});

test("search hides unsupported experience gates but retains explicitly negated gates", async () => {
  const jobs = [
    { title: "IT Support Specialist", company: "Years Corp", location: "Dallas", url: "https://jobs.lever.co/years/1", postedAt: "2026-09-21T00:00:00Z", description: "Minimum Qualifications\n3+ years in IT support" },
    { title: "IT Support Specialist", company: "Open Corp", location: "Dallas", url: "https://jobs.lever.co/open/2", postedAt: "2026-09-21T00:00:00Z", description: "Support Windows users. A+ certification is not required. No bachelor's degree is required." },
  ];
  const result = await searchPublishedRoles({ boards: ["example"], query: "IT Support Specialist", location: "Dallas" }, {
    discoverFn: async () => ({ error: null, jobs }),
    resume: { text: "IT Support Associate\n2025 - Present\nSupported Windows users", skills: ["windows"], keywords: ["it", "support", "users"] },
    now: () => new Date("2026-09-22T00:00:00Z"),
  });
  assert.deepEqual(result.jobs.map((job) => job.company), ["Open Corp"]);
  assert.equal(result.allJobs.find((job) => job.company === "Years Corp")?.match.decision.code, "skip");
  assert.equal(result.allJobs.find((job) => job.company === "Open Corp")?.match.qualifications.counts.missing, 0);
  assert.equal(result.funnel.fitSkipped, 1);
});

test("search keeps clause polarity and does not hide company tenure or optional credentials", async () => {
  const jobs = [
    { title: "IT Support Specialist", company: "Mixed Corp", location: "Dallas", url: "https://jobs.lever.co/mixed/1", postedAt: "2026-09-21T00:00:00Z", description: "No bachelor's degree is required, but 3+ years in IT support is required." },
    { title: "IT Support Specialist", company: "History Corp", location: "Dallas", url: "https://jobs.lever.co/history/2", postedAt: "2026-09-21T00:00:00Z", description: "Our company brings 25 years in IT support to customers." },
    { title: "IT Support Specialist", company: "Optional Corp", location: "Dallas", url: "https://jobs.lever.co/optional/3", postedAt: "2026-09-21T00:00:00Z", description: "Support Windows users. A+ certification is optional." },
  ];
  const result = await searchPublishedRoles({ boards: ["example"], query: "IT Support Specialist", location: "Dallas" }, {
    discoverFn: async () => ({ error: null, jobs }),
    resume: { text: "IT Support Associate\n2025 - Present\nSupported Windows users", skills: ["windows"], keywords: ["it", "support", "users"] },
    now: () => new Date("2026-09-22T00:00:00Z"),
  });
  assert.deepEqual(new Set(result.jobs.map((job) => job.company)), new Set(["History Corp", "Optional Corp"]));
  assert.equal(result.allJobs.find((job) => job.company === "Mixed Corp")?.match.decision.code, "skip");
  assert.equal(result.allJobs.find((job) => job.company === "History Corp")?.match.eligibility.warnings.length, 0);
  assert.equal(result.funnel.fitSkipped, 1);
});

test("search handles contrast clauses, qualification headings, and natural optionality", async () => {
  const jobs = [
    { title: "IT Support Specialist", company: "Although Corp", location: "Dallas", url: "https://jobs.lever.co/although/1", postedAt: "2026-09-21T00:00:00Z", description: "Although a bachelor's degree is not required, 3+ years in IT support is required." },
    { title: "IT Support Specialist", company: "While Corp", location: "Dallas", url: "https://jobs.lever.co/while/2", postedAt: "2026-09-21T00:00:00Z", description: "A+ is optional, while Network+ is required." },
    { title: "IT Support Specialist", company: "Candidate Corp", location: "Dallas", url: "https://jobs.lever.co/candidate/3", postedAt: "2026-09-21T00:00:00Z", description: "The company requires candidates to have 5 years in IT support." },
    { title: "IT Support Specialist", company: "Heading Corp", location: "Dallas", url: "https://jobs.lever.co/heading/4", postedAt: "2026-09-21T00:00:00Z", description: "Qualifications:\n3+ years in IT support" },
    { title: "IT Support Specialist", company: "Acme History", location: "Dallas", url: "https://jobs.lever.co/history/5", postedAt: "2026-09-21T00:00:00Z", description: "Acme has 25 years of IT support experience." },
    { title: "IT Support Specialist", company: "No Need Corp", location: "Dallas", url: "https://jobs.lever.co/no-need/6", postedAt: "2026-09-21T00:00:00Z", description: "Support Windows users. You do not need A+ certification." },
    { title: "IT Support Specialist", company: "Not Needed Corp", location: "Dallas", url: "https://jobs.lever.co/not-needed/7", postedAt: "2026-09-21T00:00:00Z", description: "Support Windows users. A+ certification is not needed." },
  ];
  const result = await searchPublishedRoles({ boards: ["example"], query: "IT Support Specialist", location: "Dallas" }, {
    discoverFn: async () => ({ error: null, jobs }),
    resume: { text: "IT Support Associate\n2025 - Present\nSupported Windows users", skills: ["windows"], keywords: ["it", "support", "users"] },
    now: () => new Date("2026-09-22T00:00:00Z"),
  });
  assert.deepEqual(new Set(result.jobs.map((job) => job.company)), new Set(["Acme History", "No Need Corp", "Not Needed Corp"]));
  assert.equal(result.funnel.fitSkipped, 4);
  assert.ok(result.allJobs.filter((job) => job.match.decision.code === "skip").every((job) => job.match.qualifications.counts.missing > 0));
});
