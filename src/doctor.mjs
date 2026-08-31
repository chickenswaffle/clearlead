import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runtimeReadiness({ rootDir = root, nodeVersion = process.versions.node } = {}) {
  const issues = [];
  if (!supportedNode(nodeVersion)) {
    issues.push({
      id: "node-version",
      feature: "local service",
      blocking: true,
      message: `Node.js ${nodeVersion || "unknown"} is unsupported. ClearLead requires Node.js 22.13+ or 24+.`,
      repair: "nvm install 24 && nvm use 24",
    });
  }
  const pdfModule = path.join(rootDir, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs");
  if (!fs.existsSync(pdfModule)) {
    issues.push({
      id: "pdf-dependency",
      feature: "PDF resume upload",
      blocking: false,
      message: "PDF resume upload is unavailable because pdfjs-dist is not installed. Paste or load a text resume in the meantime.",
      repair: "npm ci",
    });
  }
  return {
    ready: issues.length === 0,
    coreReady: !issues.some((issue) => issue.blocking),
    nodeVersion,
    issues,
  };
}

export function formatReadiness(readiness) {
  if (readiness.ready) return "ClearLead runtime ready.";
  return readiness.issues.map((issue) => `${issue.blocking ? "BLOCKED" : "OPTIONAL"}: ${issue.message}\nRepair: ${issue.repair}`).join("\n\n");
}

function supportedNode(value) {
  const [major, minor] = String(value || "").split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 13);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const readiness = runtimeReadiness();
  console.log(formatReadiness(readiness));
  if (!readiness.coreReady) process.exitCode = 1;
}
