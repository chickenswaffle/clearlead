import test from "node:test";
import assert from "node:assert/strict";
import { applyOutcomeLearning, buildOutcomeLearning, createManualApplication, recordApplicationOutcome } from "../src/outcomes.mjs";

test("application outcomes are append-only, bounded, and preserve the furthest employer stage", () => {
  const application = createManualApplication({
    title: "Support Engineer", company: "Acme", url: "https://jobs.example/acme/7", appliedAt: "2026-09-01T12:00:00.000Z",
  }, "2026-09-01T12:01:00.000Z");
  const interviewed = recordApplicationOutcome(application, {
    stage: "interview", stageReached: "interview", reason: "unknown", note: "Panel interview completed.", at: "2026-09-10T12:00:00.000Z",
  }, "2026-09-10T12:01:00.000Z");
  const rejected = recordApplicationOutcome(interviewed, {
    stage: "rejected", stageReached: "interview", reason: "unknown", note: "Generic email; no reason stated.", at: "2026-09-14T12:00:00.000Z",
  }, "2026-09-14T12:01:00.000Z");
  assert.equal(rejected.currentStage, "rejected");
  assert.equal(rejected.stageReached, "interview");
  assert.deepEqual(rejected.events.map((event) => event.type), ["applied", "interview", "rejected"]);
  assert.throws(() => recordApplicationOutcome(rejected, { stage: "invented" }), /valid application result/);
  const bounded = recordApplicationOutcome(rejected, { stage: "rejected", note: "x".repeat(2_000) });
  assert.equal(bounded.events.at(-1).note.length, 1_000);
});

test("one rejection cannot change ranking and no-response is censored from calibration", () => {
  const base = createManualApplication({ title: "Support Engineer", company: "Acme", appliedAt: "2026-09-01T12:00:00.000Z" });
  const rejected = recordApplicationOutcome(base, { stage: "rejected", stageReached: "application", reason: "unknown" });
  const unanswered = recordApplicationOutcome(createManualApplication({ title: "Support Engineer", company: "Beta", appliedAt: "2026-09-02T12:00:00.000Z" }), { stage: "no_response" });
  const learning = buildOutcomeLearning([rejected, unanswered], { rankingEnabled: true });
  assert.equal(learning.mode, "observing");
  assert.equal(learning.sampleSize, 1);
  const job = { title: "Support Engineer", company: "Gamma", match: { score: 70, decision: { code: "apply" }, eligibility: { eligible: true } } };
  assert.equal(applyOutcomeLearning(job, learning), job);
});

test("local calibration activates only after the full evidence gate and remains capped", () => {
  const applications = Array.from({ length: 20 }, (_, index) => {
    const role = index < 10 ? "Support Engineer" : "Data Analyst";
    const base = createManualApplication({ title: role, company: `Company ${index}`, source: "greenhouse", appliedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z` });
    return recordApplicationOutcome(base, index < 7
      ? { stage: "screening", stageReached: "screening" }
      : { stage: "rejected", stageReached: "application", reason: "unknown" });
  });
  const learning = buildOutcomeLearning(applications, { rankingEnabled: true });
  assert.equal(learning.mode, "active");
  assert.equal(learning.responses, 7);
  assert.equal(learning.outcomeClasses, 2);
  const job = { title: "Support Engineer", source: "greenhouse", company: "New Co", match: { score: 72, decision: { code: "review" }, eligibility: { eligible: true } } };
  const adjusted = applyOutcomeLearning(job, learning);
  assert.ok(Math.abs(adjusted.match.score - 72) <= 6);
  assert.deepEqual(adjusted.match.decision, job.match.decision);
  assert.deepEqual(adjusted.match.eligibility, job.match.eligibility);
});
