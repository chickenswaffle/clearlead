import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
