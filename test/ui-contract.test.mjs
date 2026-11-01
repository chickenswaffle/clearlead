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
  assert.ok(html.indexOf('id="search"') < html.indexOf('id="verify-panel"'), "ranked search must be the primary workflow and pasted URLs the fallback");
  assert.ok(html.indexOf('id="search"') < html.indexOf('id="ai-setup"'), "optional AI setup must not interrupt the resume-to-search path");
  assert.match(html, /id="tailor-output"/);
  assert.match(html, /OpenRouter/);
  assert.match(html, /application\/pdf/);
  assert.match(script, /\/api\/resume\/pdf/);
  assert.match(html, /id="smart-search"/);
  assert.match(html, /id="hero-primary"/);
  assert.match(html, /id="journey-resume"/);
  assert.match(html, /id="journey-apply"/);
  assert.match(script, /function updateJourney/);
  assert.match(script, /Continue my application/);
  assert.match(script, /slice\(0, 6\)/);
  assert.match(script, /show-more-jobs/);
  assert.match(html, /id="resume-toggle"/);
  assert.match(html, /id="use-ai-search"/);
  const aiSearchInput = html.match(/<input[^>]*id="use-ai-search"[^>]*>/)?.[0] || "";
  assert.doesNotMatch(aiSearchInput, /\schecked(?:\s|>|=)/, "AI search must require an explicit user opt-in");
  assert.match(html, /Entry level tech jobs in DFW/);
  assert.match(script, /\/api\/search\/smart/);
  assert.match(script, /Make custom resume/);
  assert.match(script, /resume studio \/ grounded/i);
  assert.match(script, /Download polished PDF/);
  assert.match(script, /Download ATS-safe DOCX/);
  assert.match(script, /Save as my default/);
  assert.match(script, /Use for this application/);
  assert.match(script, /Use this AI version/);
  assert.match(script, /kitId: kit\.id/);
  assert.match(script, /never emails an employer or clicks Submit/i);
  assert.match(script, /\/api\/tailored\/\$\{encodeURIComponent\(draft\.id\)\}\/default/);
  assert.match(script, /Read job description/);
  assert.match(html, /id="pair-extension"/);
  assert.match(html, /id="test-extension"/);
  assert.match(html, /id="unpair-extension"/);
  assert.match(html, /id="full-name"/);
  assert.match(script, /Save verified lead/);
  assert.match(script, /data-save=/);
  assert.match(script, /verification-evidence/);
  assert.match(script, /checkedAt/);
  assert.match(script, /httpStatus/);
  assert.match(script, /finalUrl/);
  assert.match(script, /verificationMethod/);
  assert.match(script, /trustedJobMetadata !== false/);
  assert.match(script, /\/api\/browser-verification/);
  assert.match(script, /\^https:\\\/\\\//);
  assert.match(html, /id="extension-setup"/);
  assert.match(script, /Browser handoff/);
  assert.match(script, /if the posting renders normally, continue immediately/i);
  assert.match(script, /Extension connected — browser check ready/);
  assert.match(script, /Open source in browser/);
  assert.match(script, /function extensionReady/);
  assert.match(script, /Open for browser check/);
  assert.match(script, /Verify current job page/);
  assert.match(script, /Connection confirmed live/);
  assert.match(script, /Replace pairing token/);
  assert.match(script, /\/api\/extension\/unpair/);
  assert.match(script, /showSearchConfig[\s\S]*smart-search/);
  assert.match(script, /let verifying = false/);
  assert.match(script, /removeAttribute\('data-verify-url'\)/);
  assert.match(script, /Prepare application/);
  assert.match(html, /Verify top matches/);
  assert.match(script, /Tailoring is available for roles found through ranked search/);
});

test("unfinished application runs expose an actionable restart-safe resume path", () => {
  assert.match(script, /showRecoverableApplication/);
  assert.match(script, /Revalidate and resume/);
  assert.match(script, /\/api\/application\/runs\/\$\{encodeURIComponent\(runId\)\}\/resume/);
  assert.match(html, /Prepared — not submitted/);
  assert.match(html, /id="prepared-applications"/);
  assert.match(script, /function renderPreparedApplications/);
  assert.match(script, /No employer confirmation/);
  assert.match(script, /Continue application/);
});

test("Applied is a local outcome workflow with explicit guarded learning", () => {
  assert.match(html, /href="#applied"/);
  assert.match(html, /id="applications"/);
  assert.match(html, /id="outcome-learning-toggle"/);
  assert.match(html, /local-only learning/i);
  assert.match(script, /function renderApplications/);
  assert.match(script, /No response as of today/);
  assert.match(script, /Furthest stage reached/);
  assert.match(script, /View custom resume/);
  assert.match(script, /Download PDF/);
  assert.match(script, /Download DOCX/);
  assert.match(script, /function applicationResumeActions/);
  assert.match(html, /One rejection will never rewrite your ranking/);
  assert.match(script, /escape\(event\.note\)/, "private notes must be rendered as escaped text");
  assert.match(script, /\/api\/applications\/\$\{encodeURIComponent\(id\)\}\/outcome/);
});
