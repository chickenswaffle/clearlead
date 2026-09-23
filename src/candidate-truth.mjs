import { createHash } from "node:crypto";
import { normalizeApplicationProfile } from "./application-profile.mjs";
import { normalizeResume } from "./resume.mjs";

const SECTION = /^(?:#{1,3}\s*)?(summary|profile|professional summary|experience|work experience|employment|education|skills|technical skills|certifications|projects|selected projects|awards|volunteer experience):?$/i;
const CONTACT = /(?:@|https?:\/\/|linkedin\.com|github\.com|\+?\d[\d(). -]{7,}\d)/i;
const DATE_RANGE = /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?(?:19|20)\d{2}\s*(?:-|–|—|to)\s*(?:present|current|(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+)?(?:19|20)\d{2})\b/i;
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+/;

export function buildCandidateTruth({ resume = {}, applicationProfile = {}, builtAt } = {}) {
  const normalizedResume = normalizeResume(resume);
  const normalizedProfile = normalizeApplicationProfile(applicationProfile);
  const facts = resumeFacts(normalizedResume.text);
  const answers = applicationAnswers(normalizedProfile);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ resume: normalizedResume.text, profile: normalizedProfile, version: 1 }))
    .digest("hex");
  return {
    schema: "clearlead-candidate-truth/v1",
    fingerprint,
    builtAt: validIso(builtAt) || new Date().toISOString(),
    resumeSavedAt: normalizedResume.savedAt,
    applicationProfileSavedAt: normalizedProfile.savedAt,
    facts,
    answers,
  };
}

export function candidateTruthSummary(truth = {}) {
  const facts = Array.isArray(truth.facts) ? truth.facts : [];
  const answers = Array.isArray(truth.answers) ? truth.answers : [];
  const knownAnswers = answers.filter((answer) => answer.status === "known").length;
  return {
    schema: truth.schema || "clearlead-candidate-truth/v1",
    fingerprint: String(truth.fingerprint || "").slice(0, 16),
    factCount: facts.length,
    claimCount: facts.filter((fact) => fact.rewritable).length,
    metricCount: facts.reduce((total, fact) => total + (fact.immutableTokens?.length || 0), 0),
    answerCount: answers.length,
    knownAnswerCount: knownAnswers,
    ready: facts.some((fact) => fact.rewritable) && knownAnswers >= 2,
  };
}

function resumeFacts(resumeText) {
  const facts = [];
  let section = "identity";
  const lines = String(resumeText || "").replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const sourceText = lines[index].trim();
    if (!sourceText) continue;
    const sectionMatch = sourceText.match(SECTION);
    if (sectionMatch) section = normalizedSection(sectionMatch[1]);
    const type = factType(sourceText, section, index, Boolean(sectionMatch));
    facts.push({
      id: `R${String(index + 1).padStart(3, "0")}`,
      sourceLine: index + 1,
      section,
      type,
      sourceText,
      immutableTokens: immutableTokens(sourceText),
      rewritable: ["achievement", "summary-claim", "skill-claim", "project-claim"].includes(type),
    });
  }
  return facts;
}

function applicationAnswers(profile) {
  const fields = [
    ["identity.fullName", profile.fullName], ["identity.firstName", profile.firstName], ["identity.lastName", profile.lastName],
    ["contact.email", profile.email], ["contact.phone", profile.phone], ["contact.location", profile.location],
    ["contact.city", profile.city], ["contact.state", profile.state], ["contact.postalCode", profile.postalCode], ["contact.country", profile.country],
    ["link.linkedin", profile.linkedinUrl], ["link.github", profile.githubUrl], ["link.portfolio", profile.portfolioUrl],
    ["eligibility.workAuthorization", profile.workAuthorization], ["eligibility.needsSponsorship", profile.needsSponsorship],
    ["eligibility.age18OrOlder", profile.age18OrOlder], ["eligibility.backgroundCheckConsent", profile.backgroundCheckConsent],
    ["eligibility.restrictiveAgreement", profile.restrictiveAgreement], ["eligibility.otherLanguageFluency", profile.otherLanguageFluency],
    ["employment.priorSrsEmployment", profile.priorSrsEmployment], ["employment.currentSrsAssociate", profile.currentSrsAssociate],
    ["employment.currentHomeDepotAssociate", profile.currentHomeDepotAssociate], ["employment.relatedIndustryExperience", profile.relatedIndustryExperience],
    ["preference.relocation", profile.relocation], ["preference.workArrangement", profile.workArrangement],
    ["preference.startAvailability", profile.startAvailability], ["preference.desiredSalary", profile.desiredSalary],
  ];
  return fields.map(([key, value]) => ({
    key,
    value: String(value || ""),
    status: value && value !== "unknown" ? "known" : "unknown",
    source: "application-profile",
    reviewRequired: key.startsWith("eligibility.") || key.startsWith("employment.") || key.startsWith("preference."),
  }));
}

function factType(text, section, index, isHeading) {
  if (isHeading) return "section-heading";
  if (index <= 3 && (CONTACT.test(text) || section === "identity")) return index === 0 ? "identity" : "contact";
  if (DATE_RANGE.test(text)) return "employment-date";
  if (BULLET.test(text)) return section === "skills" ? "skill-claim" : section === "projects" ? "project-claim" : "achievement";
  if (section === "summary") return "summary-claim";
  if (section === "skills") return "skill-claim";
  if (section === "education") return "education-fact";
  if (section === "certifications") return "certification-fact";
  return "context";
}

function immutableTokens(text) {
  return [...new Set(String(text).match(/(?:\$\s?\d[\d,.]*(?:[kKmM])?|\b\d+(?:\.\d+)?%|\b(?:19|20)\d{2}\b|\b\d+\+(?!\w))/g) || [])];
}

function normalizedSection(value) {
  const text = String(value).toLowerCase();
  if (text.includes("summary") || text === "profile") return "summary";
  if (text.includes("experience") || text === "employment") return "experience";
  if (text.includes("skill")) return "skills";
  if (text.includes("certification")) return "certifications";
  if (text.includes("project")) return "projects";
  return text.replace(/\s+/g, "-");
}

function validIso(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
