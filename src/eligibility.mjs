const DEFAULT_MAX_AGE_DAYS = 60;

const SECTORS = {
  healthcare: ["hospital", "healthcare", "health care", "medical center", "medical clinic", "health clinic", "pharmacy", "patient care"],
  education: ["school district", "independent school", "public schools", "private school", "school system", "k-12", "university", "college", "higher education", "campus technology", "campus it"],
  "public sector": ["government", "city of", "county", "public sector", "municipal"],
};

const PROFILE_SECTOR_PATTERNS = {
  healthcare: /\b(?:hospitals?|healthcare|health care|clinics?|medical|pharmacy|patient care)\b/i,
  education: /\b(?:schools?|school districts?|education|colleges?|universit(?:y|ies)|campus(?:es)?|k-12)\b/i,
  "public sector": /\b(?:government|city|county|public sector|municipal)\b/i,
};

const SPECIAL_PROGRAMS = [
  {
    code: "skillbridge-only",
    jobPattern: /\b(?:dod\s+)?skill\s*bridge\b/i,
    evidencePattern: /\b(?:dod\s+)?skill\s*bridge\b|\bactive[- ]duty\b|\btransitioning service member\b/i,
    reason: "This role is restricted to DoD SkillBridge or transitioning service members, but the candidate profile contains no matching eligibility evidence.",
  },
];

const SENIOR_TITLE = /\b(?:senior|sr\.?|staff|principal|lead|manager|director|head|chief|vp|vice president)\b/i;
const ACTIVE_CLEARANCE_REQUIRED = /\b(?:(?:active|current)\s+(?:(?:top\s+secret|secret|ts\s*\/\s*sci|sci)\s+)?(?:security\s+)?clearance|(?:top\s+secret|secret|ts\s*\/\s*sci)\s+(?:security\s+)?clearance\s+(?:is\s+)?required)\b/i;
const CLEARANCE_EVIDENCE = /\b(?:active|current)\s+(?:(?:top\s+secret|secret|ts\s*\/\s*sci|sci)\s+)?(?:security\s+)?clearance\b|\b(?:top\s+secret|ts\s*\/\s*sci)\b/i;
const EXPERIENCE_REQUIREMENT = /\b(\d{1,2})\s*\+?\s*(?:years?|yrs?)[’']?\s*(?:of\s+)?(?:relevant\s+|professional\s+|prior\s+)?experience\b/gi;

export function evaluateJobEligibility(job = {}, {
  resume = {},
  profile = {},
  plan = {},
  now = new Date(),
  maxAgeDays = plan?.filters?.maxAgeDays || DEFAULT_MAX_AGE_DAYS,
} = {}) {
  const title = clean(job.title);
  const jobText = clean([job.title, job.company, job.category, job.department, job.description].filter(Boolean).join(" "));
  const sectorEvidenceText = clean([job.title, job.company, job.category, job.department, job.industry, job.sector].filter(Boolean).join(" "));
  const candidateText = clean([
    resume.text,
    ...(resume.skills || []),
    ...(resume.keywords || []),
    ...(resume.roleHints || []),
    ...(profile.targetRoles || []),
    ...(profile.mustHaves || []),
  ].filter(Boolean).join(" "));
  const reasons = [];
  const warnings = [];
  const checks = [];
  const ageDays = daysOld(job.postedAt, now);

  if (ageDays !== null && ageDays > maxAgeDays) {
    reject(reasons, checks, "stale-posting", `Posted ${Math.floor(ageDays)} days ago, beyond the ${maxAgeDays}-day application window.`);
  } else if (ageDays === null) {
    warnings.push({ code: "unknown-posting-age", reason: "The source did not provide a reliable posting date; verify recency before applying." });
    checks.push({ code: "posting-age", passed: null });
  } else checks.push({ code: "posting-age", passed: true });

  if (plan.seniority === "entry" && SENIOR_TITLE.test(title)) {
    reject(reasons, checks, "seniority-mismatch", "The search is entry-level, but the job title is explicitly senior or leadership level.");
  } else checks.push({ code: "seniority", passed: true });

  const requestedYears = maximumExperienceRequirement(jobText);
  if (plan.seniority === "entry" && requestedYears >= 5) {
    warnings.push({ code: "heavy-experience-requirement", reason: `The posting asks for ${requestedYears}+ years of experience despite an entry-level search. Review whether the resume proves equivalent experience before spending time applying.` });
    checks.push({ code: "experience-requirement", passed: null, requestedYears });
  } else checks.push({ code: "experience-requirement", passed: true, requestedYears });

  for (const program of SPECIAL_PROGRAMS) {
    if (program.jobPattern.test(jobText) && !program.evidencePattern.test(candidateText)) reject(reasons, checks, program.code, program.reason);
    else checks.push({ code: program.code, passed: true });
  }

  if (ACTIVE_CLEARANCE_REQUIRED.test(jobText) && !CLEARANCE_EVIDENCE.test(candidateText)) {
    reject(reasons, checks, "clearance-required", "The posting requires an active security clearance, but no active-clearance evidence is present in the candidate profile.");
  } else checks.push({ code: "clearance-required", passed: true });

  const requiredSectors = unique([
    ...(plan.requiredSectors || []),
    ...requiredSectorsFromProfile(profile),
  ]).filter((sector) => SECTORS[sector]);
  const matchedSectors = requiredSectors.filter((sector) => SECTORS[sector].some((phrase) => phrasePresent(sectorEvidenceText, phrase)));
  if (requiredSectors.length && !matchedSectors.length) {
    reject(reasons, checks, "required-sector-mismatch", `The role does not match the required sector gate (${requiredSectors.join(" or ")}).`);
  } else checks.push({ code: "required-sector", passed: true, matched: matchedSectors });

  return {
    eligible: reasons.length === 0,
    reasons,
    warnings,
    checks,
    ageDays: ageDays === null ? null : Math.floor(ageDays),
    maxAgeDays,
    requiredSectors,
    matchedSectors,
  };
}

export function requiredSectorsFromProfile(profile = {}) {
  const text = (profile.mustHaves || []).join(" ").toLowerCase();
  return Object.entries(PROFILE_SECTOR_PATTERNS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([sector]) => sector);
}

function reject(reasons, checks, code, reason) {
  reasons.push({ code, reason });
  checks.push({ code, passed: false });
}

function daysOld(value, now) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (new Date(now).getTime() - timestamp) / 86_400_000);
}

function phrasePresent(text, phrase) {
  const escaped = String(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(String(text));
}

function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function unique(values) { return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))]; }
function maximumExperienceRequirement(value) {
  let maximum = 0;
  for (const match of String(value || "").matchAll(EXPERIENCE_REQUIREMENT)) maximum = Math.max(maximum, Number(match[1]) || 0);
  return maximum;
}
