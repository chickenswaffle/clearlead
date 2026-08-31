import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchConfig, searchPublishedRoles } from "../src/search.mjs";

test("search config validates, deduplicates, and caps company boards", () => {
  const config = normalizeSearchConfig({
    boards: ["Figma", "figma", "bad board", ...Array.from({ length: 20 }, (_, index) => `board-${index}`)],
    query: "  platform engineer  ",
    refreshMinutes: 2,
  });
  assert.equal(config.boards[0], "figma");
  assert.equal(config.boards.includes("bad board"), false);
  assert.equal(config.boards.length, 20);
  assert.deepEqual(config.greenhouseBoards, config.boards);
  assert.equal(config.query, "platform engineer");
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
  assert.equal(result.jobs[0].relevance.score, 60);
  assert.equal(result.jobs[0].match.breakdown.title, 100);
  assert.equal(result.jobs[0].verificationStatus, "unverified");
  assert.equal(result.sources.find((source) => source.board === "broken").ok, false);
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
  ];
  const plan = { titles: ["IT Support Specialist", "Help Desk Technician", "Desktop Support Technician"], locations: ["Dallas", "Irving", "Arlington"], sectors: [], seniority: "entry", remote: false };
  const result = await searchPublishedRoles({ boards: ["example"], query: plan.titles.join(", "), location: plan.locations.join(", "), plan }, {
    discoverFn: async () => ({ error: null, jobs }),
    resume: { skills: ["windows"], keywords: ["troubleshoot", "desktop", "support"], roleHints: [] },
  });
  assert.deepEqual(new Set(result.jobs.map((job) => job.title)), new Set(["IT Technician", "End User Computing Technician", "Technology Support Associate"]));
});
