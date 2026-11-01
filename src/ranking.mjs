import { terms } from "./resume.mjs";
import { evaluateJobEligibility } from "./eligibility.mjs";
import { analyzeQualifications } from "./qualifications.mjs";

const SENIORITY = new Set(["intern", "junior", "associate", "senior", "staff", "principal", "lead", "manager", "director", "head", "vp", "chief"]);
const GENERIC_TITLE_TERMS = new Set(["specialist", "technician", "analyst", "associate", "representative", "administrator", "admin", "engineer", "developer", "consultant", "manager"]);

export function rankJob(job, { resume = {}, profile = {}, applicationProfile = {}, query = "", location = "", plan = {}, now = new Date() } = {}) {
  const eligibility = evaluateJobEligibility(job, { resume, profile, plan, now });
  const titleTerms = terms(job.title);
  const descriptionTerms = terms(job.description).slice(0, 900);
  const jobTerms = new Set([...titleTerms, ...descriptionTerms]);
  const resumeTerms = new Set([...(resume.keywords || []), ...(resume.skills || []).flatMap(terms)]);
  const matchedSkills = (resume.skills || []).filter((skill) => phrasePresent(`${job.title} ${job.description}`, skill));
  const matchedKeywords = [...resumeTerms].filter((term) => jobTerms.has(term)).slice(0, 18);
  const openTitles = plan.titleMode === "open";
  const targetPhrases = (openTitles
    ? [...(Array.isArray(plan.titles) ? plan.titles : []), ...(resume.roleHints || [])]
    : [
      ...(Array.isArray(plan.titles) ? plan.titles : []),
      ...String(query).split(","),
      ...(profile.targetRoles || []),
      ...(resume.roleHints || []),
    ]).map((value) => String(value).trim()).filter(Boolean);
  // In an open employer search the saved role targets are not the request, so
  // an unrelated title is neutral rather than a failed match.
  const titleScore = openTitles
    ? Math.max(40, targetPhrases.length ? titleAlignment(job.title, targetPhrases) : 0)
    : targetPhrases.length
      ? titleAlignment(job.title, targetPhrases)
      : ratio(matchedKeywords.filter((term) => titleTerms.includes(term)).length, Math.min(titleTerms.length, 5));
  const skillScore = resumeTerms.size ? ratio(matchedKeywords.length + matchedSkills.length, Math.min(resumeTerms.size, 24)) : 0;
  const preferredLocations = [location, ...(profile.locations || [])].flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean);
  const locationScore = preferredLocations.length === 0
    ? 60
    : preferredLocations.some((value) => String(job.location).toLowerCase().includes(value.toLowerCase())) ? 100 : 0;
  const ageDays = daysOld(job.postedAt, now);
  const freshnessScore = ageDays === null ? 35 : ageDays <= 3 ? 100 : ageDays <= 14 ? 80 : ageDays <= 30 ? 60 : ageDays <= 90 ? 35 : 10;
  const hasPlan = Boolean(plan && Object.keys(plan).length);
  const sectors = Array.isArray(plan.sectors) ? plan.sectors : [];
  const sectorText = `${job.company} ${job.category || ""} ${String(job.description || "").slice(0, 1_500)}`.toLowerCase();
  const sectorScore = sectors.length ? (sectors.some((sector) => sectorText.includes(String(sector).toLowerCase()) || sectorAliases(sector).some((alias) => sectorText.includes(alias))) ? 100 : 0) : 60;
  const application = applicationPath(job);
  const evidence = resultConfidence(job, application);
  const qualifications = analyzeQualifications(job, resume, { now, profile, applicationProfile });
  const qualificationRiskPenalty = eligibility.warnings.some((warning) => warning.code === "heavy-experience-requirement") ? 10 : 0;
  const seniorityPenalty = plan.seniority === "entry" && /\b(senior|sr\.?|lead|manager|director|principal|staff)\b/i.test(job.title || "") ? 18 : 0;
  const locationPenalty = hasPlan && preferredLocations.length > 0 && locationScore === 0 && !/\bremote\b/i.test(`${job.location} ${job.workplaceType || ""}`) ? 20 : 0;
  const rawScore = hasPlan
    ? Math.max(0, Math.round(titleScore * 0.28 + skillScore * 0.32 + locationScore * 0.14 + freshnessScore * 0.1 + sectorScore * 0.08 + application.score * 0.08 - seniorityPenalty - locationPenalty - qualificationRiskPenalty - qualifications.penalty))
    : Math.max(0, Math.round(titleScore * 0.35 + skillScore * 0.35 + locationScore * 0.1 + freshnessScore * 0.1 + application.score * 0.1 - qualificationRiskPenalty - qualifications.penalty));
  const score = eligibility.eligible ? rawScore : 0;
  const decision = applicationDecision(score, qualifications, eligibility);
  const jobImportant = [...new Set([...titleTerms, ...descriptionTerms])]
    .filter((term) => term.length > 2 && !resumeTerms.has(term))
    .slice(0, 8);

  return {
    score,
    rawScore,
    eligibility,
    matchedSkills: [...new Set(matchedSkills)].slice(0, 10),
    matchedKeywords,
    missingKeywords: jobImportant,
    application,
    confidence: evidence,
    qualifications,
    decision,
    risks: [...new Set([
      ...eligibility.warnings.map((warning) => warning.reason),
      ...qualifications.items.filter((item) => item.importance === "required" && item.status !== "met").map((item) => `${item.label}: ${item.explanation}`),
    ])],
    reasons: fitReasons({ titleScore, skillScore, locationScore, freshnessScore, sectorScore, sectors, matchedSkills, matchedKeywords, application }),
    breakdown: {
      title: Math.round(titleScore),
      resume: Math.round(skillScore),
      location: Math.round(locationScore),
      freshness: Math.round(freshnessScore),
      application: application.score,
      qualifications: Math.max(0, 100 - qualifications.penalty * 4),
      ...(hasPlan ? { sector: Math.round(sectorScore) } : {}),
    },
  };
}

