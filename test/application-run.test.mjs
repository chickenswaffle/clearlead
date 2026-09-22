import test from "node:test";
import assert from "node:assert/strict";
import { createApplicationRun, recordApplicationRunReport, resumeApplicationRun, sanitizeApplicationReport } from "../src/application-run.mjs";

const pack = {
  id: "run-7",
  job: { title: "Support Engineer", company: "Acme", applicationUrl: "https://boards.greenhouse.io/acme/jobs/7" },
  resume: { draftId: "draft-7", filename: "resume.pdf", pdfUrl: "/resume.pdf" },
  truth: { schema: "clearlead-candidate-truth/v1", fingerprint: "abc123" },
  allowedPages: ["https://boards.greenhouse.io/acme/jobs/7"],
};

test("application runs move from preparation to review and final approval without storing answers", () => {
  const prepared = createApplicationRun(pack);
  assert.equal(prepared.status, "prepared");
  const review = recordApplicationRunReport(prepared, {
    pageUrl: pack.allowedPages[0],
    inspection: { atsFamily: "greenhouse", phase: "application", fieldCount: 6, requiredCount: 4, emptyRequiredCount: 2, submitControlCount: 1 },
    fill: { filled: 2, review: 2, blocked: 1, manual: 1, email: "must-not-persist@example.com" },
    pageText: "must not persist",
  }, "2026-09-22T10:00:00.000Z");
  assert.equal(review.status, "needs_review");
  assert.doesNotMatch(JSON.stringify(review), /must-not-persist|pageText/);

  const ready = recordApplicationRunReport(review, {
    pageUrl: pack.allowedPages[0],
    inspection: { atsFamily: "greenhouse", phase: "application", fieldCount: 6, requiredCount: 4, emptyRequiredCount: 0, submitControlCount: 1 },
  }, "2026-09-22T10:01:00.000Z");
  assert.equal(ready.status, "ready_for_final_approval");
  assert.equal(ready.completedAt, null);
});

test("application completion requires compact employer-page evidence", () => {
  const prepared = createApplicationRun(pack);
  const noEvidence = recordApplicationRunReport(prepared, {
    pageUrl: pack.allowedPages[0], inspection: { phase: "complete", completionSignals: [] },
  });
  assert.equal(noEvidence.status, "in_progress");
  const complete = recordApplicationRunReport(noEvidence, {
    pageUrl: pack.allowedPages[0], inspection: { atsFamily: "greenhouse", phase: "complete", completionSignals: ["application received"] },
  }, "2026-09-22T10:02:00.000Z");
  assert.equal(complete.status, "complete");
  assert.equal(complete.completedAt, "2026-09-22T10:02:00.000Z");
});

test("application reports are bounded and cannot cross prepared jobs", () => {
  const sanitized = sanitizeApplicationReport({
    pageUrl: pack.allowedPages[0],
    inspection: { atsFamily: "greenhouse<script>", fieldCount: 1e9, completionSignals: [" application received ", " application received "] },
  });
  assert.equal(sanitized.atsFamily, "greenhousescript");
  assert.equal(sanitized.fieldCount, 10_000);
  assert.deepEqual(sanitized.completionSignals, ["application received"]);
  assert.throws(() => recordApplicationRunReport(createApplicationRun(pack), {
    pageUrl: "https://jobs.evil.example/apply", inspection: { phase: "application" },
  }), /does not belong/);
});

test("resuming keeps the durable run id and history while requiring fresh inspection", () => {
  const prepared = createApplicationRun(pack);
  const ready = recordApplicationRunReport(prepared, {
    pageUrl: pack.allowedPages[0], inspection: { phase: "application", emptyRequiredCount: 0, submitControlCount: 1 },
  });
  const resumed = resumeApplicationRun(ready, { ...pack, job: { ...pack.job, checkedAt: "2026-09-22T11:00:00.000Z", httpStatus: 200 } }, "2026-09-22T11:00:01.000Z");
  assert.equal(resumed.id, ready.id);
  assert.equal(resumed.status, "in_progress");
  assert.equal(resumed.events.at(-1).type, "resumed");
  assert.equal(resumed.job.httpStatus, 200);
});

test("multi-page reports accept only the prepared ATS job scope and record step evidence", () => {
  const multiPagePack = {
    ...pack,
    id: "run-multi",
    allowedPages: ["https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/Role/R-12345"],
    navigation: { multiPage: true, origin: "https://acme.wd5.myworkdayjobs.com", pathPrefix: "/en-US/jobs/job/Role/R-12345", jobTokens: ["r-12345"], atsFamily: "workday", allowedHostSuffix: "myworkdayjobs.com" },
  };
  const run = createApplicationRun(multiPagePack);
  const progressed = recordApplicationRunReport(run, {
    pageUrl: "https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/Role/R-12345/apply?step=2",
    inspection: { atsFamily: "workday", phase: "application", stepKey: "workday:experience", stepLabel: "Experience", requiredCount: 2, emptyRequiredCount: 0, nextControlCount: 1 },
  });
  assert.equal(progressed.status, "in_progress");
  assert.equal(progressed.events.at(-1).stepKey, "workdayexperience");
  assert.equal(progressed.events.at(-1).nextControlCount, 1);
  assert.throws(() => recordApplicationRunReport(progressed, {
    pageUrl: "https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/Other/R-99999/apply",
    inspection: { phase: "application" },
  }), /does not belong/);
  assert.throws(() => recordApplicationRunReport(progressed, {
    pageUrl: "https://evil.example/en-US/jobs/job/Role/R-12345/apply",
    inspection: { phase: "application" },
  }), /does not belong/);
});
