const BLOCKED = /(?:equal employment|\beeo\b|demographic|disability|disabled|veteran|race|ethnicity|gender|sex assigned|sexual orientation|date of birth|birth date|social security|\bssn\b|criminal|felony|background check|certif(?:y|ication)|attest|terms and conditions|privacy policy|signature|reference|referee|referral|referrer|emergency.?contact|secondary.?contact|alternate.?contact|spouse|partner|dependent|parent|guardian|manager|supervisor|employer|recruiter|school|university|education.?contact)/i;
const REVIEW = /(?:authori[sz]ed to work|work authori[sz]ation|sponsor|visa|salary|compensation|pay expectation|relocat|notice period|start date|why (?:do|are|would)|cover letter|additional information|tell us|describe|checkbox|consent)/i;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CLEARLEAD_FILL_SAFE_FIELDS") {
    fillSafeFields(message.pack)
      .then(sendResponse)
      .catch((error) => sendResponse({ filled: 0, savedAnswers: 0, review: 0, blocked: 0, manual: 0, blockedPage: error.message }));
    return true;
  }
  if (message?.type === "CLEARLEAD_CAPTURE_VERIFICATION") {
    try { sendResponse(captureVerificationEvidence()); }
    catch (error) { sendResponse({ captureError: error.message }); }
  }
  if (message?.type === "CLEARLEAD_INSPECT_APPLICATION") {
    try { sendResponse(inspectApplicationPage()); }
    catch (error) { sendResponse({ inspectionError: error.message }); }
  }
  if (message?.type === "CLEARLEAD_ATTACH_RESUME") {
    try { sendResponse(attachSelectedResume(message.pack, message.resume)); }
    catch (error) { sendResponse({ attached: 0, attachmentError: error.message }); }
  }
});

let lastAutomaticVerification = "";
function sendAutomaticVerification() {
  try {
    const adapter = globalThis.ClearLeadAdapters?.detect?.(location.href);
    if (!adapter || adapter.id === "generic") return;
    const evidence = captureVerificationEvidence();
    if (!evidence.signals.length) return;
    const signature = JSON.stringify([evidence.pageUrl, evidence.httpStatus, evidence.atsFamily, evidence.signals]);
    if (signature === lastAutomaticVerification) return;
    lastAutomaticVerification = signature;
    chrome.runtime.sendMessage({ type: "CLEARLEAD_AUTO_VERIFY_EVIDENCE", evidence }).catch(() => {});
  } catch { /* Manual verification remains available when a page is still rendering. */ }
}
if (typeof setTimeout === "function") {
  setTimeout(sendAutomaticVerification, 800);
  setTimeout(sendAutomaticVerification, 3500);
}

