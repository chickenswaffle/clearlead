import PDFDocument from "pdfkit";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGE = { top: 46, bottom: 48, left: 54, right: 54 };
const SECTION_PATTERN = /^(summary|profile|professional summary|experience|work experience|employment|education|skills|technical skills|certifications|projects|selected projects|awards|volunteer experience)$/i;
const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontFile = (...parts) => path.join(moduleRoot, "node_modules", "@fontsource", ...parts);
const FONT_FAMILIES = {
  latin: [
    path.join(moduleRoot, "node_modules", "@expo-google-fonts", "noto-sans", "400Regular", "NotoSans_400Regular.ttf"),
    path.join(moduleRoot, "node_modules", "@expo-google-fonts", "noto-sans", "700Bold", "NotoSans_700Bold.ttf"),
  ],
  arabic: [
    path.join(moduleRoot, "node_modules", "@expo-google-fonts", "noto-sans-arabic", "400Regular", "NotoSansArabic_400Regular.ttf"),
    path.join(moduleRoot, "node_modules", "@expo-google-fonts", "noto-sans-arabic", "700Bold", "NotoSansArabic_700Bold.ttf"),
  ],
  cjk: [fontFile("noto-sans-sc", "files", "noto-sans-sc-chinese-simplified-400-normal.woff"), fontFile("noto-sans-sc", "files", "noto-sans-sc-chinese-simplified-700-normal.woff")],
};

export function createResumePdf(markdown, { title = "Tailored resume", author = "" } = {}) {
  const source = String(markdown || "").replace(/\r\n?/g, "\n").trim();
  if (source.length < 120) throw new Error("The tailored resume is too short to export as a PDF.");
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "LETTER",
      margins: PAGE,
      bufferPages: true,
      info: { Title: cleanText(title), Author: cleanText(author), Creator: "ClearLead Resume Studio" },
    });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));
    for (const [family, files] of Object.entries(FONT_FAMILIES)) {
      document.registerFont(fontName(family, false), files[0]);
      document.registerFont(fontName(family, true), files[1]);
    }

    renderResume(document, source);
    addPageNumbers(document);
    document.end();
  });
}

function renderResume(document, source) {
  const lines = source.split("\n");
  const firstContent = lines.findIndex((line) => line.trim());
  let paragraph = [];
  let renderedName = false;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    ensureSpace(document, 28);
    document.fontSize(8.6).fillColor("#26333a");
    writeUnicodeText(document, cleanText(paragraph.join(" ")), false, {
      lineGap: 0.9,
      align: "left",
    });
    document.moveDown(0.28);
    paragraph = [];
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      return;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^[-*+•]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    const sectionLike = !heading && SECTION_PATTERN.test(line.replace(/:$/, ""));
    const likelyName = index === firstContent && !heading && !bullet && !sectionLike && line.length <= 72;

    if (heading || sectionLike || likelyName) {
      flushParagraph();
      const level = likelyName ? 1 : heading ? heading[1].length : 2;
      const text = cleanText(likelyName ? line : heading ? heading[2] : line.replace(/:$/, ""));
      if (level === 1 && !renderedName) {
        ensureSpace(document, 52);
        document.fontSize(20).fillColor("#101820");
        writeUnicodeText(document, text, true, { characterSpacing: 0.15 });
        document.moveDown(0.2);
        document.strokeColor("#15a46d").lineWidth(2).moveTo(PAGE.left, document.y).lineTo(558, document.y).stroke();
        document.moveDown(0.48);
        renderedName = true;
      } else {
        ensureSpace(document, 42);
        document.moveDown(0.14);
        document.fontSize(level === 2 ? 10.2 : 9.4).fillColor("#087b55");
        writeUnicodeText(document, text.toUpperCase(), true, { characterSpacing: 0.7, lineGap: 1 });
        document.strokeColor("#dce7e2").lineWidth(0.55).moveTo(PAGE.left, document.y + 2).lineTo(558, document.y + 2).stroke();
        document.moveDown(0.3);
      }
      return;
    }
    if (bullet || numbered) {
      flushParagraph();
      ensureSpace(document, 25);
      const text = cleanText((bullet || numbered)[1]);
      const y = document.y;
      document.font(fontName("latin", true)).fontSize(9).fillColor("#15a46d").text("-", PAGE.left + 2, y, { width: 10, lineBreak: false });
      document.fontSize(8.5).fillColor("#26333a");
      writeUnicodeText(document, text, false, {
        width: 489,
        lineGap: 0.75,
      }, PAGE.left + 15, y);
      document.moveDown(0.06);
      return;
    }
    if (!renderedName && index === firstContent) {
      renderedName = true;
    }
    paragraph.push(line.replace(/^---+$/, ""));
  });
  flushParagraph();
}

function ensureSpace(document, points) {
  if (document.y + points > document.page.height - PAGE.bottom - 14) document.addPage();
}

function addPageNumbers(document) {
  const range = document.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);
    const bottomMargin = document.page.margins.bottom;
    document.page.margins.bottom = 0;
    document.font(fontName("latin", false)).fontSize(7.5).fillColor("#81918a")
      .text(`CLEARLEAD  /  ${index + 1} OF ${range.count}`, PAGE.left, 760, { width: 504, align: "right", lineBreak: false, characterSpacing: 0.65 });
    document.page.margins.bottom = bottomMargin;
  }
}

function cleanText(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/\u2022/g, " | ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function writeUnicodeText(document, value, bold, options = {}, x, y) {
  const runs = unicodeRuns(value);
  runs.forEach((run, index) => {
    document.font(fontName(run.family, bold));
    const runOptions = { features: { liga: false, clig: false }, ...options, continued: index < runs.length - 1 };
    if (index === 0 && Number.isFinite(x) && Number.isFinite(y)) document.text(run.text, x, y, runOptions);
    else document.text(run.text, runOptions);
  });
}

function unicodeRuns(value) {
  const runs = [];
  let previousFamily = "latin";
  for (const character of String(value || "")) {
    let family = /\p{Script=Han}/u.test(character) ? "cjk" : /\p{Script=Arabic}/u.test(character) ? "arabic" : "latin";
    if (/^[\p{Mark}\p{Punctuation}\p{Separator}\p{Number}\p{Symbol}]$/u.test(character)) family = previousFamily;
    const last = runs.at(-1);
    if (last?.family === family) last.text += character;
    else runs.push({ family, text: character });
    if (!/^[\p{Mark}\p{Punctuation}\p{Separator}\p{Number}\p{Symbol}]$/u.test(character)) previousFamily = family;
  }
  return runs.length ? runs : [{ family: "latin", text: "" }];
}

function fontName(family, bold) {
  return `Resume-${family}-${bold ? "Bold" : "Regular"}`;
}
