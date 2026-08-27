import { parentPort, workerData } from "node:worker_threads";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

let document;
let loadingTask;
try {
  const { data, maxPages, maxItems, maxCharacters } = workerData;
  loadingTask = getDocument({ data: new Uint8Array(data), useSystemFonts: true, isEvalSupported: false });
  document = await loadingTask.promise;
  if (document.numPages > maxPages) throw new Error(`Resume PDF has ${document.numPages} pages. Use a resume with ${maxPages} pages or fewer.`);
  const pages = [];
  const budget = { items: 0, characters: 0, maxItems, maxCharacters };
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent({ includeMarkedContent: false });
    pages.push(pageText(content.items, budget));
    page.cleanup();
  }
  const text = pages.filter(Boolean).join("\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const wordCount = text.match(/\S+/g)?.length || 0;
  if (wordCount < 8) throw new Error("This PDF has little or no selectable text. If it is a scan, export it with OCR or paste the resume text instead.");
  const warnings = [];
  if (text.length < 120 || wordCount < 20) warnings.push("The extracted text looks incomplete. Review it carefully or paste the resume manually.");
  parentPort.postMessage({ ok: true, result: { text, pageCount: document.numPages, wordCount, warnings } });
} catch (error) {
  let message = error?.message || "";
  if (error?.name === "PasswordException") message = "This PDF is password-protected. Export an unlocked copy and try again.";
  if (!/Resume PDF|selectable text|password-protected|safe extraction limit/.test(message)) message = "ClearLead could not read this PDF. Export a standard text-based PDF or paste the resume text instead.";
  parentPort.postMessage({ ok: false, error: message });
} finally {
  try { document?.cleanup(); } catch {}
  await loadingTask?.destroy().catch(() => {});
}

function pageText(items, budget) {
  const lines = [];
  let current = [];
  let previousY = null;
  const flush = () => {
    const line = current.join(" ").replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
    current = [];
  };
  for (const item of items) {
    budget.items += 1;
    if (budget.items > budget.maxItems) throw new Error("Resume PDF exceeded the safe extraction limit. Export a simpler PDF or paste the resume text instead.");
    if (!item || typeof item.str !== "string") continue;
    const value = item.str.trim();
    budget.characters += value.length;
    if (budget.characters > budget.maxCharacters) throw new Error("Resume PDF exceeded the safe extraction limit. Export a simpler PDF or paste the resume text instead.");
    const y = Number(item.transform?.[5]);
    if (current.length && Number.isFinite(y) && Number.isFinite(previousY) && Math.abs(y - previousY) > 2.5) flush();
    if (value) current.push(value);
    if (Number.isFinite(y)) previousY = y;
    if (item.hasEOL) flush();
  }
  flush();
  return lines.join("\n");
}