function inspectApplicationPage() {
  const pageUrl = new URL(location.href);
  if (pageUrl.protocol !== "https:" || privateHostname(pageUrl.hostname)) throw new Error("Open the public HTTPS application page, then inspect it again.");
  const inspection = globalThis.ClearLeadAdapters?.inspectPage?.(document, pageUrl.toString()) || { atsFamily: "generic", supported: false, phase: "posting", fieldCount: 0, canRunSafeFill: false };
  const headings = [...document.querySelectorAll("h1, h2")].slice(0, 4).map((item) => String(item.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const socialTitle = String(document.querySelector?.("meta[property='og:title']")?.getAttribute("content") || "").trim();
  return {
    ...inspection,
    pageUrl: pageUrl.toString(),
    pageTitle: String(document.title || "").trim().slice(0, 180),
    identityText: [document.title, socialTitle, ...headings].filter(Boolean).join(" | ").replace(/\s+/g, " ").slice(0, 500),
    referrer: safePublicReferrer(document.referrer),
  };
}

function captureVerificationEvidence() {
  const pageUrl = new URL(location.href);
  if (pageUrl.protocol !== "https:" || privateHostname(pageUrl.hostname)) {
    throw new Error("Open the public HTTPS employer job page — not ClearLead — then choose Verify current job page again.");
  }
  pageUrl.hash = "";
  const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 250_000);
  const signals = [];
  const controls = [...document.querySelectorAll("a, button, input[type='submit'], input[type='button']")].filter(visible);
  const applyAction = controls.some((control) => {
    if (control.getAttribute("aria-disabled") === "true") return false;
    if (control.tagName === "A") {
      const href = String(control.getAttribute("href") || "").trim();
      if (!href || /^(?:#$|javascript:|data:)/i.test(href)) return false;
    }
    const label = [control.textContent, control.value, control.getAttribute("aria-label"), control.getAttribute("title")].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return /\b(?:apply(?: now| for this job)?|submit application|i['’]?m interested|start (?:your )?application)\b/i.test(label);
  });
  if (applyAction) signals.push("apply action");
  for (const [name, pattern] of [
    ["job description", /\bjob description\b/i], ["responsibilities", /\bresponsibilities\b/i], ["qualifications", /\bqualifications\b/i],
  ]) if (pattern.test(bodyText)) signals.push(name);
  const schemas = [...document.querySelectorAll("script[type='application/ld+json']")];
  if (schemas.some((script) => /["']@type["']\s*:\s*["']JobPosting["']/i.test(script.textContent || ""))) signals.push("job schema");
  if (/\b(position|role|job|posting)\s+(?:is\s+)?(?:closed|expired|filled|no longer available)|\bno longer accepting applications\b/i.test(bodyText)) signals.push("closed language");
  if (/\bverify you are human\b|\bchecking your browser\b|\bcomplete (?:the )?captcha\b|\bcaptcha verification\b/i.test(bodyText)) signals.push("access challenge");
  const navigation = globalThis.performance?.getEntriesByType?.("navigation")?.[0];
  const httpStatus = Number(navigation?.responseStatus || 0);
  const ats = globalThis.ClearLeadAdapters?.detect?.(pageUrl.toString()) || { id: "generic" };
  const inspection = globalThis.ClearLeadAdapters?.inspectPage?.(document, pageUrl.toString());
  if (inspection?.phase === "application" && Number(inspection.fieldCount) > 0 && Number(inspection.nextControlCount || inspection.submitControlCount) > 0) signals.push("application form");
  return {
    pageUrl: pageUrl.toString(),
    pageTitle: String(document.title || "").trim().slice(0, 180),
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : 0,
    atsFamily: ats.id,
    signals: [...new Set(signals)],
  };
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
function safePublicReferrer(value) {
  try {
    const page = new URL(String(value || ""));
    if (page.protocol !== "https:" || privateHostname(page.hostname)) return "";
    page.hash = "";
    return page.toString();
  } catch { return ""; }
}

async function fillSafeFields(pack) {
  const currentPage = `${location.origin}${normalizedPath(location.pathname)}${location.search}`;
  if (!allowedApplicationPage(pack, currentPage)) {
    return { filled: 0, review: 0, blocked: 0, manual: 0, blockedPage: `This page does not exactly match the verified application page. Open the prepared URL from ClearLead.` };
  }
  const inspection = inspectApplicationPage();
  if (inspection.phase !== "application") {
    return { filled: 0, review: 0, blocked: 0, manual: 0, atsFamily: inspection.atsFamily, phase: inspection.phase, blockedPage: inspection.phase === "complete" ? "This application already appears complete." : "Open the employer's application form before filling fields." };
  }
  const report = { filled: 0, savedAnswers: 0, review: 0, blocked: 0, manual: 0, atsFamily: inspection.atsFamily, phase: inspection.phase, truthFingerprint: String(pack?.truth?.fingerprint || "") };
  const ats = globalThis.ClearLeadAdapters?.detect?.(location.href) || { id: "generic" };
  const scopedFields = globalThis.ClearLeadAdapters?.applicationFields?.(document, location.href);
  const fields = (Array.isArray(scopedFields) ? scopedFields : [...document.querySelectorAll("input:not([type='hidden']), select, textarea")]).filter(visible);
  for (const field of fields) {
    if (knownRelativeStartDateField(field, pack.answers || {})) continue;
    const descriptor = describe(field);
    const classification = classify(field, descriptor, pack.profile || {}, ats.id);
    decorate(field, classification.status, classification.reason);
    if (classification.status === "safe" && classification.value) {
      if (hasValue(field)) { decorate(field, "review", "Existing value preserved"); report.review += 1; continue; }
      if (assign(field, classification.value)) report.filled += 1;
      else { decorate(field, "review", "No matching option; review manually"); report.review += 1; }
    } else if (classification.status === "blocked") report.blocked += 1;
    else if (classification.status === "manual") report.manual += 1;
    else report.review += 1;
  }
  const saved = await fillSavedAnswerControls(pack.answers || {});
  report.filled += saved.filled;
  report.savedAnswers = saved.filled;
  report.review += saved.review;
  const startDate = fillRelativeStartDate(pack.answers || {});
  report.filled += startDate.filled;
  report.savedAnswers += startDate.filled;
  report.review += startDate.review;
  return report;
}

const SAVED_ANSWER_RULES = [
  ["currentSrsAssociate", /currently an associate of srs distribution .*heritage family of companies or gms family of companies/],
  ["currentHomeDepotAssociate", /currently an associate of the home depot or one of its subsidiaries/],
  ["age18OrOlder", /are you at least 18 years of age or older/],
  ["backgroundCheckConsent", /background check and drug screen.*acknowledge and agree/],
  ["workAuthorization", /are you legally authorized to work in the united states/],
  ["needsSponsorship", /require the company to support or sponsor you for any u s immigration benefit/],
  ["relatedIndustryExperience", /previously worked in the building supply distribution outdoor products specialty business products retail or related/],
  ["restrictiveAgreement", /written agreement with your previous employer.*restricts your right to compete/],
  ["otherLanguageFluency", /fluent in a language other than english/],
  ["priorSrsEmployment", /previously worked at srs distribution/],
  ["relocation", /willing to relocate/],
  ["workArrangement", /work arrangements may include fully on site or a hybrid schedule.*preferred availability/, {
    onsite: "Fully on-site, five days a week",
    hybrid: "Hybrid (a combination of remote and on-site work)",
    either: "Either (fully on-site or hybrid)",
    remote: "Remote Only – (reside outside of job position area)",
  }],
];

function savedAnswerForQuestion(question, answers = {}) {
  const normalized = String(question || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const rule = SAVED_ANSWER_RULES.find(([, pattern]) => pattern.test(normalized));
  if (!rule) return null;
  const value = answers[rule[0]];
  if (!["yes", "no", "onsite", "hybrid", "either", "remote"].includes(value)) return null;
  const option = rule[2]?.[value];
  return option ? { key: rule[0], value, option } : { key: rule[0], value };
}

async function fillSavedAnswerControls(answers) {
  const report = { filled: 0, review: 0 };
  if (!answers || typeof answers !== "object") return report;
  if (!Object.values(answers).some((value) => ["yes", "no", "onsite", "hybrid", "either", "remote"].includes(value))) return report;
  const groups = [...document.querySelectorAll('[role="group"], fieldset')];
  for (const group of groups) {
    const matched = savedAnswerForQuestion(group.textContent, answers);
    if (!matched) continue;
    const target = matched.option || matched.value;
    const existing = selectedAnswer(group, target);
    if (existing) {
      const existingControl = answerControl(group) || group.querySelector("select") || group.querySelector('input[type="radio"]:checked');
      if (existingControl) decorate(existingControl, "review", `Saved answer preserved: ${existing}`);
      continue;
    }
    const nativeSelect = group.querySelector("select");
    if (nativeSelect) {
      if (assign(nativeSelect, target)) {
        decorate(nativeSelect, "safe", `Confirmed answer reused: ${matched.value}`);
        report.filled += 1;
      } else report.review += 1;
      continue;
    }
    const radios = [...group.querySelectorAll('input[type="radio"]')];
    const radio = radios.find((item) => yesNoText(item, group) === matched.value);
    if (radio) {
      setNativeChecked(radio, true);
      decorate(radio, "safe", `Confirmed answer reused: ${matched.value}`);
      report.filled += 1;
      continue;
    }
    const button = answerControl(group);
    if (!button) { report.review += 1; continue; }
    dispatchMouseClick(button);
    await shortWait();
    const option = [...document.querySelectorAll('[role="option"]')]
      .filter(visible)
      .find((item) => String(item.textContent || "").trim().toLowerCase() === target.toLowerCase());
    if (!option) { decorate(button, "review", "Saved answer found, but this control needs manual selection"); report.review += 1; continue; }
    dispatchMouseClick(option);
    await shortWait();
    decorate(button, "safe", `Confirmed answer reused: ${matched.value}`);
    report.filled += 1;
  }
  return report;
}

function answerControl(group) {
  return [...group.querySelectorAll("button")].find((button) => !/\b(?:back|next|continue|submit|apply)\b/i.test(String(button.textContent || ""))) || null;
}
function selectedAnswer(group, target) {
  const select = group.querySelector("select");
  if (select) {
    const selected = select.options?.[select.selectedIndex];
    const value = String(selected?.textContent || select.value || "").trim();
    if (value.toLowerCase() === String(target).toLowerCase()) return value;
  }
  const checked = group.querySelector('input[type="radio"]:checked');
  if (checked) return yesNoText(checked, group);
  const button = answerControl(group);
  const text = String(button?.textContent || "").trim();
  return text.toLowerCase() === String(target).toLowerCase() ? text : "";
}
function yesNoText(field, group) {
  const own = [field.value, field.getAttribute?.("aria-label")].filter(Boolean).join(" ").toLowerCase();
  if (/\byes\b/.test(own)) return "yes";
  if (/\bno\b/.test(own)) return "no";
  if (field.id) {
    const label = group.querySelector(`label[for="${CSS.escape(field.id)}"]`);
    const text = String(label?.textContent || "").trim().toLowerCase();
    if (/^(?:yes|no)$/.test(text)) return text;
  }
  return "";
}
function setNativeChecked(field, checked) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "checked")?.set;
  if (setter) setter.call(field, checked); else field.checked = checked;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}
function dispatchMouseClick(element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: globalThis.window }));
}
function shortWait() { return new Promise((resolve) => setTimeout(resolve, 40)); }

function knownRelativeStartDateField(field, answers = {}) {
  if (!["immediate", "one-week", "two-weeks"].includes(answers.startAvailability)) return false;
  const group = field.closest?.('[role="group"], fieldset');
  return Boolean(group && /(?:earliest|available).*(?:start|available).*date|start date/i.test(String(group.textContent || "")));
}

function fillRelativeStartDate(answers = {}, now = new Date()) {
  const preference = answers.startAvailability;
  if (!["immediate", "one-week", "two-weeks"].includes(preference)) return { filled: 0, review: 0 };
  const groups = [...document.querySelectorAll('[role="group"], fieldset')];
  const group = groups.find((item) => /(?:earliest|available).*(?:start|available).*date|start date/i.test(String(item.textContent || "")));
  if (!group) return { filled: 0, review: 0 };
  const inputs = [...group.querySelectorAll("input:not([type='hidden'])")].filter(visible);
  if (!inputs.length) return { filled: 0, review: 1 };
  if (inputs.some(hasValue)) return { filled: 0, review: 0 };
  const date = relativeStartDate(preference, now);
  const iso = dateParts(date);
  const dateInput = inputs.find((input) => String(input.type || "").toLowerCase() === "date");
  if (dateInput) {
    setNativeValue(dateInput, iso.iso);
    decorate(dateInput, "safe", `Confirmed relative start availability: ${preference}`);
    return { filled: 1, review: 0 };
  }
  const month = inputs.find((input) => /\bmonth\b|\bmm\b/i.test(dateDescriptor(input)));
  const day = inputs.find((input) => /\bday\b|\bdd\b/i.test(dateDescriptor(input)));
  const year = inputs.find((input) => /\byear\b|\byyyy\b/i.test(dateDescriptor(input)));
  if (month && day && year) {
    setNativeValue(month, String(iso.month));
    setNativeValue(day, String(iso.day));
    setNativeValue(year, String(iso.year));
    [month, day, year].forEach((input) => decorate(input, "safe", `Confirmed relative start availability: ${preference}`));
    return { filled: 1, review: 0 };
  }
  if (inputs.length === 1) {
    setNativeValue(inputs[0], iso.display);
    decorate(inputs[0], "safe", `Confirmed relative start availability: ${preference}`);
    return { filled: 1, review: 0 };
  }
  return { filled: 0, review: 1 };
}

function relativeStartDate(preference, now = new Date()) {
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + (preference === "two-weeks" ? 14 : preference === "one-week" ? 7 : 0));
  if (date.getDay() === 6) date.setDate(date.getDate() + 2);
  if (date.getDay() === 0) date.setDate(date.getDate() + 1);
  return date;
}

function dateParts(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return { year, month, day, iso: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, display: `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}` };
}

function dateDescriptor(field) {
  return [field.getAttribute?.("aria-label"), field.getAttribute?.("placeholder"), field.name, field.id].filter(Boolean).join(" ");
}

function attachSelectedResume(pack, resume = {}) {
  const currentPage = `${location.origin}${normalizedPath(location.pathname)}${location.search}`;
  if (!allowedApplicationPage(pack, currentPage)) throw new Error("This page does not exactly match the verified application page. Open the prepared URL from ClearLead.");
  const inspection = inspectApplicationPage();
  if (inspection.phase !== "application") throw new Error("Open the employer's application form before attaching the selected resume.");
  const filename = String(resume.filename || "").replace(/[^a-z0-9._ -]/gi, "").slice(0, 160);
  if (!filename || !/\.pdf$/i.test(filename) || resume.mimeType !== "application/pdf" || !resume.base64) throw new Error("The selected resume is unavailable or is not a PDF.");
  const fields = [...document.querySelectorAll("input[type='file']")].filter(visible);
  const candidates = fields.filter((field) => {
    const descriptor = describe(field);
    const acceptsPdf = !field.accept || /pdf|application\/pdf|\.pdf/i.test(field.accept);
    return acceptsPdf && /resume|résumé|curriculum|\bcv\b/i.test(descriptor) && !/cover|portfolio|transcript|certificate/i.test(descriptor);
  });
  const target = candidates.length === 1 ? candidates[0] : fields.length === 1 && (!fields[0].accept || /pdf|application\/pdf|\.pdf/i.test(fields[0].accept)) ? fields[0] : null;
  if (!target) return { attached: 0, message: candidates.length > 1 ? "More than one resume field was found. Attach the reviewed file manually." : "No unambiguous PDF resume field was found on this step." };
  if (target.files?.length) return { attached: 0, message: "A file is already attached. ClearLead preserved it." };
  const binary = atob(resume.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const file = new File([bytes], filename, { type: "application/pdf", lastModified: Date.now() });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  target.files = transfer.files;
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  decorate(target, "safe", "Selected ClearLead resume attached for your review");
  return { attached: 1, filename, atsFamily: inspection.atsFamily, stepLabel: inspection.stepLabel };
}

function allowedApplicationPage(pack, currentPage) {
  if (Array.isArray(pack?.allowedPages) && pack.allowedPages.includes(currentPage)) return true;
  const scope = pack?.navigation;
  if (!scope?.multiPage) return false;
  try {
    const page = new URL(currentPage);
    const prepared = new URL(scope.origin);
    const sameOrigin = page.origin === prepared.origin;
    const suffix = String(scope.allowedHostSuffix || "").toLowerCase();
    const hostMatches = (hostname) => Boolean(suffix) && (hostname === suffix || hostname.endsWith(`.${suffix}`));
    if (!sameOrigin && !(hostMatches(prepared.hostname) && hostMatches(page.hostname))) return false;
    const tokens = Array.isArray(scope.jobTokens) ? scope.jobTokens : [];
    const pathSegments = page.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part).toLowerCase());
    const tokenMatch = tokens.some((token) => {
      const normalized = String(token || "").toLowerCase();
      if (!normalized.includes("=")) return normalized && pathSegments.includes(normalized);
      const separator = normalized.indexOf("=");
      return page.searchParams.get(normalized.slice(0, separator))?.toLowerCase() === normalized.slice(separator + 1);
    });
    if (tokenMatch) return true;
    const hasQueryToken = tokens.some((token) => String(token).includes("="));
    return sameOrigin && !hasQueryToken && scope.pathPrefix && (page.pathname === scope.pathPrefix || page.pathname.startsWith(`${scope.pathPrefix}/`));
  } catch { return false; }
}

function classify(field, descriptor, profile, atsFamily = "generic") {
  const type = String(field.type || field.tagName).toLowerCase();
  if (BLOCKED.test(descriptor)) return { status: "blocked", reason: "Sensitive or legal field — ClearLead will not fill it" };
  if (type === "file") return { status: "manual", reason: "Choose the reviewed resume file manually" };
  if (["checkbox", "radio"].includes(type) || field.tagName === "TEXTAREA" || REVIEW.test(descriptor)) return { status: "review", reason: "Requires your review" };
  const autocompleteValues = { name: profile.fullName, "given-name": profile.firstName, "family-name": profile.lastName, email: profile.email, tel: profile.phone, "address-level2": profile.city || profile.location, "address-level1": profile.state, "postal-code": profile.postalCode, "country-name": profile.country };
  const autocompleteValue = autocompleteValues[String(field.autocomplete || "").toLowerCase()] || (type === "email" ? profile.email : type === "tel" ? profile.phone : "");
  if (autocompleteValue) return { status: "safe", value: autocompleteValue, reason: "Safe browser-standard profile field" };
  const adapterKey = globalThis.ClearLeadAdapters?.profileKeyFor?.(atsFamily, descriptor);
  if (adapterKey && profile[adapterKey]) return { status: "safe", value: profile[adapterKey], reason: `Recognized ${atsFamily} profile field` };
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
  return true;
}
function setNativeValue(field, value) {
  const ownSetter = Object.getOwnPropertyDescriptor(field, "value")?.set;
  const prototypeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  if (prototypeSetter && ownSetter !== prototypeSetter) prototypeSetter.call(field, value);
  else if (ownSetter) ownSetter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}
function decorate(field, status, reason) {
  const colors = { safe: "#49f29b", review: "#f4c95d", blocked: "#ff6b82", manual: "#55c7ff" };
  field.dataset.clearleadStatus = status;
  field.style.outline = `2px solid ${colors[status] || colors.review}`;
  field.style.outlineOffset = "2px";
  field.title = `ClearLead: ${reason}`;
}
