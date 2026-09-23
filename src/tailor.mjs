import { terms } from "./resume.mjs";
import { analyzeQualifications } from "./qualifications.mjs";

export function tailorResume(resumeText, job, { identity = {}, profile = {} } = {}) {
  const rawSource = String(resumeText || "").replace(/\r\n?/g, "\n").trim();
  const repairedSource = repairLigatureSpacing(rawSource);
  const originalSource = joinWrappedPdfBullets(repairedSource);
  const source = withIdentityHeader(originalSource, identity);
  if (source.length < 120) throw new Error("Add a complete resume before creating a tailored draft.");
  if (!job || job.status !== "live") throw new Error("Only a verified-live job can produce a tailored draft.");

  const qualifications = analyzeQualifications(job, { text: source }, { profile, applicationProfile: identity });
  const jobTerms = weightedJobTerms(job, qualifications.items);
  const originalLines = source.split("\n");
  const reordered = reorderBulletsWithinSections(originalLines, jobTerms, qualifications.items);
  const targeted = addTargetedProfile(reordered.lines, originalLines, jobTerms, qualifications.items);
  const resumeTerms = new Set(terms(source));
  const matched = [...jobTerms.keys()].filter((term) => resumeTerms.has(term)).slice(0, 20);
  const absent = [...jobTerms.keys()].filter((term) => !resumeTerms.has(term)).slice(0, 12);
  const changes = [
    ...(repairedSource !== rawSource ? [{ type: "cleanup", reason: "Repaired split PDF ligatures without changing claim meaning." }] : []),
    ...(originalSource !== repairedSource ? [{ type: "cleanup", reason: "Rejoined wrapped PDF bullet lines without adding words." }] : []),
    ...(source !== originalSource ? [{ type: "identity", reason: "Restored the header only from saved application identity fields." }] : []),
    ...targeted.changes,
    ...reordered.changes,
  ];
  const groundingNotes = [
    "This draft changes emphasis only: every line comes from your saved resume or application identity; no claims or metrics were invented.",
    targeted.selections.length ? `Targeted profile selected ${targeted.selections.length} verbatim source lines; no employment-history content was removed.` : "No supported evidence was strong enough to create a targeted profile, so none was invented.",
    `Requirement matrix: ${qualifications.counts.met} met, ${qualifications.counts.uncertain} uncertain, ${qualifications.counts.missing} required missing, and ${qualifications.counts.preferredMissing} preferred missing.`,
    matched.length ? `Evidence already in your resume: ${matched.join(", ")}.` : "No strong keyword overlap was found; review this role carefully before applying.",
    absent.length ? `Job-language gaps not added to the resume: ${absent.join(", ")}.` : "No obvious job-language gaps were detected in the analyzed terms.",
  ];
  const markdown = [...targeted.lines, ""].join("\n");
  return {
    markdown,
    matchedTerms: matched,
    absentTerms: absent,
    groundingNotes,
    requirementMatrix: qualifications,
    changes,
    tailoringAudit: {
      policy: "extractive-targeted-profile; source-lines-preserved; employment-history-retained",
      selections: targeted.selections,
      omissions: [],
      rewrites: changes.filter((change) => change.type === "cleanup" || change.type === "identity"),
    },
    sourceLineCount: originalLines.length,
  };
}

