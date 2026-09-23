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
const YEAR_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const YEAR_VALUE = "(?<years>\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)";
const EXPERIENCE_REQUIREMENTS = [
  { pattern: new RegExp(`\\b${YEAR_VALUE}\\s*\\+?\\s*(?:years?|yrs?)[’']?\\s*(?:of\\s+)?(?:[a-z0-9+#./-]+\\s+){0,8}experience\\b`, "gi"), contextual: true },
  { pattern: new RegExp(`\\b${YEAR_VALUE}\\s*\\+?\\s*(?:years?|yrs?)[’']?\\s+(?:in|with|supporting|working\\s+(?:in|with))\\s+(?:[a-z0-9+#./-]+(?:\\s+|(?=[,;!?]|\\.$|$))){1,8}`, "gi"), contextual: true },
  { pattern: new RegExp(`\\bexperience\\s*:?\\s*(?:of\\s+|at\\s+least\\s+|minimum\\s+)?${YEAR_VALUE}\\s*\\+?\\s*(?:years?|yrs?)\\b`, "gi"), contextual: false },
];

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

  const requestedYears = maximumExperienceRequirement([job.title, job.description].filter(Boolean).join("\n"));
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
  for (const clause of requirementClauses(value)) {
    if (postingRequirementIsNegated(clause) || organizationHistoryStatement(clause)) continue;
    const section = qualificationSectionFor(clause, value);
    for (const { pattern, contextual } of EXPERIENCE_REQUIREMENTS) {
      pattern.lastIndex = 0;
      for (const match of clause.matchAll(pattern)) {
        const rawYears = match.groups?.years || "";
        const years = Number(rawYears) || YEAR_WORDS[String(rawYears).toLowerCase()] || 0;
        if (contextual && !experienceRequirementContext(clause, section, years, match[0])) continue;
        maximum = Math.max(maximum, years);
      }
    }
  }
  return maximum;
}
function postingRequirementIsNegated(value) {
  return /\bnot\s+(?:strictly\s+)?required\b/i.test(value)
    || /\bno\b[^.!?;]{0,100}\b(?:is|are|will be)?\s*required\b/i.test(value)
    || /\b(?:do|does)\s+not\s+require\b/i.test(value)
    || /\bwithout\s+requiring\b/i.test(value)
    || /\bnot\s+mandatory\b/i.test(value)
    || /\bnot\s+(?:needed|necessary)\b/i.test(value)
    || /\boptional\b/i.test(value)
    || /\bno\s+need\s+(?:for|to\s+have)\b/i.test(value)
    || /\b(?:do|does)\s+not\s+need\b/i.test(value)
    || /\bneed\s+not\s+(?:have|hold|possess)\b/i.test(value);
}
function requirementClauses(value) {
  return String(value || "").split(/(?<=[.!?;])\s+|\s*[•\n]\s*/)
    .flatMap(splitRequirementClauses)
    .map((item) => item.trim()).filter(Boolean);
}
function qualificationSectionFor(evidence, context) {
  const target = clean(evidence).toLowerCase();
  let section = "";
  for (const rawLine of String(context || "").split(/\r?\n/)) {
    const line = clean(rawLine);
    if (/^(?:#{1,4}\s*)?(?:(?:minimum|required|basic|essential) qualifications?|qualifications?)\s*:?.*$/i.test(line) || /^(?:#{1,4}\s*)?(?:requirements?|must haves?|what you(?:'ll| will)? need)\s*:?.*$/i.test(line)) section = "required";
    else if (/^(?:#{1,4}\s*)?(?:preferred qualifications?|nice to have|preferred)\s*:?.*$/i.test(line)) section = "preferred";
    else if (/^(?:#{1,4}\s*)?(?:responsibilities|duties|benefits|about(?: us| the role)?|job description|what you(?:'ll| will)? do|skills|experience|education|schedule|location|compensation)\s*:?.*$/i.test(line) || /^(?:#{1,4}\s*)?[a-z][a-z &'/-]{2,80}:\s*$/i.test(line)) section = "";
    if (target && line.toLowerCase().includes(target)) return section;
  }
  return "";
}
function experienceRequirementContext(evidence, section, years, matchedText) {
  const text = clean(evidence);
  return Boolean(section)
    || /\b(?:required|requires?|minimum|must|need(?:ed)?|candidates?|applicants?|you(?:'ll| will)? (?:have|bring))\b/i.test(evidence)
    || /\byou\s+should\s+have\b/i.test(evidence)
    || /\b(?:looking\s+for|seeking|seek)\s+(?:(?:a|the)\s+)?(?:someone|candidates?|applicants?)\s+with\b/i.test(evidence)
    || (years <= 15 && new RegExp(`^${YEAR_VALUE}\\s*\\+?\\s*(?:years?|yrs?)`, "i").test(text) && /\bor equivalent experience\b/i.test(text))
    || (years <= 15 && sameRequirementText(text, matchedText))
    || /^experience\s*:/i.test(text);
}
function organizationHistoryStatement(evidence) {
  if (/\b(?:candidates?|applicants?|you|employees?)\b/i.test(evidence) && /\b(?:requires?|must|need(?:ed)?|has|have|bring)\b/i.test(evidence)) return false;
  return /\b(?:has|have|brings?|offers?|provides?|boasts?)\s+(?:over\s+|more\s+than\s+)?(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*\+?\s*(?:years?|yrs?)\b/i.test(evidence);
}
function splitRequirementClauses(value) {
  const contrastClauses = String(value || "")
    .replace(/^\s*(?:although|though)\s+/i, "")
    .split(/\s*(?:,\s*)?\b(?:but|however|while|whereas|yet|although|though)\b\s*,?\s*|\s*,\s*(?=[^,]{0,120}\b(?:required|requires?|must|minimum|optional|preferred|needed|necessary)\b)/i);
  return contrastClauses.flatMap((clause) => {
    const polarity = clause.match(/^(.*\b(?:not\s+(?:required|needed|necessary|mandatory)|optional|preferred)\b)\s+and\s+(.+\b(?:required|requires?|must|mandatory)\b.*)$/i);
    return polarity ? [polarity[1], polarity[2]] : [clause];
  }).map((clause) => clause.trim()).filter(Boolean);
}
function sameRequirementText(evidence, matchedText) { return clean(evidence).replace(/[.!?]+$/, "") === clean(matchedText).replace(/[.!?]+$/, ""); }
