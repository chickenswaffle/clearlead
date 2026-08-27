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

test("resume onboarding leads to one plain-English search and a simple review-resume-apply flow", () => {
  assert.ok(html.indexOf('id="resume"') < html.indexOf('id="search"'));
  assert.ok(html.indexOf('id="ai-setup"') < html.indexOf('id="search"'));
  assert.match(html, /id="tailor-output"/);
  assert.match(html, /OpenRouter/);
  assert.match(html, /application\/pdf/);
  assert.match(script, /\/api\/resume\/pdf/);
  assert.match(html, /id="smart-search"/);
  assert.match(html, /id="use-ai-search"/);
  const aiSearchInput = html.match(/<input[^>]*id="use-ai-search"[^>]*>/)?.[0] || "";
  assert.doesNotMatch(aiSearchInput, /\schecked(?:\s|>|=)/, "AI search must require an explicit user opt-in");
  assert.match(html, /Entry level tech jobs in DFW/);
  assert.match(script, /\/api\/search\/smart/);
  assert.match(script, /Make custom resume/);
  assert.match(script, /Read job description/);
  assert.match(html, /id="pair-extension"/);
  assert.match(html, /id="full-name"/);
  assert.match(script, />Apply</);
  assert.match(html, /Verify top matches/);
  assert.match(script, /Tailoring is available for roles found through ranked search/);
});
