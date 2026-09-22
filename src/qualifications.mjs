const YEAR_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const EXPERIENCE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*\+?\s*(?:years?|yrs?)[’']?\s*(?:of\s+)?(?:relevant\s+|professional\s+|prior\s+)?experience\b/gi;
const DATE_RANGE = /\b(?:(\d{1,2})[/-])?((?:19|20)\d{2})\s*(?:-|–|—|to)\s*(?:(?:(\d{1,2})[/-])?((?:19|20)\d{2})|(present|current))\b/gi;
const DEGREES = [
  { level: 3, name: "bachelor's degree", job: /\bbachelor(?:'s|’s|s)?\s+degree\b/i, candidate: /\bbachelor(?:'s|’s|s)?(?:\s+degree|\s+of|\s+in)?\b|\bb\.?[as]\.?\b/i },
  { level: 2, name: "associate degree", job: /\bassociate(?:'s|’s|s)?\s+degree\b/i, candidate: /\bassociate(?:'s|’s|s)?(?:\s+degree|\s+of|\s+in)?\b|\ba\.?[as]\.?\b/i },
  { level: 1, name: "high school diploma", job: /\b(?:high school diploma|ged)\b/i, candidate: /\b(?:high school diploma|ged)\b/i },
];
const CERTIFICATIONS = ["A+", "Network+", "Security+", "ITIL", "CCNA", "MCSA", "MCP", "CompTIA"];
const REQUIRED = /\b(?:required|must(?:\s+have|\s+be)?|minimum qualification|need(?:ed)? to|requires?)\b/i;
const PREFERRED = /\b(?:preferred|desirable|nice to have|a plus|ideally)\b/i;

export function analyzeQualifications(job = {}, resume = {}, { now = new Date(), profile = {}, applicationProfile = {} } = {}) {
  const jobText = normalize(`${job.title || ""}\n${job.description || ""}`);
  const resumeText = String(resume.text || "");
  const candidateText = normalize(`${resumeText}\n${(resume.skills || []).join(" ")}\n${(resume.keywords || []).join(" ")}`);
  const preferenceText = normalize(`${(profile.preferences || []).join(" ")} ${(profile.mustHaves || []).join(" ")}`);
  const items = [];

  const requestedYears = maximumExperience(jobText);
  const experienceEvidence = sentenceFor(jobText, EXPERIENCE);
  if (requestedYears > 0) {
    const historyYears = datedHistoryYears(candidateText, now);
    const enoughDatedHistory = historyYears !== null && historyYears >= requestedYears;
    items.push(requirement({
      code: "experience-years", label: `${requestedYears}+ years experience`, importance: importanceOf(experienceEvidence, "required"),
      status: enoughDatedHistory ? "uncertain" : "missing", postingEvidence: experienceEvidence,
      candidateEvidence: enoughDatedHistory ? `About ${historyYears} years of dated work history found.` : historyYears === null ? "No reliably parsed dated work history." : `About ${historyYears} years of dated work history found.`,
      explanation: enoughDatedHistory ? "Confirm that enough of the dated history is relevant to this role." : "The saved resume does not currently prove the requested duration.",
    }));
  }

  const degree = DEGREES.find((item) => item.job.test(jobText));
  if (degree) {
    const postingEvidence = sentenceFor(jobText, degree.job);
    const candidateDegree = DEGREES.find((item) => item.level >= degree.level && item.candidate.test(candidateText));
    const equivalentAllowed = /\bor equivalent(?:\s+(?:combination|experience|education))?\b/i.test(postingEvidence || jobText);
    items.push(requirement({
      code: "education", label: degree.name, importance: importanceOf(postingEvidence, "required"),
      status: candidateDegree ? "met" : equivalentAllowed ? "uncertain" : "missing", postingEvidence,
      candidateEvidence: candidateDegree ? evidenceLine(resumeText, candidateDegree.candidate) : "No matching degree line found.",
      explanation: candidateDegree ? "Matching education evidence appears in the saved resume." : equivalentAllowed ? "The posting allows an equivalent path; confirm the resume makes that equivalency obvious." : "No matching degree evidence was found.",
    }));
  }

  for (const certification of mentionedCertifications(jobText)) {
    const postingEvidence = sentenceFor(jobText, new RegExp(escapeRegex(certification), "i"));
    const importance = importanceOf(postingEvidence, PREFERRED.test(postingEvidence) ? "preferred" : "required");
    const present = containsToken(candidateText, certification);
    items.push(requirement({
      code: `cert-${certification.toLowerCase().replace(/\W+/g, "")}`, label: `${certification} certification`, importance,
      status: present ? "met" : importance === "preferred" ? "missing" : "missing", postingEvidence,
      candidateEvidence: present ? evidenceLine(resumeText, new RegExp(escapeRegex(certification), "i")) : "No matching certification line found.",
      explanation: present ? "Matching certification evidence appears in the saved resume." : `${importance === "preferred" ? "Preferred" : "Required"} certification evidence was not found.`,
    }));
  }

  const languageEvidence = sentenceFor(jobText, /\b(?:fluent|fluency|bilingual|proficien(?:t|cy))\b[^.!?;]{0,40}\b(?:spanish|french|mandarin|cantonese|german|japanese|korean|arabic)\b|\b(?:spanish|french|mandarin|cantonese|german|japanese|korean|arabic)\b[^.!?;]{0,30}\b(?:required|must|preferred)\b/i);
  if (languageEvidence) {
    const language = languageEvidence.match(/\b(spanish|french|mandarin|cantonese|german|japanese|korean|arabic)\b/i)?.[1] || "specified language";
    const candidateLine = evidenceLine(resumeText, new RegExp(`\\b${escapeRegex(language)}\\b`, "i"));
    items.push(requirement({ code: `language-${language.toLowerCase()}`, label: `${language} proficiency`, importance: importanceOf(languageEvidence, "required"), status: candidateLine ? "met" : "missing", postingEvidence: languageEvidence, candidateEvidence: candidateLine || "No matching language evidence found.", explanation: candidateLine ? "Language evidence appears in the saved resume." : "The saved resume does not prove this language requirement." }));
  }

  for (const [code, label, pattern] of [
    ["schedule", "schedule availability", /\b(?:overnight|night shift|weekends?|on[- ]call|rotating shift)\b/i],
    ["travel", "travel requirement", /\b(?:travel(?:ing)?\s+(?:up to\s+)?\d{1,3}%|\d{1,3}%\s+travel)\b/i],
  ]) {
    const postingEvidence = sentenceFor(jobText, pattern);
    if (!postingEvidence) continue;
    const candidateEvidence = evidenceLine(preferenceText, pattern);
    items.push(requirement({ code, label, importance: importanceOf(postingEvidence, "required"), status: candidateEvidence ? "met" : "uncertain", postingEvidence, candidateEvidence: candidateEvidence || "No saved availability preference answers this requirement.", explanation: candidateEvidence ? "Saved targeting evidence appears to support this condition." : "Confirm this condition before applying." }));
  }

  const authorizationEvidence = sentenceFor(jobText, /\b(?:authorized to work|work authorization|without sponsorship|sponsorship (?:is )?not available|must not require sponsorship)\b/i);
  if (authorizationEvidence) {
    const knownAuthorized = applicationProfile.workAuthorization === "yes";
    const knownNoSponsorship = applicationProfile.needsSponsorship === "no";
    const requiresNoSponsorship = /\b(?:without sponsorship|sponsorship (?:is )?not available|must not require sponsorship)\b/i.test(authorizationEvidence);
    const met = knownAuthorized && (!requiresNoSponsorship || knownNoSponsorship);
    items.push(requirement({ code: "work-authorization", label: "work authorization", importance: "required", status: met ? "met" : "uncertain", postingEvidence: authorizationEvidence, candidateEvidence: met ? "Saved application answers support this requirement." : "Saved work-authorization answers are incomplete or require review.", explanation: met ? "Known application answers support this requirement." : "Confirm authorization and sponsorship before applying." }));
  }

  const counts = { met: 0, uncertain: 0, missing: 0, preferredMissing: 0 };
  for (const item of items) {
    if (item.importance === "preferred" && item.status === "missing") counts.preferredMissing += 1;
    else counts[item.status] += 1;
  }
  return { items, counts, penalty: Math.min(30, counts.missing * 15 + counts.uncertain * 4 + counts.preferredMissing) };
}

function requirement(value) { return { ...value, postingEvidence: quote(value.postingEvidence), candidateEvidence: quote(value.candidateEvidence) }; }
function maximumExperience(value) { let maximum = 0; for (const match of String(value || "").matchAll(EXPERIENCE)) maximum = Math.max(maximum, Number(match[1]) || YEAR_WORDS[String(match[1]).toLowerCase()] || 0); return maximum; }
function datedHistoryYears(value, now) {
  const intervals = [];
  for (const match of String(value || "").matchAll(DATE_RANGE)) {
    const start = Date.UTC(Number(match[2]), Math.max(0, Number(match[1] || 1) - 1), 1);
    const end = match[5] ? new Date(now).getTime() : Date.UTC(Number(match[4]), Math.max(0, Number(match[3] || 12) - 1), 1);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) intervals.push([start, end]);
  }
  if (!intervals.length) return null;
  intervals.sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const interval of intervals) { const last = merged.at(-1); if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]); else merged.push([...interval]); }
  return Math.max(0, Math.round(merged.reduce((total, [start, end]) => total + end - start, 0) / 31_557_600_000));
}
function mentionedCertifications(jobText) { return CERTIFICATIONS.filter((certification) => containsToken(jobText, certification)); }
function importanceOf(evidence, fallback) { return PREFERRED.test(evidence) ? "preferred" : REQUIRED.test(evidence) ? "required" : fallback; }
function sentenceFor(value, pattern) { return String(value || "").split(/(?<=[.!?;])\s+|\s*[•\n]\s*/).map((item) => item.trim()).find((item) => { pattern.lastIndex = 0; return pattern.test(item); }) || ""; }
function evidenceLine(value, pattern) { return String(value || "").split(/\r?\n|[,;]+/).map((item) => item.trim()).find((item) => pattern.test(item)) || ""; }
function containsToken(value, token) { return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(token)}(?:$|[^a-z0-9+])`, "i").test(String(value)); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function quote(value) { const clean = normalize(value); return clean ? `“${clean.slice(0, 220)}”` : ""; }
function normalize(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