function applicationDecision(score, qualifications, eligibility) {
  if (!eligibility.eligible || qualifications.counts.missing > 0 || score < 50) return { code: "skip", label: "skip for now", reason: qualifications.counts.missing > 0 ? "A required qualification is not supported by the saved resume." : "The evidence-backed fit score is below the review threshold." };
  if (score >= 75 && qualifications.counts.uncertain === 0 && eligibility.warnings.length === 0) return { code: "apply", label: "priority apply", reason: "Strong fit with no detected qualification gaps or unresolved requirement warnings." };
  return { code: "review", label: "review first", reason: "Potential fit, but one or more requirements or evidence signals need a human check." };
}

export function applicationPath(job) {
  const candidate = job.applyUrl || job.url || "";
  let hostname = "";
  try { hostname = new URL(candidate).hostname.toLowerCase().replace(/^www\./, ""); } catch {}
  const directHosts = [
    "greenhouse.io", "lever.co", "ashbyhq.com", "smartrecruiters.com", "myworkdayjobs.com",
    "icims.com", "taleo.net", "oraclecloud.com", "successfactors.com", "paycomonline.net",
    "ultipro.com", "dayforcehcm.com", "governmentjobs.com", "schooljobs.com", "applytojob.com",
    "jobvite.com", "workable.com", "breezy.hr", "recruitee.com", "eightfold.ai", "adp.com",
  ];
  const boardHosts = ["indeed.com", "glassdoor.com", "ziprecruiter.com", "linkedin.com", "remotive.com", "arbeitnow.com"];
  if (directHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    return { kind: "direct", score: 100, label: "direct application", reason: "The link opens a recognized employer ATS or application system." };
  }
  if (boardHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    return { kind: "board", score: 55, label: "job-board handoff", reason: "The link opens a job board and may require another handoff before applying." };
  }
  return { kind: "unknown", score: 70, label: "application path unconfirmed", reason: "ClearLead will verify the destination before preparing the application." };
}

function resultConfidence(job, application) {
  let points = 0;
  const evidence = [];
  if (String(job.description || "").length >= 300) { points += 2; evidence.push("detailed description"); }
  else if (String(job.description || "").length >= 80) { points += 1; evidence.push("partial description"); }
  if (job.postedAt && Number.isFinite(Date.parse(job.postedAt))) { points += 1; evidence.push("published date"); }
  if (job.company && !/not listed/i.test(job.company)) { points += 1; evidence.push("named employer"); }
  if (job.location && !/not listed/i.test(job.location)) { points += 1; evidence.push("stated location"); }
  if (application.kind === "direct") { points += 2; evidence.push("direct ATS link"); }
  const level = points >= 6 ? "high" : points >= 2 ? "medium" : "low";
  return { level, evidence };
}

