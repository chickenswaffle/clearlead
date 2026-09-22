import test from "node:test";
import assert from "node:assert/strict";
import { buildApplicationKit, createSourceManifest, auditClaimRewrite, auditModelDraft } from "../src/ai-resume.mjs";

const resume = `# Taylor Example

## Summary
Platform engineer building reliable cloud services.

## Experience
- Built Python services on Kubernetes for production systems.
- Improved deployment reliability by 30% across product teams.

## Skills
- Python
- Kubernetes`;

test("application kit uses verbatim evidence and rejects invented employers and metrics", async () => {
  const modelDraft = {
    summary_source_ids: ["L004"],
    summary: { text: "Former Google platform engineer.", source_ids: ["L004"] },
    bullet_rewrites: [{ source_id: "L007", text: "Built Python services at Google." }, { source_id: "L008", text: "Improved deployment reliability by 90%." }],
    priority_source_ids: ["L007"],
    fit: { strength_source_ids: ["L007"], strengths: [{ text: "At Google, I built Python services.", source_ids: ["L007"] }], gaps: ["Taylor never led Google infrastructure"], keywords: ["Google leadership"] },
    cover_letter: { source_ids: ["L004", "L007"], paragraphs: [{ text: "I led Google's platform organization.", source_ids: ["L007"] }] },
    interview_prep: { questions: [{ question: "Tell us how you led Google infrastructure", evidence_source_ids: ["L008"], talking_points: [{ text: "I managed Google infrastructure.", source_ids: ["L008"] }] }] },
  };
  const kit = await buildApplicationKit({
    resumeText: resume,
    job: { status: "live", title: "Platform Engineer", company: "Acme", url: "https://jobs.example/1", description: "Python Kubernetes Terraform platform role" },
    generateText: async () => JSON.stringify(modelDraft),
    generatedAt: "2026-08-26T12:00:00.000Z",
  });
  assert.match(kit.files.resume, /Built Python services on Kubernetes for production systems/);
  assert.doesNotMatch(kit.files.resume, /90%/);
  for (const artifact of ["resume", "fit-report", "cover-letter", "interview-prep"]) assert.doesNotMatch(kit.files[artifact], /Google/i);
  assert.match(kit.files.resume, /30%/);
  assert.match(kit.files["fit-report"], /terraform/i);
  assert.match(kit.files["fit-report"], /Requirement matrix/i);
  assert.ok(kit.requirementMatrix.items.some((item) => item.code === "skill-terraform" && item.status === "missing"));
  assert.equal(kit.audit.rejected, 9);
  assert.match(kit.files["claim-audit"], /model-authored candidate prose is not permitted/);
});

test("audit rejects missing provenance and malformed model JSON", () => {
  const audited = auditModelDraft({
    summary: { text: "Former Google platform engineer.", source_ids: ["L004"] },
    bullet_rewrites: [
      { source_id: "L007", text: "Built Python services at Google." },
    ],
    fit: { strengths: [{ text: "At Google, I built Python services.", source_ids: ["L007"] }] },
  }, createSourceManifest(resume));
  assert.equal(audited.audit.rejected, 3);
  assert.ok(audited.audit.findings.filter((finding) => finding.status === "rejected").some((finding) => /unsupported (?:named|claim) terms/.test(finding.reason)));
  assert.ok(audited.audit.findings.filter((finding) => finding.status === "rejected").some((finding) => /model-authored candidate prose/.test(finding.reason)));
});

test("claim audit accepts strategic restructuring but rejects invented facts", async () => {
  const manifest = createSourceManifest(resume);
  const source = manifest.find((line) => line.id === "L008");
  const accepted = auditClaimRewrite(source, "- Improved reliability across product teams by 30% through deployment.");
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.immutableTokens, ["30%"]);
  assert.equal(auditClaimRewrite(source, "- Improved reliability by 90% across Google product teams.").accepted, false);
  assert.equal(auditClaimRewrite(source, "- Improved Terraform deployment reliability by 30% across product teams.").accepted, false);

  const kit = await buildApplicationKit({
    resumeText: resume,
    job: { status: "live", title: "Platform Engineer", company: "Acme", url: "https://jobs.example/1", description: "Deployment reliability across product teams" },
    generateText: async () => JSON.stringify({ priority_source_ids: ["L008"], bullet_rewrites: [{ source_id: "L008", text: accepted.text }] }),
    generatedAt: "2026-09-22T12:00:00.000Z",
  });
  assert.match(kit.files.resume, /Improved reliability across product teams by 30% through deployment/);
  assert.doesNotMatch(kit.files.resume, /Improved deployment reliability by 30%/);
  assert.match(kit.files["claim-audit"], /candidate-truth-grounded-rewrites/);
});
