const STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "been", "being", "but", "can", "company", "for", "from",
  "have", "into", "its", "more", "our", "over", "role", "that", "the", "their", "them", "they", "this",
  "through", "using", "was", "were", "will", "with", "work", "worked", "working", "years", "your",
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
  return String(value).toLowerCase().match(/[a-z0-9][a-z0-9+#.\/-]{1,}/g) || [];
}

function containsPhrase(text, phrase) {
  const variants = [phrase];
  if (phrase === "golang") variants.push("go language", " go ");
  if (phrase === "google cloud") variants.push("gcp");
  if (phrase === "large language models") variants.push("llm", "llms");
  if (phrase === "artificial intelligence") variants.push(" ai ");
  return variants.some((variant) => text.includes(variant));
}

function extractRoleHints(text) {
  const hints = [];
  const rolePattern = /\b(?:senior|staff|principal|lead|head|director|vp|vice president|chief)?\s*(?:software|data|machine learning|ml|ai|product|platform|backend|frontend|full[- ]stack|security|cloud|devops|site reliability|solutions?)\s+(?:engineer|engineering|architect|manager|designer|scientist|analyst|developer|consultant)\b/gi;
  for (const match of text.matchAll(rolePattern)) {
    const value = match[0].replace(/\s+/g, " ").trim();
    if (!hints.some((item) => item.toLowerCase() === value.toLowerCase())) hints.push(value);
    if (hints.length === 8) break;
  }
  return hints;
}

function validIso(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
