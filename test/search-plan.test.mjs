import test from "node:test";
import assert from "node:assert/strict";
import { createSearchPlan, deterministicSearchPlan } from "../src/search-plan.mjs";

test("plain-English DFW search corrects a typo and expands support roles and nearby cities", () => {
  const plan = deterministicSearchPlan("texh job entry level in DFW near Dallas, hospitals and schools", {
    resume: { skills: ["windows", "active directory", "technical support"], keywords: ["troubleshooting"], roleHints: ["IT Manager"] },
  });
  assert.equal(plan.seniority, "entry");
  assert.equal(plan.filters.state, "TX");
  assert.equal(plan.locationRequired, false);
  assert.ok(plan.titles.includes("help desk technician"));
  assert.ok(plan.titles.includes("technical support specialist"));
  assert.ok(plan.locations.includes("Dallas"));
  assert.ok(plan.locations.includes("Plano"));
  assert.ok(plan.locations.includes("McKinney"));
  assert.deepEqual(plan.sectors, ["healthcare", "education"]);
  assert.ok(plan.ledgerQueries.length >= 3);
});

test("location language distinguishes a preference from a hard boundary", () => {
  assert.equal(deterministicSearchPlan("support jobs near Dallas").locationRequired, false);
  assert.equal(deterministicSearchPlan("support jobs only within 20 miles of Dallas").locationRequired, true);
});

test("AI planning sends only the compact index and fails closed to the local plan", async () => {
  let sent = "";
  const plan = await createSearchPlan("entry level tech jobs in DFW", {
    resume: { skills: ["Windows"], keywords: ["troubleshooting"], roleHints: ["Support Lead"], text: "PRIVATE FULL RESUME" },
    generateText: async (request) => { sent = request.input; return "not json"; },
  });
  assert.doesNotMatch(sent, /PRIVATE FULL RESUME/);
  assert.equal(plan.mode, "local");
  assert.match(plan.note, /built-in search expansion/i);
});

test("valid AI expansion cannot change fixed DFW geography", async () => {
  const plan = await createSearchPlan("entry level tech jobs in DFW", {
    resume: { skills: ["Windows"], keywords: [], roleHints: [] },
    generateText: async () => JSON.stringify({ titles: ["Help Desk Technician", "IT Support Specialist"], keywords: ["troubleshooting"], sectors: ["education"] , locations: ["New York"] }),
  });
  assert.equal(plan.mode, "ai");
  assert.ok(plan.locations.includes("Dallas"));
  assert.equal(plan.locations.includes("New York"), false);
});

test("saved must-haves become a required any-of sector gate", () => {
  const plan = deterministicSearchPlan("entry level IT support in DFW", {
    profile: { preferences: [], mustHaves: ["hospital or healthcare", "school or school district"] },
  });
  assert.deepEqual(plan.requiredSectors, ["healthcare", "education"]);
  assert.match(plan.explanation, /healthcare or education required/);
});

test("saved preferences boost sectors without becoming hard gates", () => {
  const plan = deterministicSearchPlan("entry level IT support in DFW", {
    profile: { preferences: ["hospital or healthcare", "school or school district"], mustHaves: [] },
  });
  assert.deepEqual(plan.sectors, ["healthcare", "education"]);
  assert.deepEqual(plan.requiredSectors, []);
  assert.doesNotMatch(plan.explanation, /required/);
});
