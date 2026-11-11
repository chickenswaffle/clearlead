import test from "node:test";
import assert from "node:assert/strict";
import { createSearchPlan, deterministicSearchPlan } from "../src/search-plan.mjs";
import { searchPublishedRoles } from "../src/search.mjs";
import { evaluateJobEligibility } from "../src/eligibility.mjs";
import { analyzeResume } from "../src/resume.mjs";

// A saved profile like the one that made every airport job disappear: IT targets plus
// healthcare/education must-haves.
const ITPROFILE = {
  targetRoles: ["IT Support Specialist", "Help Desk Technician", "Desktop Support Technician"],
  locations: ["Dallas", "Irving", "Arlington"],
  mustHaves: ["hospital or healthcare", "school or school district", "close to Dallas"],
};
const RESUME = {
  text: "Manager, Network Operations. Customer Care Lead. Salesforce, Cisco, VoIP, customer service, SLA.",
  skills: ["salesforce", "linux"],
  keywords: ["network", "customer", "operations", "sla"],
  roleHints: ["Manager, Network Operations", "Customer Care Lead"],
};
const NOW = () => new Date("2026-11-01T12:00:00Z");

test("an airport request searches airport employers with every title open and ignores saved sector gates", () => {
  const plan = deterministicSearchPlan("any airport job", { resume: RESUME, profile: ITPROFILE });
  assert.equal(plan.titleMode, "open");
  assert.deepEqual(plan.titles, [], "saved IT targets must not narrow an open request");
  assert.equal(plan.ignoreProfileSectors, true);
  assert.deepEqual(plan.requiredSectors, []);
  assert.deepEqual(plan.sectors, ["aviation"]);
  assert.equal(plan.filters.state, "TX", "a DFW profile scopes an unlocated airport request to DFW");
  assert.ok(plan.locations.includes("DFW"));
  assert.deepEqual(plan.employerSites.map((site) => site.name), ["DFW International Airport", "Dallas Love Field (City of Dallas Aviation)", "Southwest Airlines", "Envoy Air"]);
  assert.ok(plan.manualEmployers.some((item) => item.name === "American Airlines" && /^https:\/\//.test(item.url)));
  assert.match(plan.explanation, /every opening at airport and airline employers · 4 employer career sites/);
});

test("a role at the airport keeps title filtering but still targets airport employers", () => {
  const plan = deterministicSearchPlan("IT support jobs at the airport", { resume: RESUME, profile: ITPROFILE });
  assert.equal(plan.titleMode, "role");
  assert.ok(plan.titles.includes("help desk technician"));
  assert.equal(plan.employerSites.length, 4);
  assert.equal(plan.ignoreProfileSectors, true);
});

test("airport employers are not added for another region", () => {
  const plan = deterministicSearchPlan("airport jobs in Houston", { resume: RESUME, profile: ITPROFILE });
  assert.equal(plan.titleMode, "open");
  assert.deepEqual(plan.employerSites, [], "the curated sites are DFW-only; the AI planner can suggest Houston employers");
});

test("searches without an employer topic are unchanged", () => {
  const plan = deterministicSearchPlan("entry level IT support jobs in DFW hospitals and schools", { resume: RESUME, profile: ITPROFILE });
  assert.equal(plan.titleMode, "role");
  assert.deepEqual(plan.employerSites, []);
  assert.equal(plan.ignoreProfileSectors, false);
  assert.deepEqual(plan.requiredSectors.sort(), ["education", "healthcare"]);
});

test("AI plan can name employers; only https suggestions not already known survive", async () => {
  let request;
  const plan = await createSearchPlan("any airport job", {
    resume: RESUME,
    profile: ITPROFILE,
    generateText: async (payload) => {
      request = payload;
      return JSON.stringify({
        titles: ["Airport Customer Experience Specialist", "Network Operations Center Specialist", "Operations Supervisor"],
        keywords: ["customer service"], sectors: ["aviation"], title_mode: "open",
        employers: [
          { name: "Unifi Aviation", careers_url: "https://careers.unifiservice.com" },
          { name: "Southwest Airlines", careers_url: "https://careers.southwestair.com" },
          { name: "Sketchy", careers_url: "http://insecure.example.com" },
          { name: "", careers_url: "https://noname.example.com" },
        ],
      });
    },
  });
  const input = JSON.parse(request.input);
  assert.ok(input.known_employers.includes("Southwest Airlines"));
  assert.equal("text" in input.resume_index, false, "the planner never receives the full resume");
  assert.equal(plan.mode, "ai");
  assert.equal(plan.titleMode, "open");
  assert.deepEqual(plan.titles, ["Airport Customer Experience Specialist", "Network Operations Center Specialist", "Operations Supervisor"], "open mode does not pad AI titles with saved IT targets");
  assert.deepEqual(plan.suggestedEmployers, [{ name: "Unifi Aviation", careersUrl: "https://careers.unifiservice.com" }]);
  assert.equal(plan.employerSites.length, 4, "curated sites are kept alongside AI suggestions");
});

function source(type, jobs, extra = {}) {
  return async (spec) => spec.type === type ? { source: type, board: spec.token, error: null, jobs, ...extra } : { source: spec.type, board: spec.token, error: null, jobs: [] };
}

test("open employer search keeps every in-area title, drops out-of-area ones, and does not apply saved sector gates", async () => {
  const plan = deterministicSearchPlan("any airport job", { resume: RESUME, profile: ITPROFILE });
  const jobs = [
    { title: "Airport Customer Experience Specialist", company: "DFW International Airport", location: "DFW Airport, Texas, United States of America", url: "https://careers.dfwairport.com/us/en/job/JR1", applyUrl: "https://dfwairport.wd5.myworkdayjobs.com/External/job/JR1/apply", postedAt: "2026-10-19T00:00:00Z", description: "Serve airport customers. Two years of customer service required." },
    { title: "Heavy Equipment Mechanic", company: "DFW International Airport", location: "DFW Airport, Texas, United States of America", url: "https://careers.dfwairport.com/us/en/job/JR2", postedAt: "2026-10-28T00:00:00Z", description: "Repair airfield equipment." },
    { title: "Ramp Agent - GEG", company: "Southwest Airlines", location: "Spokane, Washington, United States of America", url: "https://careers.southwestair.com/us/en/job/R9", postedAt: "2026-10-01T00:00:00Z", description: "Load bags at the airport." },
  ];
  const result = await searchPublishedRoles({ ...plan.searchConfig, broadFeeds: [], plan }, { discoverSourceFn: source("phenom", jobs), resume: RESUME, profile: ITPROFILE, now: NOW });
  const titles = result.jobs.map((job) => job.title).sort();
  assert.deepEqual(titles, ["Airport Customer Experience Specialist", "Heavy Equipment Mechanic"]);
  assert.equal(result.funnel.locationMismatch >= 1, true, "employer sites hire nationwide, so their out-of-area jobs are filtered");
  assert.equal(result.rejectionReasons.some((item) => item.code === "required-sector-mismatch"), false);
  const sources = result.sources.filter((item) => item.employer);
  assert.equal(sources.length, 4);
  assert.equal(sources[0].queryMode, "employer-site-full");
  assert.ok(result.manualEmployers.some((item) => item.name === "American Airlines"));
  const customer = result.jobs.find((job) => job.title.startsWith("Airport Customer"));
  assert.equal(customer.match.application.kind, "direct", "the Workday apply link counts as a direct employer application");
});

test("open search still requires broad-feed jobs to belong to the requested topic", async () => {
  const plan = deterministicSearchPlan("any airport job", { resume: RESUME, profile: ITPROFILE });
  const remote = [
    { title: "Customer Success Manager", company: "SaaS Co", location: "Remote", url: "https://remotive.com/jobs/1", postedAt: "2026-10-30T00:00:00Z", description: "Help software customers." },
    { title: "Operations Coordinator", company: "Regional Airline", location: "Dallas, TX", url: "https://remotive.com/jobs/2", postedAt: "2026-10-30T00:00:00Z", description: "Coordinate airline crew schedules." },
  ];
  const result = await searchPublishedRoles({ ...plan.searchConfig, broadFeeds: ["remotive"], plan: { ...plan, employerSites: [] } }, { discoverSourceFn: source("remotive", remote), resume: RESUME, profile: ITPROFILE, now: NOW });
  assert.deepEqual(result.jobs.map((job) => job.title), ["Operations Coordinator"]);
});

test("saved sector gates still apply unless the request names its own industry", () => {
  const job = { title: "Airport Security Officer", company: "DFW International Airport", location: "DFW Airport, TX", description: "Patrol terminals.", postedAt: "2026-10-30T00:00:00Z" };
  const gated = evaluateJobEligibility(job, { profile: ITPROFILE, plan: {}, now: NOW() });
  assert.equal(gated.eligible, false);
  assert.equal(gated.reasons[0].code, "required-sector-mismatch");
  const open = evaluateJobEligibility(job, { profile: ITPROFILE, plan: { ignoreProfileSectors: true }, now: NOW() });
  assert.equal(open.eligible, true);
});

test("old postings still on the employer's own site are flagged, not dropped; passed deadlines are dropped", () => {
  const base = { title: "911 Dispatcher", company: "DFW International Airport", location: "DFW Airport, TX", description: "Dispatch.", postedAt: "2026-06-11T00:00:00Z" };
  const listed = evaluateJobEligibility({ ...base, source: "phenom" }, { now: NOW() });
  assert.equal(listed.eligible, true);
  assert.equal(listed.warnings[0].code, "long-running-posting");
  const aggregated = evaluateJobEligibility({ ...base, source: "remotive" }, { now: NOW() });
  assert.equal(aggregated.reasons[0].code, "stale-posting", "aggregator copies of old postings are still treated as stale");
  const closed = evaluateJobEligibility({ ...base, source: "workday", postedAt: "2026-10-01T00:00:00Z", closesAt: "2026-10-20T00:00:00Z" }, { now: NOW() });
  assert.equal(closed.reasons[0].code, "application-closed");
  const closingToday = evaluateJobEligibility({ ...base, source: "workday", postedAt: "2026-10-19T00:00:00Z", closesAt: "2026-11-02T00:00:00Z" }, { now: NOW() });
  assert.equal(closingToday.eligible, true);
});

test("work-history titles become role hints for non-engineering resumes", () => {
  const analysis = analyzeResume(`Summary
Operations professional with 9 years experience.
Experience
Manager, Field Operations
Northwind Logistics • Plano, TX
04/2021 - Present
• Lead field deployment and 24/7 support.
Customer Support Lead
Contoso Water Co. • Denton, TX
05/2018 - 04/2021
Managed a team of 5 support reps.
Warehouse Associate
Fabrikam Distribution • Frisco, TX
June 2015 – May 2018
Skills
Logistics, Team Leadership`);
  assert.deepEqual(analysis.roleHints, ["Manager, Field Operations", "Customer Support Lead", "Warehouse Associate"]);
});
