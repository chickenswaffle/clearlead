import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
const adapters = fs.readFileSync(path.join(root, "extension", "adapters.js"), "utf8");
const content = fs.readFileSync(path.join(root, "extension", "content.js"), "utf8");
const popup = fs.readFileSync(path.join(root, "extension", "popup.js"), "utf8");

test("extension is scoped to safe fill and contains no submission action", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "storage"]);
  assert.doesNotMatch(content, /\.click\s*\(|requestSubmit|\.submit\s*\(/);
  assert.doesNotMatch(popup, /\.click\s*\(|requestSubmit|\.submit\s*\(/);
  assert.match(content, /EEO|demographic/i);
  assert.match(content, /Existing value preserved/);
  assert.match(content, /does not exactly match the verified application page/);
  assert.match(content, /emergency\.\?contact/);
  assert.match(content, /Object\.getOwnPropertyDescriptor/);
  assert.doesNotMatch(content, /dispatchEvent\(new Event\(["']submit/);
  assert.deepEqual(manifest.content_scripts[0].js, ["adapters.js", "content.js"]);
  assert.doesNotMatch(adapters, /\.click\s*\(|requestSubmit|\.submit\s*\(/);
});

test("ATS registry detects the first supported application families", () => {
  const context = { URL };
  vm.runInNewContext(adapters, context);
  const detect = context.ClearLeadAdapters.detect;
  assert.equal(detect("https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/7").id, "workday");
  assert.equal(detect("https://boards.greenhouse.io/acme/jobs/7").id, "greenhouse");
  assert.equal(detect("https://jobs.lever.co/acme/7/apply").id, "lever");
  assert.equal(detect("https://jobs.ashbyhq.com/acme/7/application").id, "ashby");
  assert.equal(detect("https://jobs.smartrecruiters.com/Acme/7-role").id, "smartrecruiters");
  assert.equal(detect("https://careers.example.com/jobs/7").id, "generic");
  assert.equal(context.ClearLeadAdapters.supported.length, 5);
  assert.ok(context.ClearLeadAdapters.supported.every((item) => item.capabilities.finalSubmit === false));
  assert.equal(context.ClearLeadAdapters.profileKeyFor("workday", "legalNameSection_firstName"), "firstName");
  assert.equal(context.ClearLeadAdapters.profileKeyFor("greenhouse", "job_application_location"), "location");
  assert.equal(context.ClearLeadAdapters.profileKeyFor("lever", "urls[LinkedIn]"), "linkedinUrl");
  assert.equal(context.ClearLeadAdapters.profileKeyFor("ashby", "candidateName"), "fullName");
  assert.equal(context.ClearLeadAdapters.profileKeyFor("smartrecruiters", "phoneNumber"), "phone");
});

test("Greenhouse reader returns a compact application plan without field values", () => {
  const context = { URL };
  vm.runInNewContext(adapters, context);
  const field = (name, type = "text", required = false) => ({ name, id: "", type, required, disabled: false, autocomplete: "", getAttribute() { return ""; } });
  const fields = [field("job_application[first_name]", "text", true), field("job_application[email]", "email", true), field("resume", "file", true)];
  const submit = { textContent: "Submit Application", value: "", getAttribute() { return ""; } };
  const documentRef = {
    body: { innerText: "Apply for this role" },
    querySelector(selector) { return selector === "#application_form" ? this : null; },
    querySelectorAll(selector) {
      if (selector === "input:not([type='hidden']), select, textarea") return fields;
      if (selector === "button, input[type='submit']") return [submit];
      return [];
    },
  };
  const inspection = JSON.parse(JSON.stringify(context.ClearLeadAdapters.inspectPage(documentRef, "https://boards.greenhouse.io/acme/jobs/7")));
  assert.deepEqual(inspection, {
    atsFamily: "greenhouse", supported: true, phase: "application", fieldCount: 3, requiredCount: 3,
    emptyRequiredCount: 3, stepKey: "greenhouse:application", stepLabel: "Application",
    recognizedProfileFields: ["firstName", "email"], fileFieldCount: 1, submitControlCount: 1,
    nextControlCount: 0, canRunSafeFill: true, requiresManualResume: true, completionSignals: [],
  });
  assert.doesNotMatch(JSON.stringify(inspection), /field values|candidate@example/i);
});

test("Workday and SmartRecruiters readers identify multi-page steps without navigating", () => {
  const context = { URL };
  vm.runInNewContext(adapters, context);
  const field = (name, value = "") => ({ name, id: name, type: "text", value, required: true, disabled: false, autocomplete: "", getAttribute() { return ""; } });
  const applicationDocument = ({ rootSelector, stepSelector, stepLabel, fields, controls }) => {
    const root = { querySelectorAll(selector) { return selector.startsWith("input:not") ? fields : selector.startsWith("button") ? controls : []; } };
    return {
      body: { innerText: "Application" },
      querySelector(selector) {
        if (selector === rootSelector) return root;
        if (selector === stepSelector) return { textContent: stepLabel };
        return null;
      },
      querySelectorAll() { return []; },
    };
  };
  const next = { textContent: "Save and Continue", value: "", getAttribute() { return ""; } };
  const submit = { textContent: "Submit Application", value: "", getAttribute() { return ""; } };
  const workdayDocument = applicationDocument({ rootSelector: "[data-automation-id='applyFlowPage']", stepSelector: "[data-automation-id='stepTitle']", stepLabel: "My Information", fields: [field("legalNameSection_firstName", "Taylor"), field("emailAddress")], controls: [next] });
  const smartDocument = applicationDocument({ rootSelector: "[data-test='application-form']", stepSelector: "[data-test='step-title']", stepLabel: "Review", fields: [field("firstName", "Taylor"), field("email", "taylor@example.com")], controls: [submit] });
  const workday = context.ClearLeadAdapters.inspectPage(workdayDocument, "https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/Role/R-12345/apply?step=1");
  const smart = context.ClearLeadAdapters.inspectPage(smartDocument, "https://jobs.smartrecruiters.com/Acme/744000123456-role/application");
  assert.equal(workday.stepKey, "workday:my-information");
  assert.equal(workday.nextControlCount, 1);
  assert.equal(workday.submitControlCount, 0);
  assert.equal(workday.emptyRequiredCount, 1);
  assert.equal(smart.stepKey, "smartrecruiters:review");
  assert.equal(smart.nextControlCount, 0);
  assert.equal(smart.submitControlCount, 1);
  assert.equal(smart.emptyRequiredCount, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(context.ClearLeadAdapters.applicationFields(workdayDocument, "https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/Role/R-12345/apply"))).map((item) => item.name), ["legalNameSection_firstName", "emailAddress"]);
});

test("multi-page scope follows only job-bound ATS and generic form transitions", () => {
  const context = { chrome: { runtime: { onMessage: { addListener() {} } } }, URL };
  vm.runInNewContext(`${content}\n;globalThis.__allowed = allowedApplicationPage;`, context);
  const workday = { allowedPages: ["https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/Role/R-12345"], navigation: { multiPage: true, origin: "https://acme.wd5.myworkdayjobs.com", pathPrefix: "/en-US/jobs/job/Role/R-12345", jobTokens: ["r-12345"], allowedHostSuffix: "myworkdayjobs.com" } };
  assert.equal(context.__allowed(workday, "https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/Role/R-12345/apply?step=2"), true);
  assert.equal(context.__allowed(workday, "https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/Other/R-99999/apply"), false);
  assert.equal(context.__allowed(workday, "https://evil.example/en-US/jobs/job/Role/R-12345/apply"), false);
  const smart = { allowedPages: [], navigation: { multiPage: true, origin: "https://jobs.smartrecruiters.com", pathPrefix: "/Acme/744000123456-role", jobTokens: ["744000123456-role"], allowedHostSuffix: "smartrecruiters.com" } };
  assert.equal(context.__allowed(smart, "https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/744000123456-role?step=2"), true);
  const greenhouse = { allowedPages: [], navigation: { multiPage: true, origin: "https://boards.greenhouse.io", pathPrefix: "/acme/jobs/123456", jobTokens: ["123456"], allowedHostSuffix: "greenhouse.io" } };
  assert.equal(context.__allowed(greenhouse, "https://job-boards.greenhouse.io/acme/jobs/123456/application"), true);
  assert.equal(context.__allowed(greenhouse, "https://job-boards.greenhouse.io/acme/jobs/999999/application"), false);
  const lever = { allowedPages: [], navigation: { multiPage: true, origin: "https://jobs.lever.co", pathPrefix: "/acme/role-123456", jobTokens: ["role-123456"], allowedHostSuffix: "lever.co" } };
  assert.equal(context.__allowed(lever, "https://jobs.lever.co/acme/role-123456/apply"), true);
  const ashby = { allowedPages: [], navigation: { multiPage: true, origin: "https://jobs.ashbyhq.com", pathPrefix: "/acme/role-123456", jobTokens: ["role-123456"], allowedHostSuffix: "ashbyhq.com" } };
  assert.equal(context.__allowed(ashby, "https://jobs.ashbyhq.com/acme/role-123456/application"), true);
  const generic = { allowedPages: [], navigation: { multiPage: true, origin: "https://apply.example.com", pathPrefix: "/form/step-one", jobTokens: ["job=7"], allowedHostSuffix: "" } };
  assert.equal(context.__allowed(generic, "https://apply.example.com/form/step-two?job=7"), true);
  assert.equal(context.__allowed(generic, "https://apply.example.com/form/step-two?job=8"), false);
  assert.equal(context.__allowed(generic, "https://evil.example/form/step-two?job=7"), false);
});

test("Lever and Ashby readers distinguish postings from application forms", () => {
  const context = { URL };
  vm.runInNewContext(adapters, context);
  const field = (name) => ({ name, id: "", type: "text", required: true, disabled: false, autocomplete: "", getAttribute() { return ""; } });
  const applicationDocument = (rootSelector, names) => {
    const fields = names.map(field);
    const root = { querySelectorAll(selector) { return selector.startsWith("input:not") ? fields : []; } };
    return { body: { innerText: "Application" }, querySelector: (selector) => selector === rootSelector ? root : null, querySelectorAll: () => [] };
  };
  const lever = context.ClearLeadAdapters.inspectPage(applicationDocument(".application-form", ["name", "email", "urls[LinkedIn]"]), "https://jobs.lever.co/acme/7/apply");
  const ashby = context.ClearLeadAdapters.inspectPage(applicationDocument("[data-testid='application-form']", ["candidateName", "email", "location"]), "https://jobs.ashbyhq.com/acme/7/application");
  const posting = context.ClearLeadAdapters.inspectPage({ body: { innerText: "Job description" }, querySelector: () => null, querySelectorAll: () => [field("search")] }, "https://jobs.lever.co/acme/7");
  assert.equal(lever.phase, "application");
  assert.deepEqual(JSON.parse(JSON.stringify(lever.recognizedProfileFields)), ["fullName", "email", "linkedinUrl"]);
  assert.equal(ashby.phase, "application");
  assert.deepEqual(JSON.parse(JSON.stringify(ashby.recognizedProfileFields)), ["fullName", "email", "location"]);
  assert.equal(posting.phase, "posting");
  assert.equal(posting.fieldCount, 0);
});

test("extension only fetches the paired localhost pack", () => {
  assert.match(popup, /http:\/\/127\.0\.0\.1:4173/);
  assert.match(popup, /authorization: `Bearer/);
  assert.match(manifest.host_permissions.join(" "), /127\.0\.0\.1:4173/);
  assert.match(popup, /\/api\/extension\/transition/);
  assert.match(popup, /window\.confirm/);
  assert.match(content, /identityText/);
  assert.match(popup, /\/api\/extension\/verify/);
  assert.match(popup, /\/api\/extension\/run/);
  assert.match(popup, /make the final Submit click yourself/);
  assert.match(popup, /Open the HTTPS employer job page — not ClearLead/);
  assert.match(content, /CLEARLEAD_CAPTURE_VERIFICATION/);
  assert.doesNotMatch(content, /document\.cookie|localStorage|sessionStorage/);
});

test("browser capture refuses to treat the ClearLead tab as a job page", () => {
  const context = {
    chrome: { runtime: { onMessage: { addListener() {} } } },
    ClearLeadAdapters: { detect: () => ({ id: "generic" }) },
    location: { href: "http://127.0.0.1:4173/" },
    URL,
    document: { title: "ClearLead", body: { innerText: "Job description Responsibilities" }, querySelectorAll: () => [] },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    performance: { getEntriesByType: () => [{ responseStatus: 200 }] },
  };
  vm.runInNewContext(`${content}\n;globalThis.__capture = captureVerificationEvidence;`, context);
  assert.throws(() => context.__capture(), /not ClearLead/i);
});

test("browser capture returns compact rendered evidence without page text", () => {
  const apply = {
    disabled: false, tagName: "A", textContent: "I'm interested", value: "",
    getAttribute(name) { return name === "href" ? "/apply" : ""; },
    getBoundingClientRect() { return { width: 120, height: 32 }; },
  };
  const schema = { textContent: '{"@type":"JobPosting"}' };
  const context = {
    chrome: { runtime: { onMessage: { addListener() {} } } },
    ClearLeadAdapters: { detect: () => ({ id: "lever" }) },
    location: { href: "https://jobs.example.com/roles/7#apply" },
    URL,
    document: {
      title: "IT Support Technician",
      body: { innerText: "Job description. Responsibilities. Qualifications. Private candidate text must not leave this page." },
      querySelectorAll(selector) {
        if (selector === "a, button, input[type='submit'], input[type='button']") return [apply];
        if (selector === "script[type='application/ld+json']") return [schema];
        return [];
      },
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    performance: { getEntriesByType: () => [{ responseStatus: 200 }] },
  };
  vm.runInNewContext(`${content}\n;globalThis.__capture = captureVerificationEvidence;`, context);
  const evidence = JSON.parse(JSON.stringify(context.__capture()));
  assert.deepEqual(evidence, {
    pageUrl: "https://jobs.example.com/roles/7",
    pageTitle: "IT Support Technician",
    httpStatus: 200,
    atsFamily: "lever",
    signals: ["apply action", "job description", "responsibilities", "qualifications", "job schema"],
  });
  assert.doesNotMatch(JSON.stringify(evidence), /Private candidate text/);
});

test("field policy fails closed on third-party contacts and preserves meaningful selects", () => {
  const context = { chrome: { runtime: { onMessage: { addListener() {} } } } };
  vm.runInNewContext(`${content}\n;globalThis.__policy = { classify, hasValue };`, context);
  const profile = { firstName: "Taylor", email: "taylor@example.com", phone: "555-1234" };
  const field = (type = "text", tagName = "INPUT") => ({ type, tagName, autocomplete: "" });
  assert.equal(context.__policy.classify(field("email"), "Reference email", profile).status, "blocked");
  assert.equal(context.__policy.classify(field(), "Emergency contact first name", profile).status, "blocked");
  assert.equal(context.__policy.classify(field("tel"), "Manager phone", profile).status, "blocked");
  assert.equal(context.__policy.classify(field("email"), "Employee referral email", profile).status, "blocked");
  assert.equal(context.__policy.classify(field(), "Spouse first name", profile).status, "blocked");
  assert.equal(context.__policy.hasValue({ tagName: "SELECT", selectedIndex: 0, value: "yes" }), true);
});

test("runtime safe-fill changes only fields and never activates a submission path", () => {
  const calls = { submit: 0, requestSubmit: 0, click: 0, fetch: 0, submitEvent: 0, fieldEvents: [] };
  const form = { submit() { calls.submit += 1; }, requestSubmit() { calls.requestSubmit += 1; }, addEventListener(type) { if (type === "submit") calls.submitEvent += 1; } };
  const button = { click() { calls.click += 1; } };
  const field = {
    id: "candidate-email", name: "email", type: "email", tagName: "INPUT", autocomplete: "email", disabled: false,
    value: "", dataset: {}, style: {}, form,
    getBoundingClientRect() { return { width: 200, height: 32 }; },
    getAttribute(name) { return name === "name" ? this.name : ""; },
    closest() { return null; },
    dispatchEvent(event) { calls.fieldEvents.push(event.type); if (event.type === "submit") calls.submit += 1; return true; },
  };
  const context = {
    chrome: { runtime: { onMessage: { addListener() {} } } },
    ClearLeadAdapters: {
      detect: () => ({ id: "greenhouse" }),
      inspectPage: () => ({ atsFamily: "greenhouse", phase: "application", canRunSafeFill: true }),
      profileKeyFor: () => "email",
    },
    location: { href: "https://apply.example.com/form?job=7", origin: "https://apply.example.com", pathname: "/form", search: "?job=7" },
    URL,
    document: { querySelectorAll(selector) { return selector.startsWith("label[") ? [] : [field]; } },
    CSS: { escape: (value) => value },
    Event: class { constructor(type) { this.type = type; } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    fetch: async () => { calls.fetch += 1; },
    button,
  };
  vm.runInNewContext(`${content}\n;globalThis.__fill = fillSafeFields;`, context);
  const report = context.__fill({ allowedPages: ["https://apply.example.com/form?job=7"], profile: { email: "taylor@example.com" }, truth: { fingerprint: "abc123" } });
  assert.equal(report.filled, 1);
  assert.equal(report.atsFamily, "greenhouse");
  assert.equal(report.truthFingerprint, "abc123");
  assert.equal(field.value, "taylor@example.com");
  assert.deepEqual(calls.fieldEvents, ["input", "change"]);
  assert.deepEqual({ submit: calls.submit, requestSubmit: calls.requestSubmit, click: calls.click, fetch: calls.fetch, submitEvent: calls.submitEvent }, { submit: 0, requestSubmit: 0, click: 0, fetch: 0, submitEvent: 0 });
});
