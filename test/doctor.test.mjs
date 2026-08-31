import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatReadiness, runtimeReadiness } from "../src/doctor.mjs";

test("runtime readiness names exact missing prerequisites and repair commands", (context) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-doctor-"));
  context.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const missing = runtimeReadiness({ rootDir, nodeVersion: "20.19.0" });
  assert.equal(missing.ready, false);
  assert.equal(missing.coreReady, false);
  assert.deepEqual(missing.issues.map((issue) => issue.id), ["node-version", "pdf-dependency"]);
  assert.match(formatReadiness(missing), /nvm install 24 && nvm use 24/);
  assert.match(formatReadiness(missing), /npm ci/);

  fs.mkdirSync(path.join(rootDir, "node_modules", "pdfjs-dist", "legacy", "build"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.mjs"), "export {};\n");
  const ready = runtimeReadiness({ rootDir, nodeVersion: "24.1.0" });
  assert.equal(ready.ready, true);
  assert.equal(ready.coreReady, true);
});
