import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

test("UI script selectors resolve to unique HTML ids", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML contains duplicate ids");
  const selectors = [...script.matchAll(/querySelector\(['"]#([a-z0-9-]+)['"]\)/gi)].map((match) => match[1]);
  for (const selector of new Set(selectors)) {
    assert.ok(ids.includes(selector) || script.includes(`id=\"${selector}\"`), `Missing static or rendered #${selector}`);
  }
});

test("resume onboarding appears before search and tailoring has an output surface", () => {
  assert.ok(html.indexOf('id="resume"') < html.indexOf('id="search"'));
  assert.match(html, /id="tailor-output"/);
  assert.match(html, /Automatically verify top matches/);
  assert.match(script, /Tailoring is available for roles found through ranked search/);
});
