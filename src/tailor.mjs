import { terms } from "./resume.mjs";

export function tailorResume(resumeText, job, { generatedAt = new Date().toISOString() } = {}) {
  const source = String(resumeText || "").replace(/\r\n?/g, "\n").trim();
  if (source.length < 120) throw new Error("Add a complete resume before creating a tailored draft.");
  if (!job || job.status !== "live") throw new Error("Only a verified-live job can produce a tailored draft.");

  const jobTerms = new Set(terms(`${job.title} ${job.description || ""}`));
  const originalLines = source.split("\n");
  const tailoredLines = reorderBulletsWithinSections(originalLines, jobTerms);
  const resumeTerms = new Set(terms(source));
  const matched = [...jobTerms].filter((term) => resumeTerms.has(term)).slice(0, 20);
  const absent = [...jobTerms].filter((term) => !resumeTerms.has(term)).slice(0, 12);
  const notes = [
    "This draft changes emphasis only: every resume line below comes from your saved resume; no claims or metrics were invented.",
    matched.length ? `Evidence already in your resume: ${matched.join(", ")}.` : "No strong keyword overlap was found; review this role carefully before applying.",
    absent.length ? `Job-language gaps not added to the resume: ${absent.join(", ")}.` : "No obvious job-language gaps were detected in the analyzed terms.",
  ];
  const markdown = [
    `# Tailored resume draft — ${job.title || "Verified role"}`,
    "",
    `- Company: ${job.company || "Not listed"}`,
    `- Verified source: ${job.finalUrl || job.url}`,
    `- Generated: ${generatedAt}`,
    "",
    "## Grounding report",
    "",
    ...notes.map((note) => `- ${note}`),
    "",
    "---",
    "",
    ...tailoredLines,
    "",
  ].join("\n");
  return { markdown, matchedTerms: matched, absentTerms: absent, sourceLineCount: originalLines.length };
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
    if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
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
