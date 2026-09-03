import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
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
  assert.doesNotMatch(content, /dispatchEvent/);
});

test("extension only fetches the paired localhost pack", () => {
  assert.match(popup, /http:\/\/127\.0\.0\.1:4173/);
  assert.match(popup, /authorization: `Bearer/);
  assert.match(manifest.host_permissions.join(" "), /127\.0\.0\.1:4173/);
  assert.match(popup, /\/api\/extension\/verify/);
  assert.match(popup, /Open the HTTPS employer job page — not ClearLead/);
  assert.match(content, /CLEARLEAD_CAPTURE_VERIFICATION/);
  assert.doesNotMatch(content, /document\.cookie|localStorage|sessionStorage/);
});

test("browser capture refuses to treat the ClearLead tab as a job page", () => {
  const context = {
    chrome: { runtime: { onMessage: { addListener() {} } } },
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
    dispatchEvent(event) { calls.fieldEvents.push(event.type); calls.submit += 1; return true; },
  };
  const context = {
    chrome: { runtime: { onMessage: { addListener() {} } } },
    location: { origin: "https://apply.example.com", pathname: "/form", search: "?job=7" },
    document: { querySelectorAll(selector) { return selector.startsWith("label[") ? [] : [field]; } },
    CSS: { escape: (value) => value },
    Event: class { constructor(type) { this.type = type; } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    fetch: async () => { calls.fetch += 1; },
    button,
  };
  vm.runInNewContext(`${content}\n;globalThis.__fill = fillSafeFields;`, context);
  const report = context.__fill({ allowedPages: ["https://apply.example.com/form?job=7"], profile: { email: "taylor@example.com" } });
  assert.equal(report.filled, 1);
  assert.equal(field.value, "taylor@example.com");
  assert.deepEqual(calls.fieldEvents, []);
  assert.deepEqual({ submit: calls.submit, requestSubmit: calls.requestSubmit, click: calls.click, fetch: calls.fetch, submitEvent: calls.submitEvent }, { submit: 0, requestSubmit: 0, click: 0, fetch: 0, submitEvent: 0 });
});