function fitReasons({ titleScore, skillScore, locationScore, freshnessScore, sectorScore, sectors, matchedSkills, matchedKeywords, application }) {
  const reasons = [];
  if (titleScore >= 70) reasons.push("Target title alignment");
  if (skillScore >= 20) reasons.push(`${Math.max(matchedSkills.length, matchedKeywords.length)} resume signals matched`);
  if (locationScore === 100) reasons.push("Preferred location match");
  if (sectors.length && sectorScore === 100) reasons.push("Preferred employer sector");
  if (freshnessScore >= 80) reasons.push("Recently published");
  if (application.kind === "direct") reasons.push("Direct employer application path");
  return reasons.slice(0, 4);
}

function sectorAliases(value) {
  const key = String(value).toLowerCase();
  if (key === "healthcare") return ["hospital", "healthcare", "medical center", "clinic"];
  if (key === "education") return ["school", "district", "university", "college", "education", "campus"];
  if (key === "public sector") return ["government", "city of", "county", "public sector"];
  if (key === "aviation") return ["airport", "airline", "aviation", "airfield", "aircraft", "airlines"];
  return [key];
}

export function dedupeJobs(jobs) {
  const byUrl = new Map();
  for (const job of jobs) {
    const urlKey = canonicalJobUrl(job.url);
    const current = byUrl.get(urlKey);
    if (!current || quality(job) > quality(current)) byUrl.set(urlKey, job);
  }
  const unique = new Map();
  for (const job of byUrl.values()) {
    const key = identity(job);
    const current = unique.get(key);
    if (!current || quality(job) > quality(current)) unique.set(key, job);
  }
  return [...unique.values()];
}

function canonicalJobUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || (parsed.hostname.toLowerCase().endsWith("smartrecruiters.com") && key.toLowerCase() === "oga")) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return String(value || "").trim();
  }
}

function identity(job) {
  const company = terms(job.company).map((term) => term.replace(/[^a-z0-9]/g, "")).filter((term) => !/^\d+$/.test(term) && !/^(?:inc|llc|ltd|limited|corp|corporation|company|co|group|holdings)$/.test(term)).join("");
  const title = terms(job.title).filter((term) => !SENIORITY.has(term)).join("-");
  const location = terms(job.location)[0] || "";
  return `${company}|${title}|${location}` || job.url;
}

function quality(job) {
  const path = applicationPath(job);
  return (job.description?.length || 0) + (job.postedAt ? 100 : 0) + (path.kind === "direct" ? 10_000 : path.kind === "unknown" ? 1_000 : 0);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.min(100, (numerator / denominator) * 100) : 0;
}

function titleAlignment(title, phrases) {
  const titleTerms = canonicalTitleTerms(title);
  const titleSet = new Set(titleTerms);
  return Math.max(0, ...phrases.map((phrase) => {
    const phraseTerms = canonicalTitleTerms(phrase).filter((term) => !SENIORITY.has(term));
    const distinctive = phraseTerms.filter((term) => !GENERIC_TITLE_TERMS.has(term));
    const basis = distinctive.length ? distinctive : phraseTerms;
    const coverage = ratio(basis.filter((term) => titleSet.has(term)).length, basis.length);
    const roleNounMatch = phraseTerms.some((term) => GENERIC_TITLE_TERMS.has(term) && titleSet.has(term));
    return Math.min(100, coverage + (coverage >= 50 && roleNounMatch ? 10 : 0));
  }));
}

function canonicalTitleTerms(value) {
  const raw = String(value || "").toLowerCase();
  const output = terms(raw).flatMap((term) => term === "pc" ? ["computer"] : term === "bi" ? ["business", "intelligence"] : term === "service" ? ["support"] : [term]);
  if (/\bend user computing\b|\beuc\b/.test(raw)) output.push("desktop", "support", "user");
  if (/\b(?:it|information technology|computer|pc)\s+technician\b/.test(raw)) output.push("computer", "support");
  return [...new Set(output)];
}

function daysOld(value, now) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (new Date(now).getTime() - timestamp) / 86_400_000);
}

function phrasePresent(text, phrase) {
  return String(text).toLowerCase().includes(String(phrase).toLowerCase());
}
