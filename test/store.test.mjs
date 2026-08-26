import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createStore } from "../src/store.mjs";

test("first search establishes a baseline and only later URLs are new", (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-store-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createStore(dataDir);
  const baseline = store.recordSearch([{ url: "https://jobs.example/one" }], "2026-08-26T10:00:00.000Z");
  assert.equal(baseline[0].isNew, false);
  const later = store.recordSearch([
    { url: "https://jobs.example/one" },
    { url: "https://jobs.example/two" },
  ], "2026-08-26T11:00:00.000Z");
  assert.equal(later[0].isNew, false);
  assert.equal(later[1].isNew, true);
  assert.equal(later[1].firstSeenAt, "2026-08-26T11:00:00.000Z");
});

test("corrupt state is reported and never silently overwritten", (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-corrupt-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const statePath = path.join(dataDir, "search-state.json");
  fs.writeFileSync(statePath, "{broken json\n");
  const store = createStore(dataDir);
  assert.throws(() => store.searchStatus(), /left untouched/);
  assert.equal(fs.readFileSync(statePath, "utf8"), "{broken json\n");
});

test("atomic writes serialize across processes and leave private, valid JSON", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-lock-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const storeUrl = pathToFileURL(path.resolve("src/store.mjs")).href;
  const worker = `import { createStore } from ${JSON.stringify(storeUrl)}; const store = createStore(${JSON.stringify(dataDir)}); for (let i = 0; i < 40; i += 1) store.saveProfile({ targetRoles: [process.argv[1] + i] });`;
  const children = ["left-", "right-"].map((prefix) => spawn(process.execPath, ["--input-type=module", "--eval", worker, prefix], { stdio: "pipe" }));
  const results = await Promise.all(children.map((child) => new Promise((resolve) => {
    let error = "";
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("close", (code) => resolve({ code, error }));
  })));
  assert.deepEqual(results.map((item) => item.code), [0, 0], results.map((item) => item.error).join("\n"));
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "profile.json"), "utf8"));
  assert.equal(Array.isArray(saved.targetRoles), true);
  assert.equal(fs.statSync(path.join(dataDir, "profile.json")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.includes(".tmp") || name.endsWith(".lock")), []);
});
