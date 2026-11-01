import test from "node:test";
import assert from "node:assert/strict";
import { detectCareerSite, discoverEmployerSite, extractPay, icimsLocation, normalizeEmployerSite, workdayRelativeDate } from "../src/employer-sites.mjs";

function json(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, url: "", json: async () => value, text: async () => JSON.stringify(value) };
}
function html(value, url = "", status = 200) {
  return { ok: status >= 200 && status < 300, status, url, text: async () => value, json: async () => JSON.parse(value) };
}

test("Phenom sites are read through the refineSearch widget and enriched from job pages", async () => {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith("/widgets")) {
      return json({ refineSearch: { totalHits: 2, data: { jobs: [
        { jobId: "JR2", title: "Ramp Agent", location: "Spokane, Washington, United States of America", postedDate: "2026-10-01T00:00:00.000+0000", descriptionTeaser: "Load bags." },
        { jobId: "JR1", title: "Airport Customer Experience Specialist", location: "DFW Airport, Texas, United States of America", applyUrl: "https://dfwairport.wd5.myworkdayjobs.com/External/job/JR1/apply", postedDate: "2026-10-19T00:00:00.000+0000", descriptionTeaser: "Help travelers.", category: "Service/Field", type: "Full time" },
      ] } } });
    }
    if (String(url).includes("/job/JR1")) return html(`<script>phApp.ddo = {"jobDetail":{"data":{"job":{"description":"<p>Two (2) years of customer service.</p><p>Pay: $21.50 per hour</p>"}}}}; phApp.other = {};</script>`);
    return html("<html></html>");
  };
  const result = await discoverEmployerSite({ type: "phenom", host: "careers.dfwairport.com", refNum: "DFWDIAUS", name: "DFW International Airport" }, { fetchFn, plan: { locations: ["DFW"] }, enrichLimit: 1 });
  assert.equal(result.error, null);
  assert.equal(result.jobs.length, 2);
  assert.equal(calls[0].body.refNum, "DFWDIAUS");
  assert.equal(calls[0].body.ddoKey, "refineSearch");
  const dfw = result.jobs.find((job) => job.title === "Airport Customer Experience Specialist");
  assert.equal(dfw.company, "DFW International Airport");
  assert.equal(dfw.url, "https://careers.dfwairport.com/us/en/job/JR1");
  assert.equal(dfw.applyUrl, "https://dfwairport.wd5.myworkdayjobs.com/External/job/JR1/apply");
  assert.equal(dfw.postedAt, "2026-10-19T00:00:00.000Z");
  assert.match(dfw.description, /Two \(2\) years of customer service\.\nPay: \$21\.50 per hour/);
  assert.equal(dfw.salary, "$21.50 / hour");
  assert.equal(result.jobs.find((job) => job.title === "Ramp Agent").description, "Load bags.", "the enrichment budget goes to jobs in the requested area first");
  assert.ok(!calls.some((call) => call.url.includes("/job/JR2")));
});

test("Phenom identifier is discovered from the search page when not configured", async () => {
  const fetchFn = async (url) => String(url).endsWith("/search-results")
    ? html('<script>var phApp = {"refNum":"SOUTUS"};</script>')
    : json({ refineSearch: { totalHits: 0, data: { jobs: [] } } });
  const result = await discoverEmployerSite({ type: "phenom", host: "careers.southwestair.com", name: "Southwest Airlines" }, { fetchFn });
  assert.equal(result.error, null);
  assert.deepEqual(result.jobs, []);
});

