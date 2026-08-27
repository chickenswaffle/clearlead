const BLOCKED = /(?:equal employment|\beeo\b|demographic|disability|disabled|veteran|race|ethnicity|gender|sex assigned|sexual orientation|date of birth|birth date|social security|\bssn\b|criminal|felony|background check|certif(?:y|ication)|attest|terms and conditions|privacy policy|signature|reference|referee|referral|referrer|emergency.?contact|secondary.?contact|alternate.?contact|spouse|partner|dependent|parent|guardian|manager|supervisor|employer|recruiter|school|university|education.?contact)/i;
const REVIEW = /(?:authori[sz]ed to work|work authori[sz]ation|sponsor|visa|salary|compensation|pay expectation|relocat|notice period|start date|why (?:do|are|would)|cover letter|additional information|tell us|describe|checkbox|consent)/i;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "CLEARLEAD_FILL_SAFE_FIELDS") return;
  try { sendResponse(fillSafeFields(message.pack)); }
  catch (error) { sendResponse({ filled: 0, review: 0, blocked: 0, manual: 0, blockedPage: error.message }); }
});

function fillSafeFields(pack) {
  const currentPage = `${location.origin}${normalizedPath(location.pathname)}${location.search}`;
  if (!Array.isArray(pack?.allowedPages) || !pack.allowedPages.includes(currentPage)) {
    return { filled: 0, review: 0, blocked: 0, manual: 0, blockedPage: `This page does not exactly match the verified application page. Open the prepared URL from ClearLead.` };
  }
  const report = { filled: 0, review: 0, blocked: 0, manual: 0 };
  const fields = [...document.querySelectorAll("input:not([type='hidden']), select, textarea")].filter(visible);
  for (const field of fields) {
    const descriptor = describe(field);
    const classification = classify(field, descriptor, pack.profile || {});
    decorate(field, classification.status, classification.reason);
    if (classification.status === "safe" && classification.value) {
      if (hasValue(field)) { decorate(field, "review", "Existing value preserved"); report.review += 1; continue; }
      if (assign(field, classification.value)) report.filled += 1;
      else { decorate(field, "review", "No matching option; review manually"); report.review += 1; }
    } else if (classification.status === "blocked") report.blocked += 1;
    else if (classification.status === "manual") report.manual += 1;
    else report.review += 1;
  }
  return report;
}

function classify(field, descriptor, profile) {
  const type = String(field.type || field.tagName).toLowerCase();
  if (BLOCKED.test(descriptor)) return { status: "blocked", reason: "Sensitive or legal field — ClearLead will not fill it" };
  if (type === "file") return { status: "manual", reason: "Choose the reviewed resume file manually" };
  if (["checkbox", "radio"].includes(type) || field.tagName === "TEXTAREA" || REVIEW.test(descriptor)) return { status: "review", reason: "Requires your review" };
  const autocompleteValues = { name: profile.fullName, "given-name": profile.firstName, "family-name": profile.lastName, email: profile.email, tel: profile.phone, "address-level2": profile.city || profile.location, "address-level1": profile.state, "postal-code": profile.postalCode, "country-name": profile.country };
  const autocompleteValue = autocompleteValues[String(field.autocomplete || "").toLowerCase()] || (type === "email" ? profile.email : type === "tel" ? profile.phone : "");
  if (autocompleteValue) return { status: "safe", value: autocompleteValue, reason: "Safe browser-standard profile field" };
  const mappings = [
    [/first.?name|given.?name/, profile.firstName], [/last.?name|family.?name|surname/, profile.lastName],
    [/full.?name|legal.?name|candidate.?name|^name$/, profile.fullName], [/e-?mail/, profile.email],
    [/phone|mobile|telephone/, profile.phone], [/linkedin/, profile.linkedinUrl], [/github/, profile.githubUrl],
    [/portfolio|personal.?website|personal.?url/, profile.portfolioUrl], [/postal|zip.?code/, profile.postalCode],
    [/\bcity\b/, profile.city], [/\bstate\b|province|region/, profile.state], [/\bcountry\b/, profile.country],
    [/current.?location|location/, profile.location],
  ];
  const match = mappings.find(([pattern, value]) => value && pattern.test(descriptor));
  return match ? { status: "safe", value: match[1], reason: "Safe profile field" } : { status: "review", reason: "Unrecognized field — review manually" };
}

function describe(field) {
  const labels = [];
  if (field.id) { try { labels.push(...[...document.querySelectorAll(`label[for="${CSS.escape(field.id)}"]`)].map((item) => item.textContent)); } catch {} }
  labels.push(field.closest("label")?.textContent, field.getAttribute("aria-label"), field.getAttribute("placeholder"), field.getAttribute("name"), field.id, field.autocomplete);
  return labels.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function visible(field) { const style = getComputedStyle(field); const rect = field.getBoundingClientRect(); return !field.disabled && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; }
function hasValue(field) { return Boolean(String(field.value || "").trim()); }
function normalizedPath(value) { const pathValue = String(value || "/").replace(/\/{2,}/g, "/"); return pathValue.length > 1 ? pathValue.replace(/\/+$/, "") : "/"; }
function assign(field, value) {
  if (field.tagName === "SELECT") {
    const wanted = String(value).trim().toLowerCase();
    const option = [...field.options].find((item) => [item.value, item.textContent].some((candidate) => String(candidate).trim().toLowerCase() === wanted));
    if (!option) return false;
    setNativeValue(field, option.value);
  } else setNativeValue(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  field.dispatchEvent(new Event("blur", { bubbles: true }));
  return true;
}
function setNativeValue(field, value) {
  const ownSetter = Object.getOwnPropertyDescriptor(field, "value")?.set;
  const prototypeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  if (prototypeSetter && ownSetter !== prototypeSetter) prototypeSetter.call(field, value);
  else if (ownSetter) ownSetter.call(field, value);
  else field.value = value;
}
function decorate(field, status, reason) {
  const colors = { safe: "#49f29b", review: "#f4c95d", blocked: "#ff6b82", manual: "#55c7ff" };
  field.dataset.clearleadStatus = status;
  field.style.outline = `2px solid ${colors[status] || colors.review}`;
  field.style.outlineOffset = "2px";
  field.title = `ClearLead: ${reason}`;
}