function withIdentityHeader(source, identity) {
  const name = String(identity?.fullName || "").trim();
  if (!name) return source;
  const section = /^(?:#{1,3}\s*)?(?:summary|profile|professional summary|experience|work experience|employment|education|skills|technical skills|certifications|projects|selected projects|awards|volunteer experience):?$/i;
  const introLines = [];
  for (const line of source.split("\n").map((value) => value.trim()).filter(Boolean)) {
    if (section.test(line)) break;
    introLines.push(line.replace(/^#{1,3}\s*/, ""));
    if (introLines.length === 4) break;
  }
  const intro = introLines.join(" ").toLowerCase();
  if (intro.includes(name.toLowerCase())) return source;
  const contact = [identity.email, identity.phone, identity.location, identity.linkedinUrl, identity.githubUrl, identity.portfolioUrl]
    .map((value) => String(value || "").trim())
    .filter((value) => value && !intro.includes(value.toLowerCase()));
  const movedIdentity = new Set([name, ...contact].map((value) => value.toLowerCase()));
  const withoutMisplacedIdentity = source.split("\n")
    .filter((line) => !movedIdentity.has(line.trim().replace(/^#{1,3}\s*/, "").toLowerCase()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return [`# ${name}`, ...(contact.length ? ["", contact.join(" | ")] : []), "", withoutMisplacedIdentity].join("\n");
}

function repairLigatureSpacing(value) {
  const fragments = new Map([
    ["work fl ows", "workflows"], ["work fl ow", "workflow"],
    ["con fi gured", "configured"], ["con fi guration", "configuration"],
    ["Con fi gure", "Configure"], ["con fi gure", "configure"],
    ["Uni fi ed", "Unified"], ["uni fi ed", "unified"],
    ["fi rst", "first"], ["fi rmware", "firmware"],
    ["pro fi le", "profile"], ["Certi fi ed", "Certified"], ["certi fi ed", "certified"],
    ["Certi fi cations", "Certifications"], ["certi fi cations", "certifications"],
    ["Veri fi cation", "Verification"], ["veri fi cation", "verification"],
    ["quali fi cations", "qualifications"], ["identi fi ed", "identified"],
    ["speci fi c", "specific"], ["ef fi cient", "efficient"],
  ]);
  let repaired = value;
  for (const [broken, intact] of fragments) repaired = repaired.replaceAll(broken, intact);
  return repaired;
}

function joinWrappedPdfBullets(value) {
  const lines = value.split("\n");
  const output = [];
  const bullet = /^\s*(?:[-*+•] |\d+[.)] )/;
  const section = /^(?:#{1,3}\s*)?(?:summary|profile|professional summary|experience|work experience|employment|education|skills|technical skills|certifications|projects|selected projects|awards|volunteer experience):?$/i;
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (bullet.test(line)) {
      while (index + 1 < lines.length) {
        const continuation = lines[index + 1].trim();
        const startsRoleHeader = /\s[•|]\s/.test(lines[index + 2] || "") && /\b(?:19|20)\d{2}\b/.test(lines[index + 3] || "");
        if (!continuation || bullet.test(continuation) || section.test(continuation) || startsRoleHeader) break;
        line += `${/-$/.test(line) ? "" : " "}${continuation}`;
        index += 1;
      }
    }
    output.push(line);
  }
  return output.join("\n");
}

function reorderBulletsWithinSections(lines, jobTerms, requirements) {
  const output = [];
  const changes = [];
  let bullets = [];
  const flush = () => {
    if (bullets.length === 0) return;
    const original = [...bullets];
    bullets.sort((left, right) => scoreLine(right.line, jobTerms) - scoreLine(left.line, jobTerms) || left.index - right.index);
    bullets.forEach((item, position) => {
      const priorPosition = original.findIndex((candidate) => candidate.index === item.index);
      if (position !== priorPosition) {
        const drivers = requirementDrivers(item.line, requirements);
        changes.push({
          type: "reorder",
          sourceLine: item.index + 1,
          from: priorPosition + 1,
          to: position + 1,
          reason: drivers.length ? `Moved within its section to emphasize supported evidence for: ${drivers.join(", ")}.` : "Moved within its section because it has stronger verified-posting term overlap.",
        });
      }
    });
    output.push(...bullets.map((item) => item.line));
    bullets = [];
  };
  lines.forEach((line, index) => {
    if (/^\s*(?:[-*+•] |\d+[.)] )/.test(line)) {
      bullets.push({ line, index });
      return;
    }
    flush();
    output.push(line);
  });
  flush();
  return { lines: output, changes };
}

function scoreLine(line, jobTerms) {
  return terms(line).reduce((score, term) => score + (jobTerms.get(term) || 0), 0);
}
function weightedJobTerms(job, requirements) {
  const weights = new Map();
  const add = (value, weight) => terms(value).forEach((term) => weights.set(term, Math.max(weights.get(term) || 0, weight)));
  add(job.description || "", 1);
  add(job.title || "", 3);
  for (const item of requirements) add(`${item.label} ${item.postingEvidence}`, item.importance === "required" ? 6 : 3);
  return weights;
}
function requirementDrivers(line, requirements) {
  const lineTerms = new Set(terms(line));
  return requirements.filter((item) => terms(`${item.label} ${item.postingEvidence}`).some((term) => lineTerms.has(term))).map((item) => item.label).slice(0, 3);
}
function addTargetedProfile(lines, sourceLines, jobTerms, requirements) {
  if (lines.some((line) => /^#{1,3}\s+targeted profile\s*$/i.test(line.trim()))) return { lines, changes: [], selections: [] };
  const candidates = sourceLines.map((line, index) => {
    const trimmed = line.trim();
    const isBullet = /^\s*(?:[-*+•] |\d+[.)] )/.test(line);
    const evidence = trimmed.replace(/^\s*(?:[-*+•] |\d+[.)] )/, "").trim();
    const neighboringDate = [sourceLines[index - 1], sourceLines[index + 1]].some((value) => /\b(?:19|20)\d{2}\b/.test(String(value || "")));
    const looksLikeRoleHeader = !isBullet && (neighboringDate || (/[|•]/.test(trimmed) && !/[.!?]$/.test(trimmed)));
    const narrativeClaim = evidence.split(/\s+/).length >= 6 && /\b(?:built|created|delivered|developed|experienced|implemented|improved|led|managed|provided|resolved|specialist|supported|troubleshot)\b/i.test(evidence);
    const isClaim = evidence.length >= 24 && (isBullet || narrativeClaim) && !looksLikeRoleHeader && !/^#{1,6}\s|^(?:19|20)\d{2}\b|^[^@\s]+@[^@\s]+$|^https?:\/\//i.test(trimmed);
    return { sourceLine: index + 1, evidence, score: isClaim ? scoreLine(evidence, jobTerms) : 0, drivers: requirementDrivers(evidence, requirements) };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.sourceLine - right.sourceLine)
    .filter((item, index, values) => values.findIndex((candidate) => candidate.evidence.toLowerCase() === item.evidence.toLowerCase()) === index)
    .slice(0, 2);
  if (!candidates.length) return { lines, changes: [], selections: [] };
  const index = targetedProfileInsertionIndex(lines);
  const profile = ["## Targeted Profile", ...candidates.map((item) => `- ${item.evidence}`), ""];
  const changes = candidates.map((item) => ({
    type: "selection",
    sourceLine: item.sourceLine,
    reason: item.drivers.length ? `Selected verbatim evidence for the targeted profile because it supports: ${item.drivers.join(", ")}.` : "Selected verbatim evidence for the targeted profile because it has the strongest verified-posting overlap.",
  }));
  return { lines: [...lines.slice(0, index), ...profile, ...lines.slice(index)], changes, selections: candidates.map(({ sourceLine, evidence, drivers }) => ({ sourceLine, evidence, requirements: drivers })) };
}
function targetedProfileInsertionIndex(lines) {
  const section = lines.findIndex((line) => /^##\s+/.test(line.trim()));
  if (section >= 0 && section <= 5) return section;
  if (!/^#\s+/.test(String(lines[0] || "").trim())) return section >= 0 ? section : 0;
  let index = 1;
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (index < lines.length && /@|https?:\/\/|linkedin|github|\+?\d[\d ().-]{7,}|\s[|•]\s/i.test(lines[index])) {
    index += 1;
    while (index < lines.length && !lines[index].trim()) index += 1;
  }
  return Math.min(index, lines.length);
}
