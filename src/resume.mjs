const STOP_WORDS = new Set([
  "about", "across", "after", "all", "also", "and", "any", "are", "as", "at", "be", "been", "being", "but", "by", "can", "company", "each",
  "experience", "for", "from", "had", "has", "have", "how", "if", "in", "including", "into", "is", "it", "its", "may", "more", "not", "of", "on", "or", "our", "over", "per",
  "role", "such", "than", "that", "the", "their", "them", "then", "they", "this", "through", "to", "up", "using", "was", "we", "were", "who", "will", "with", "within",
  "work", "worked", "working", "years", "you", "your",
]);

const SKILLS = [
  "artificial intelligence", "machine learning", "generative ai", "large language models", "natural language processing",
  "computer vision", "deep learning", "data science", "data engineering", "product management", "project management",
  "software engineering", "distributed systems", "system design", "technical leadership", "people management",
  "javascript", "typescript", "python", "java", "c++", "c#", "golang", "rust", "ruby", "php", "swift", "kotlin",
  "react", "next.js", "node.js", "vue", "angular", "svelte", "graphql", "rest api", "fastapi", "django", "flask",
  "postgresql", "mysql", "mongodb", "redis", "snowflake", "bigquery", "databricks", "spark", "kafka", "airflow",
  "aws", "azure", "google cloud", "gcp", "docker", "kubernetes", "terraform", "linux", "git", "github actions",
  "pytorch", "tensorflow", "scikit-learn", "pandas", "numpy", "langchain", "llamaindex", "openai", "anthropic",
  "figma", "user research", "product strategy", "roadmapping", "analytics", "experimentation", "a/b testing",
  "salesforce", "hubspot", "sql", "nosql", "security", "cybersecurity", "devops", "sre", "observability",
  "windows", "macos", "active directory", "microsoft 365", "office 365", "entra id", "servicenow", "jira",
  "help desk", "desktop support", "technical support", "troubleshooting", "networking", "tcp/ip", "dns", "dhcp", "vpn", "hardware", "itil",
];

export function normalizeResume(input = {}, now = () => new Date()) {
  const text = String(input.text || "").replace(/\r\n?/g, "\n").trim().slice(0, 300_000);
  const filename = String(input.filename || "resume.txt").trim().slice(0, 180) || "resume.txt";
  const analysis = analyzeResume(text);
  return {
    text,
    filename,
    savedAt: validIso(input.savedAt) || now().toISOString(),
    ...analysis,
  };
}

export function analyzeResume(text) {
  const normalized = String(text || "").trim();
  const tokens = words(normalized);
  const frequencies = new Map();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  const lower = normalized.toLowerCase();
  const skills = SKILLS.filter((skill) => containsPhrase(lower, skill));
  const keywords = [...frequencies]
    .filter(([word]) => !STOP_WORDS.has(word) && !/^\d+$/.test(word))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 45)
    .map(([word]) => word);
  const roleHints = extractRoleHints(normalized);
  return {
    ready: normalized.length >= 120 && tokens.length >= 20,
    wordCount: tokens.length,
    skills,
    keywords,
    roleHints,
  };
}

export function resumeSummary(resume) {
  const normalized = normalizeResume(resume || {}, () => new Date(resume?.savedAt || 0));
  return {
    ready: normalized.ready,
    filename: normalized.text ? normalized.filename : "",
    savedAt: normalized.text ? normalized.savedAt : null,
    wordCount: normalized.wordCount,
    skills: normalized.skills,
    keywords: normalized.keywords.slice(0, 18),
    roleHints: normalized.roleHints,
    message: normalized.ready
      ? `Resume ready — ${normalized.wordCount} words and ${normalized.skills.length} explicit skills indexed locally.`
      : "Add your resume text first so ClearLead can rank jobs and create grounded tailored drafts.",
  };
}

export function terms(value) {
  return [...new Set(words(value).filter((word) => !STOP_WORDS.has(word)))];
}

function words(value) {
  return (String(value).toLowerCase().match(/[a-z0-9][a-z0-9+#.\/-]{1,}/g) || [])
    .map((word) => word.replace(/[.\/-]+$/g, ""))
    .filter(Boolean);
}

function containsPhrase(text, phrase) {
  const variants = [phrase];
  if (phrase === "golang") variants.push("go language", " go ");
  if (phrase === "google cloud") variants.push("gcp");
  if (phrase === "large language models") variants.push("llm", "llms");
  if (phrase === "artificial intelligence") variants.push(" ai ");
  return variants.some((variant) => text.includes(variant));
}

const HISTORY_TITLE_NOUN = /\b(?:manager|lead|supervisor|director|coordinator|assistant|associate|specialist|technician|analyst|administrator|engineer|agent|representative|officer|consultant|clerk|operator|dispatcher|instructor|trainer|developer)\b/i;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_POINT = `(?:\\d{1,2}\\/\\d{4}|${MONTH}\\s+\\d{4}|\\d{4})`;
const DATE_RANGE = new RegExp(`${DATE_POINT}\\s*(?:-|–|—|to)\\s*(?:present|current|now|${DATE_POINT})`, "i");

function extractRoleHints(text) {
  const hints = [];
  const add = (value) => {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean && hints.length < 8 && !hints.some((item) => item.toLowerCase() === clean.toLowerCase())) hints.push(clean);
  };
  const rolePattern = /\b(?:senior|staff|principal|lead|head|director|vp|vice president|chief)?\s*(?:software|data|machine learning|ml|ai|product|platform|backend|frontend|full[- ]stack|security|cloud|devops|site reliability|solutions?)\s+(?:engineer|engineering|architect|manager|designer|scientist|analyst|developer|consultant)\b/gi;
  for (const match of text.matchAll(rolePattern)) add(match[0]);
  // Work-history headings: a short title line followed closely by a date range
  // ("Customer Support Lead" / "Contoso Water Co. • Denton, TX" / "05/2018 - 04/2021").
  const lines = text.split("\n").map((line) => line.trim());
  lines.forEach((line, index) => {
    if (line.length < 4 || line.length > 70 || /^[•*·-]/.test(line) || /[.:;]$/.test(line) || line.split(/\s+/).length > 8) return;
    if (!HISTORY_TITLE_NOUN.test(line)) return;
    const nearby = [line, ...lines.slice(index + 1, index + 3)].join(" ");
    if (DATE_RANGE.test(nearby)) add(line.replace(DATE_RANGE, "").replace(/[\s|•,–-]+$/, ""));
  });
  return hints;
}

function validIso(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