test("Workday sites resolve facility facets, paginate, and take dates and descriptions from detail", async () => {
  const bodies = [];
  const fetchFn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body) bodies.push(body);
    if (String(url).endsWith("/jobs") && body.limit === 1) {
      return json({ total: 105, jobPostings: [], facets: [{ facetParameter: "locationMainGroup", values: [{ facetParameter: "locations", values: [{ id: "loc-love", descriptor: "AVICDRSPGS", count: 2 }, { id: "loc-other", descriptor: "CTYFAIRPK", count: 3 }] }] }] });
    }
    if (String(url).endsWith("/jobs")) {
      return json({ total: body.offset === 0 ? 2 : 0, jobPostings: [
        { title: "Airport Operations Officer", externalPath: "/job/AVICDRSPGS/Airport-Operations-Officer_24-1", locationsText: "AVICDRSPGS", postedOn: "Posted 13 Days Ago" },
        { title: "Administrative Specialist II", externalPath: "/job/AVICDRSPGS/Admin_24-2", locationsText: "AVICDRSPGS", postedOn: "Posted 30+ Days Ago" },
      ] });
    }
    if (String(url).includes("Airport-Operations-Officer")) return json({ jobPostingInfo: { jobDescription: "<p>Monitor the airfield.</p>", startDate: "2026-10-19", endDate: "2026-11-02", timeType: "Full time", location: "AVICDRSPGS" } });
    return json({}, 404);
  };
  const result = await discoverEmployerSite({
    type: "workday", host: "dallascityhall.wd5.myworkdayjobs.com", tenant: "dallascityhall", site: "CODCareers",
    locationFacets: ["AVICDRSPGS"], defaultLocation: "Dallas Love Field, Dallas, TX", name: "Dallas Love Field",
  }, { fetchFn, now: () => new Date("2026-11-01T12:00:00Z") });
  assert.equal(result.error, null);
  assert.deepEqual(bodies[1].appliedFacets, { locations: ["loc-love"] }, "only the Love Field facility is searched, not all 105 city jobs");
  assert.equal(result.jobs.length, 2);
  const officer = result.jobs.find((job) => job.title === "Airport Operations Officer");
  assert.equal(officer.url, "https://dallascityhall.wd5.myworkdayjobs.com/CODCareers/job/AVICDRSPGS/Airport-Operations-Officer_24-1");
  assert.equal(officer.location, "Dallas Love Field, Dallas, TX", "internal facility codes are replaced by the configured place");
  assert.equal(officer.postedAt, "2026-10-19T00:00:00.000Z");
  assert.equal(officer.closesAt, "2026-11-02T00:00:00.000Z");
  assert.equal(officer.description, "Monitor the airfield.");
  assert.equal("externalPath" in officer, false);
});

test("Workday reports a vanished facility filter instead of silently searching everything", async () => {
  const fetchFn = async () => json({ total: 5, jobPostings: [], facets: [{ facetParameter: "locations", values: [{ id: "x", descriptor: "ELSEWHERE" }] }] });
  const result = await discoverEmployerSite({ type: "workday", host: "acme.wd1.myworkdayjobs.com", tenant: "acme", site: "Careers", locationFacets: ["GONE"], name: "Acme" }, { fetchFn });
  assert.deepEqual(result.jobs, []);
  assert.match(result.error, /no longer lists the location filter "GONE"/);
});

test("iCIMS cards are parsed across pages and enriched from JobPosting JSON-LD", async () => {
  const card = (id, title, location) => `<li class="iCIMS_JobCardItem"><div class="header left"><span class="sr-only field-label">Job Locations</span> <span > ${location}</span></div>
    <a href="https://us-envoyair.icims.com/jobs/${id}/slug/job?in_iframe=1" class="iCIMS_Anchor"><span class="sr-only field-label">Title</span> <h3 > ${title}</h3></a>
    <dl><div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField">Category</dt> <dd class="iCIMS_JobHeaderData"><span > Airport Operations</span> </dd></div>
    <div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField">Position Type (Portal Searching)</dt> <dd class="iCIMS_JobHeaderData"><span > Regular Full-Time</span> </dd></div></dl></li>`;
  const pages = [card(11710, "Ramp Airport Agent", "US-TX-Dallas - Fort Worth (DFW) Airport") + card(13116, "Airport Agent", "US-TX-Corpus Christi"), card(11710, "Ramp Airport Agent", "US-TX-Dallas - Fort Worth (DFW) Airport")];
  const searched = [];
  const fetchFn = async (url) => {
    const target = String(url);
    if (target.includes("/jobs/search")) { searched.push(target); return html(pages[Number(new URL(target).searchParams.get("pr"))] || ""); }
    if (target.includes("/jobs/11710/")) return html(`<script type="application/ld+json">{"@type":"JobPosting","title":"Ramp Airport Agent","datePosted":"2026-09-30T04:00:00.000Z","validThrough":"2027-09-30T04:00:00.000Z","description":"&lt;p&gt;No experience required.&lt;/p&gt;&lt;p&gt;Pay rate: $17.86 / hr&lt;/p&gt;"}</script>`);
    return html("");
  };
  const result = await discoverEmployerSite({ type: "icims", host: "us-envoyair.icims.com", searchLocation: "12781-12827-", name: "Envoy Air" }, { fetchFn, plan: { locations: ["Dallas"] }, enrichLimit: 1 });
  assert.equal(result.error, null);
  assert.equal(searched.length, 2, "paging stops once a page adds nothing new");
  assert.match(searched[0], /searchLocation=12781-12827-/);
  assert.equal(result.jobs.length, 2);
  const ramp = result.jobs.find((job) => job.title === "Ramp Airport Agent");
  assert.equal(ramp.location, "Dallas - Fort Worth (DFW) Airport, TX, US");
  assert.equal(ramp.url, "https://us-envoyair.icims.com/jobs/11710/slug/job");
  assert.equal(ramp.category, "Airport Operations");
  assert.equal(ramp.employmentType, "Regular Full-Time");
  assert.equal(ramp.postedAt, "2026-09-30T04:00:00.000Z");
  assert.equal(ramp.salary, "$17.86 / hour");
  assert.equal(ramp.description, "No experience required.\nPay rate: $17.86 / hr", "entity-encoded markup is stripped, not shown as tags");
});

