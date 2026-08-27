import { terms } from "./resume.mjs";

const SENIORITY = new Set(["intern", "junior", "associate", "senior", "staff", "principal", "lead", "manager", "director", "head", "vp", "chief"]);

export function rankJob(job, { resume = {}, profile = {}, query = "", location = "", plan = {}, now = new Date() } = {}) {
  const titleTerms = terms(job.title);
  const descriptionTerms = terms(job.description).slice(0, 900);
  const jobTerms = new Set([...titleTerms, ...descriptionTerms]);
  const resumeTerms = new Set([...(resume.keywords || []), ...(resume.skills || []).flatMap(terms)]);
  const matchedSkills = (resume.skills || []).filter((skill) => phrasePresent(`${job.title} ${job.description}`, skill));
  const matchedKeywords = [...resumeTerms].filter((term) => jobTerms.has(term)).slice(0, 18);
  const targetText = [query, ...(profile.targetRoles || []), ...(resume.roleHints || [])].join(" ");
  const targetTerms = terms(targetText).filter((term) => !SENIORITY.has(term));
  const titleMatched = [...new Set(targetTerms)].filter((term) => titleTerms.includes(term));

  const titleScore = targetTerms.length
    ? ratio(titleMatched.length, Math.min(new Set(targetTerms).size, 5))
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
  const seniorityPenalty = plan.seniority === "entry" && /\b(senior|sr\.?|lead|manager|director|principal|staff)\b/i.test(job.title || "") ? 18 : 0;
  const locationPenalty = hasPlan && preferredLocations.length > 0 && locationScore === 0 && !/\bremote\b/i.test(`${job.location} ${job.workplaceType || ""}`) ? 20 : 0;
  const score = hasPlan
    ? Math.max(0, Math.round(titleScore * 0.3 + skillScore * 0.35 + locationScore * 0.15 + freshnessScore * 0.1 + sectorScore * 0.1 - seniorityPenalty - locationPenalty))
    : Math.round(titleScore * 0.4 + skillScore * 0.4 + locationScore * 0.1 + freshnessScore * 0.1);
  const jobImportant = [...new Set([...titleTerms, ...descriptionTerms])]
    .filter((term) => term.length > 2 && !resumeTerms.has(term))
    .slice(0, 8);

  return {
    score,
    matchedSkills: [...new Set(matchedSkills)].slice(0, 10),
    matchedKeywords,
    missingKeywords: jobImportant,
    breakdown: {
      title: Math.round(titleScore),
      resume: Math.round(skillScore),
      location: Math.round(locationScore),
      freshness: Math.round(freshnessScore),
      ...(hasPlan ? { sector: Math.round(sectorScore) } : {}),
    },
  };
}

function sectorAliases(value) {
  const key = String(value).toLowerCase();
  if (key === "healthcare") return ["hospital", "healthcare", "medical center", "clinic"];
  if (key === "education") return ["school", "district", "university", "college", "education", "campus"];
  if (key === "public sector") return ["government", "city of", "county", "public sector"];
  return [key];
}

export function dedupeJobs(jobs) {
  const unique = new Map();
  const urls = new Set();
  for (const job of jobs) {
    if (urls.has(job.url)) continue;
    urls.add(job.url);
    const key = identity(job);
    const current = unique.get(key);
    if (!current || quality(job) > quality(current)) unique.set(key, job);
  }
  return [...unique.values()];
}

function identity(job) {
  const company = terms(job.company).join("-");
  const title = terms(job.title).filter((term) => !SENIORITY.has(term)).join("-");
  const location = terms(job.location).slice(0, 4).join("-");
  return `${company}|${title}|${location}` || job.url;
}

function quality(job) {
  return (job.description?.length || 0) + (job.postedAt ? 100 : 0) + (/jobs\.(lever|ashbyhq)|greenhouse/.test(job.url || "") ? 100 : 0);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.min(100, (numerator / denominator) * 100) : 0;
}

function daysOld(value, now) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (new Date(now).getTime() - timestamp) / 86_400_000);
}

function phrasePresent(text, phrase) {
  return String(text).toLowerCase().includes(String(phrase).toLowerCase());
}
