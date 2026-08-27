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
