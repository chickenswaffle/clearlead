import test from "node:test";
import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createResumePdf } from "../src/resume-pdf.mjs";

const resume = `# Taylor Example

taylor@example.com | Cedar Hill, TX | linkedin.com/in/taylor

## Summary

Technical support professional experienced in troubleshooting production systems and helping end users.

## Experience

- Resolved hardware, software, and account issues for customers across Windows environments.
- Documented repeatable fixes and escalated complex incidents with complete diagnostic notes.
- Improved support response quality by building a searchable internal knowledge base.

## Skills

- Windows, Microsoft 365, Active Directory, ticketing systems, remote support`;

test("resume PDF is valid, selectable, and contains the employer-ready resume", async () => {
  const pdf = await createResumePdf(resume, { title: "Technical Support Analyst resume", author: "Taylor Example" });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const document = await getDocument({ data: new Uint8Array(pdf), disableWorker: true, useSystemFonts: true }).promise;
  assert.equal(document.numPages, 1);
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str).join(" ");
  assert.match(text, /Taylor Example/);
  assert.match(text, /Technical support professional/);
  assert.match(text, /Active Directory/);
  assert.doesNotMatch(text, /Grounding report|Verified source/);
});

test("resume PDF preserves international names instead of dropping Unicode characters", async () => {
  const international = resume.replace("Taylor Example", "Łukasz Nguyễn").replace("Cedar Hill", "Montréal");
  const pdf = await createResumePdf(international, { title: "Résumé", author: "Łukasz Nguyễn" });
  const document = await getDocument({ data: new Uint8Array(pdf), disableWorker: true, useSystemFonts: true }).promise;
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str).join(" ");
  assert.match(text, /Łukasz Nguyễn/);
  assert.match(text, /Montréal/);
});

test("bundled PDF fonts render CJK, Arabic, and Devanagari names without system fonts", async () => {
  const international = resume.replace("Taylor Example", "王小明").replace("Cedar Hill, TX", "أحمد علي | अनन्या शर्मा");
  const pdf = await createResumePdf(international, { title: "International resume", author: "王小明" });
  const document = await getDocument({ data: new Uint8Array(pdf), disableWorker: true, useSystemFonts: false }).promise;
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str).join(" ");
  assert.match(text, /王小明/);
  assert.ok((text.match(/\p{Script=Arabic}/gu) || []).length >= 7);
  assert.ok((text.match(/\p{Script=Devanagari}/gu) || []).length >= 6);
  assert.doesNotMatch(text, /\uFFFD/);
});

test("PDF text does not visually split common fi words", async () => {
  const ligatureWords = resume.replace("Technical support professional", "Configure certified workflows and Insurance Verification as a unified professional");
  const pdf = await createResumePdf(ligatureWords);
  const document = await getDocument({ data: new Uint8Array(pdf), disableWorker: true, useSystemFonts: false }).promise;
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str).join(" ");
  assert.match(text, /Configure certified workflows and Insurance Verification as a unified professional/);
  assert.doesNotMatch(text, /fi\s+(?:gure|ed|cation)/i);
});

test("long resume PDFs keep real content on the final page", async () => {
  const bullets = Array.from({ length: 90 }, (_, index) => `- Evidence line ${index + 1}: supported customers and documented reliable technical resolutions.`).join("\n");
  const pdf = await createResumePdf(`# Long Resume\n\n## Experience\n${bullets}`, { title: "Long resume" });
  const document = await getDocument({ data: new Uint8Array(pdf), disableWorker: true, useSystemFonts: true }).promise;
  assert.ok(document.numPages > 1);
  const lastPage = await document.getPage(document.numPages);
  const content = await lastPage.getTextContent();
  const text = content.items.map((item) => item.str).join(" ");
  assert.match(text, /Evidence line 90/);
});
