import test from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { createResumeDocx, docxMimeType } from "../src/resume-docx.mjs";

test("resume DOCX is a valid, single-column, ATS-readable Word package", () => {
  const document = createResumeDocx(`# Taylor Example

## Experience
- Improved deployment reliability by 30% across product teams.
- Built Python services on Kubernetes.

## Skills
Python, Kubernetes & Linux`, { title: "Platform resume", author: "Taylor Example" });
  assert.equal(document.subarray(0, 2).toString(), "PK");
  assert.equal(docxMimeType(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const files = unzipSync(document);
  for (const required of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml"]) assert.ok(files[required]);
  const body = strFromU8(files["word/document.xml"]);
  assert.match(body, /Taylor Example/);
  assert.match(body, /Improved deployment reliability by 30%/);
  assert.match(body, /Python, Kubernetes &amp; Linux/);
  assert.doesNotMatch(body, /w:tbl|w:txbxContent|w:headerReference|w:footerReference/);
});
