import { terms } from "./resume.mjs";

export function tailorResume(resumeText, job, { identity = {} } = {}) {
  const originalSource = joinWrappedPdfBullets(repairLigatureSpacing(String(resumeText || "").replace(/\r\n?/g, "\n").trim()));
  const source = withIdentityHeader(originalSource, identity);
  if (source.length < 120) throw new Error("Add a complete resume before creating a tailored draft.");
  if (!job || job.status !== "live") throw new Error("Only a verified-live job can produce a tailored draft.");

  const jobTerms = new Set(terms(`${job.title} ${job.description || ""}`));
  const originalLines = source.split("\n");
  const tailoredLines = reorderBulletsWithinSections(originalLines, jobTerms);
  const resumeTerms = new Set(terms(source));
  const matched = [...jobTerms].filter((term) => resumeTerms.has(term)).slice(0, 20);
  const absent = [...jobTerms].filter((term) => !resumeTerms.has(term)).slice(0, 12);
  const groundingNotes = [
    "This draft changes emphasis only: every line comes from your saved resume or application identity; no claims or metrics were invented.",
    matched.length ? `Evidence already in your resume: ${matched.join(", ")}.` : "No strong keyword overlap was found; review this role carefully before applying.",
    absent.length ? `Job-language gaps not added to the resume: ${absent.join(", ")}.` : "No obvious job-language gaps were detected in the analyzed terms.",
  ];
  const markdown = [...tailoredLines, ""].join("\n");
  return { markdown, matchedTerms: matched, absentTerms: absent, groundingNotes, sourceLineCount: originalLines.length };
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

function reorderBulletsWithinSections(lines, jobTerms) {
  const output = [];
  let bullets = [];
  const flush = () => {
    if (bullets.length === 0) return;
    bullets.sort((left, right) => scoreLine(right, jobTerms) - scoreLine(left, jobTerms) || left.index - right.index);
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
  return output;
}

function scoreLine(line, jobTerms) {
  return terms(line).filter((term) => jobTerms.has(term)).length;
}
