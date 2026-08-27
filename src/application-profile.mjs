const YES_NO_UNKNOWN = new Set(["yes", "no", "unknown"]);

export function normalizeApplicationProfile(input = {}) {
  const fullName = clean(input.fullName, 140);
  const [firstName, ...rest] = fullName.split(/\s+/).filter(Boolean);
  return {
    fullName,
    firstName: clean(input.firstName, 80) || firstName || "",
    lastName: clean(input.lastName, 100) || rest.join(" "),
    email: clean(input.email, 180),
    phone: clean(input.phone, 80),
    location: clean(input.location, 180),
    city: clean(input.city, 100),
    state: clean(input.state, 100),
    postalCode: clean(input.postalCode, 40),
    country: clean(input.country, 100),
    linkedinUrl: httpUrl(input.linkedinUrl),
    githubUrl: httpUrl(input.githubUrl),
    portfolioUrl: httpUrl(input.portfolioUrl),
    workAuthorization: choice(input.workAuthorization),
    needsSponsorship: choice(input.needsSponsorship),
    relocation: choice(input.relocation),
    desiredSalary: clean(input.desiredSalary, 120),
    savedAt: validIso(input.savedAt) || new Date().toISOString(),
  };
}

export function applicationProfileReadiness(profile = {}) {
  const value = normalizeApplicationProfile(profile);
  const missing = [...(!value.fullName ? ["full name"] : []), ...(!isEmail(value.email) ? ["valid email"] : [])];
  return {
    ready: missing.length === 0,
    missing,
    message: missing.length ? `Add ${missing.join(" and ")} before preparing autofill.` : "Application identity ready for safe-field autofill.",
  };
}

function clean(value, limit) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit); }
function choice(value) { const normalized = clean(value, 20).toLowerCase(); return YES_NO_UNKNOWN.has(normalized) ? normalized : "unknown"; }
function httpUrl(value) { try { const parsed = new URL(clean(value, 500)); return /^https?:$/.test(parsed.protocol) ? parsed.toString() : ""; } catch { return ""; } }
function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "")); }
function validIso(value) { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }
