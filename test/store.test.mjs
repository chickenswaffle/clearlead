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

test("saved live leads require complete verification and discovery evidence", (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-lead-evidence-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createStore(dataDir);
  const base = { status: "live", url: "https://jobs.example/role", finalUrl: "https://jobs.example/role", checkedAt: "2026-08-31T16:00:00.000Z", reason: "Apply action and job details found." };
  assert.throws(() => store.saveLiveLead({ ...base, source: "pasted" }), /HTTP result/);
  assert.throws(() => store.saveLiveLead({ ...base, httpStatus: 200 }), /discovery source/);
  const saved = store.saveLiveLead({ ...base, httpStatus: 200, source: "pasted" });
  assert.equal(saved.saved, true);
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

test("default-resume undo backups are private, capped, and one-time", (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-resume-backups-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createStore(dataDir);
  const original = store.saveResume({ filename: "original.md", text: `# Original\n\n${"Original verified resume evidence. ".repeat(6)}` });
  let latestUndoId;
  for (let index = 0; index < 12; index += 1) {
    latestUndoId = store.saveResumeAsDefault({ filename: `version-${index}.md`, text: `# Version ${index}\n\n${"Grounded resume evidence only. ".repeat(7)}` }).undoId;
  }
  const directory = path.join(dataDir, "resume-backups");
  assert.equal(fs.readdirSync(directory).length, 10);
  assert.equal(fs.statSync(path.join(directory, `${latestUndoId}.json`)).mode & 0o777, 0o600);
  const restored = store.restoreResumeBackup(latestUndoId);
  assert.equal(restored.filename, "version-10.md");
  assert.equal(fs.existsSync(path.join(directory, `${latestUndoId}.json`)), false);
  assert.throws(() => store.restoreResumeBackup(latestUndoId), /no longer available/);
  assert.equal(original.ready, true);
});

test("applied jobs persist outcomes, reject duplicates, and keep local storage private", (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-outcomes-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.chmodSync(dataDir, 0o755);
  const store = createStore(dataDir);
  const first = store.saveManualApplication({ title: "Support Engineer", company: "Acme", url: "https://jobs.example/acme/7", appliedAt: "2026-09-01T12:00:00.000Z" });
  assert.equal(first.saved, true);
  const duplicate = store.saveManualApplication({ title: "Support Engineer", company: "Acme", url: "https://jobs.example/acme/7", appliedAt: "2026-09-01T18:00:00.000Z" });
  assert.equal(duplicate.saved, false);
  const updated = store.recordApplicationOutcome(first.application.id, { stage: "rejected", stageReached: "application", reason: "unknown", note: "No reason was provided." });
  assert.equal(updated.currentStage, "rejected");
  assert.equal(store.applications()[0].events.length, 2);
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dataDir, "application-outcomes.json")).mode & 0o777, 0o600);
  assert.equal(store.outcomeLearning().mode, "observing");
});

test("completed application runs enter Applied with the original decision snapshot", (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-completed-outcome-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createStore(dataDir);
  const pageUrl = "https://boards.greenhouse.io/acme/jobs/7";
  const run = store.startApplicationRun({
    id: "11111111-1111-4111-8111-111111111111",
    job: { title: "Support Engineer", company: "Acme", source: "greenhouse", applicationUrl: pageUrl },
    allowedPages: [pageUrl],
    decisionSnapshot: { scorerVersion: "clearlead-ranking/v1", match: { score: 82, rawScore: 82, decision: { code: "apply", label: "priority apply", reason: "Strong fit." }, eligibility: { eligible: true }, qualifications: { counts: { met: 4, missing: 0 } } }, descriptionHash: "a".repeat(64), capturedAt: "2026-09-20T12:00:00.000Z" },
  });
  store.recordApplicationRunReport(run.id, { pageUrl, inspection: { phase: "complete", completionSignals: ["application received"] } });
  const applications = store.applications();
  assert.equal(applications.length, 1);
  assert.equal(applications[0].evidence, "employer_completion");
  assert.equal(applications[0].decisionSnapshot.score, 82);
  assert.equal(applications[0].events[0].source, "employer_page");
});
