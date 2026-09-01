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
