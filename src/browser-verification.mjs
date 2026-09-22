const ALLOWED_SIGNALS = new Set([
  "apply action", "job description", "responsibilities", "qualifications", "job schema", "access challenge", "closed language",
]);
const ATS_FAMILIES = new Set(["workday", "greenhouse", "lever", "ashby", "smartrecruiters", "generic"]);

export function browserVerificationFromEvidence(input = {}, { job = {}, now = () => new Date() } = {}) {
  const pageUrl = safeHttpsUrl(input.pageUrl);
  const checkedAt = now().toISOString();
  const httpStatus = Number.isInteger(input.httpStatus) ? input.httpStatus : 0;
  const signals = [...new Set((Array.isArray(input.signals) ? input.signals : []).filter((signal) => ALLOWED_SIGNALS.has(signal)))];
  const atsFamily = ATS_FAMILIES.has(input.atsFamily) ? input.atsFamily : "generic";
  const base = {
    url: pageUrl || String(input.pageUrl || "").slice(0, 2_000),
    ...(pageUrl ? { finalUrl: pageUrl } : {}),
    ...(httpStatus ? { httpStatus } : {}),
    checkedAt,
    signals,
    atsFamily,
    source: text(job.source, 40) || "browser-assisted",
    board: text(job.board, 80),
    title: text(job.title, 180) || text(input.pageTitle, 180),
    company: text(job.company, 100),
    location: text(job.location, 160),
    postedAt: iso(job.postedAt),
    firstSeenAt: iso(job.firstSeenAt),
    trustedJobMetadata: Boolean(text(job.title, 180) && safeHttpsUrl(job.url || job.applyUrl)),
    verificationMethod: "paired browser capture",
  };
  if (!pageUrl) return { status: "inconclusive", ...base, reason: "Browser capture requires the current public HTTPS job URL. Open the posting, then capture again." };
  if (signals.includes("closed language")) return { status: "closed", ...base, reason: "The rendered posting explicitly says the role is closed or no longer accepting applications." };
  if (signals.includes("access challenge")) return { status: "blocked", ...base, reason: "The browser still shows an access challenge. Complete it manually, wait for the job page, then capture again." };
  const details = signals.filter((signal) => ["job description", "responsibilities", "qualifications", "job schema"].includes(signal));
  if (httpStatus >= 200 && httpStatus < 300 && signals.includes("apply action") && details.length > 0) {
    return { status: "live", ...base, reason: `Browser evidence: rendered HTTP ${httpStatus}, usable apply action, and ${details.join(", ")}.` };
  }
  const missing = [
    !(httpStatus >= 200 && httpStatus < 300) ? "a final 2xx navigation status" : "",
    !signals.includes("apply action") ? "a usable apply action" : "",
    details.length === 0 ? "job-detail evidence" : "",
  ].filter(Boolean);
  return { status: "inconclusive", ...base, reason: `The browser capture is missing ${missing.join(" + ")}. Reload the posting, review it, then capture again.` };
}

function safeHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || privateHostname(parsed.hostname)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}
function privateHostname(value) {
  const host = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host === "::") return true;
  if (/^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host)) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}
function text(value, limit) { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
function iso(value) { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""; }
