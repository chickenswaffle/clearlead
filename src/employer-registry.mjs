// Curated employer targets for searches that name an industry or place rather
// than a role ("airport jobs"). Each site was verified against the employer's
// live careers platform; the AI planner can add more, which ClearLead then
// verifies with detectCareerSite before searching.
//
// `manual` entries are real employers whose sites block automated search.
// ClearLead lists them as an explicit "open this site" action instead of
// silently leaving them out.

export const EMPLOYER_TOPICS = [
  {
    id: "airport",
    label: "airport and airline employers",
    match: /\b(?:airports?|airlines?|aviation|airfield|ramp agents?|gate agents?|flight attendants?|baggage|love field|dfw airport|tsa)\b/i,
    sector: "aviation",
    terms: ["airport", "airline", "aviation", "airfield", "ramp", "terminal"],
    regions: {
      dfw: {
        sites: [
          { type: "phenom", host: "careers.dfwairport.com", refNum: "DFWDIAUS", name: "DFW International Airport", careersUrl: "https://careers.dfwairport.com/us/en/search-results" },
          { type: "workday", host: "dallascityhall.wd5.myworkdayjobs.com", tenant: "dallascityhall", site: "CODCareers", locationFacets: ["AVICDRSPGS"], defaultLocation: "Dallas Love Field, Dallas, TX", name: "Dallas Love Field (City of Dallas Aviation)", careersUrl: "https://dallascityhall.wd5.myworkdayjobs.com/CODCareers" },
          { type: "phenom", host: "careers.southwestair.com", refNum: "SOUTUS", name: "Southwest Airlines", careersUrl: "https://careers.southwestair.com/us/en/search-results" },
          { type: "icims", host: "us-envoyair.icims.com", searchLocation: "12781-12827-", name: "Envoy Air", careersUrl: "https://us-envoyair.icims.com/jobs/search" },
        ],
        manual: [
          { name: "American Airlines", url: "https://jobs.aa.com/search-jobs/DFW", reason: "Blocks automated search; open it in your browser." },
          { name: "TSA (USAJobs)", url: "https://www.usajobs.gov/search/results/?k=transportation%20security%20officer&l=Dallas%2C%20Texas", reason: "TSA posts officer openings airport by airport on USAJobs." },
          { name: "HMSHost (airport restaurants)", url: "https://careers.hmshost.com/jobs/where/DFW", reason: "Custom job site ClearLead cannot read yet." },
        ],
      },
    },
  },
];

export function matchEmployerTopic(intent) {
  return EMPLOYER_TOPICS.find((topic) => topic.match.test(String(intent || ""))) || null;
}

export function topicEmployers(topic, region) {
  const entry = topic?.regions?.[region];
  return entry ? { sites: entry.sites.map((site) => ({ ...site })), manual: entry.manual.map((item) => ({ ...item })) } : { sites: [], manual: [] };
}