test("blocked career sites fail with an actionable message", async () => {
  const result = await discoverEmployerSite({ type: "phenom", host: "jobs.example.com", refNum: "EXUS", name: "Example" }, { fetchFn: async () => json({}, 403) });
  assert.deepEqual(result.jobs, []);
  assert.match(result.error, /^Example: the careers site refused automated access \(HTTP 403\)\. Open it in your browser instead\.$/);
});

test("careers URLs are recognized from the URL, a redirect, embedded Phenom data, or a linked platform", async () => {
  const workday = await detectCareerSite("https://dallascityhall.wd5.myworkdayjobs.com/en-US/CODCareers", { fetchFn: async () => { throw new Error("no fetch needed"); } });
  assert.deepEqual([workday.site.type, workday.site.tenant, workday.site.site], ["workday", "dallascityhall", "CODCareers"]);
  const icims = await detectCareerSite("https://us-envoyair.icims.com/jobs/search", { fetchFn: async () => { throw new Error("no fetch needed"); } });
  assert.equal(icims.site.type, "icims");
  const greenhouse = await detectCareerSite("https://boards.greenhouse.io/acme", { name: "Acme" });
  assert.deepEqual(greenhouse.site, { type: "greenhouse", token: "acme", name: "Acme" });
  const phenom = await detectCareerSite("https://www.dfwairport.com/careers/", { name: "DFW", fetchFn: async () => html('<script>phApp.ddo = {"refNum":"DFWDIAUS"};</script>', "https://careers.dfwairport.com/us/en") });
  assert.deepEqual([phenom.site.type, phenom.site.host, phenom.site.refNum], ["phenom", "careers.dfwairport.com", "DFWDIAUS"]);
  const linked = await detectCareerSite("https://www.example-hospital.org/careers", { name: "Example Hospital", fetchFn: async () => html('<a href="https://examplehealth.wd1.myworkdayjobs.com/External">Search jobs</a>') });
  assert.deepEqual([linked.site.type, linked.site.tenant, linked.site.site], ["workday", "examplehealth", "External"]);
  const unknown = await detectCareerSite("https://jobs.aa.com/search-jobs", { name: "American Airlines", fetchFn: async () => html("<html>no platform</html>") });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /American Airlines's careers site uses a platform ClearLead cannot search yet/);
});

test("private and malformed hosts are never fetched", async () => {
  let fetched = false;
  const fetchFn = async () => { fetched = true; return html(""); };
  for (const url of ["http://localhost:4173/careers", "https://127.0.0.1/jobs", "https://intranet/jobs", "ftp://example.com/jobs"]) {
    const result = await detectCareerSite(url, { fetchFn });
    assert.equal(result.ok, false, url);
  }
  assert.equal(fetched, false);
  assert.equal(normalizeEmployerSite({ type: "workday", host: "evil.example.com", tenant: "a", site: "b" }), null, "Workday adapters only talk to myworkdayjobs.com");
  assert.equal(normalizeEmployerSite({ type: "icims", host: "evil.example.com" }), null);
});

test("date, location, and pay helpers", () => {
  const now = new Date("2026-11-01T00:00:00.000Z");
  assert.equal(workdayRelativeDate("Posted Today", now), "2026-11-01T00:00:00.000Z");
  assert.equal(workdayRelativeDate("Posted Yesterday", now), "2026-10-31T00:00:00.000Z");
  assert.equal(workdayRelativeDate("Posted 13 Days Ago", now), "2026-10-19T00:00:00.000Z");
  assert.equal(workdayRelativeDate("Posted 30+ Days Ago", now), null, "an open-ended age is unknown, not 30 days");
  assert.equal(icimsLocation("US-TX-Irving | US-OH-Columbus"), "Irving, TX, US | Columbus, OH, US");
  assert.equal(extractPay("Hiring range $48,463 - $59,786 per year"), "$48,463–$59,786 / year");
  assert.equal(extractPay("$15.77/hr with $1 shift differential"), "$15.77 / hour");
  assert.equal(extractPay("Our airport has served 70 million travelers"), "");
});
