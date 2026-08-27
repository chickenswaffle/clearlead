import test from "node:test";
import assert from "node:assert/strict";
import { extractResumePdf } from "../src/pdf-resume.mjs";

test("PDF resume extraction reads selectable text without persisting an artifact", async () => {
  const pdf = simplePdf([
    "Taylor Example",
    "Platform engineer building reliable cloud services and distributed production systems.",
    "Built Python services on Kubernetes and improved deployment reliability across product teams.",
    "Skills include Python, Kubernetes, observability, system design, and technical leadership.",
  ]);
  const result = await extractResumePdf(pdf);
  assert.equal(result.pageCount, 1);
  assert.ok(result.wordCount >= 20);
  assert.match(result.text, /Taylor Example/);
  assert.match(result.text, /Python services on Kubernetes/);
});

test("PDF resume extraction rejects disguised files and image-only content", async () => {
  await assert.rejects(() => extractResumePdf(Buffer.from("not a pdf")), /not a valid PDF/);
  await assert.rejects(() => extractResumePdf(simplePdf([])), /little or no selectable text/);
});

test("PDF resume extraction enforces worker budgets and a hard timeout", async () => {
  const pdf = simplePdf(["Taylor Example has enough selectable resume text for the parser to inspect safely."]);
  await assert.rejects(() => extractResumePdf(pdf, { maxItems: 0 }), /safe extraction limit/);
  await assert.rejects(() => extractResumePdf(pdf, { timeoutMs: 1 }), /took too long/);
});

function simplePdf(lines) {
  const content = ["BT", "/F1 12 Tf", "72 720 Td", ...lines.flatMap((line, index) => [index ? "0 -20 Td" : "", `(${escapePdf(line)}) Tj`]).filter(Boolean), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

function escapePdf(value) { return value.replace(/([\\()])/g, "\\$1"); }
