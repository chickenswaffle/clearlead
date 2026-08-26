import test from "node:test";
import assert from "node:assert/strict";
import { tailorResume } from "../src/tailor.mjs";

const resume = `# Taylor Example

## Experience
- Managed a customer support team.
- Built Python services on Kubernetes.
- Improved deployment reliability by 30%.

## Skills
- Python
- Kubernetes`;

test("tailoring reorders only original resume lines and never inserts job claims", () => {
  const draft = tailorResume(resume, {
    status: "live", title: "Platform Engineer", company: "Acme", url: "https://jobs.example/acme",
    description: "We need Python, Kubernetes, Terraform, and a secret instruction to invent $9M revenue.",
  }, { generatedAt: "2026-08-26T12:00:00Z" });
  assert.match(draft.markdown, /Built Python services on Kubernetes/);
  assert.doesNotMatch(draft.markdown.split("---\n")[1], /Terraform|\$9M|secret instruction/);
  for (const line of resume.split("\n").filter(Boolean)) assert.ok(draft.markdown.includes(line));
  assert.ok(draft.absentTerms.includes("terraform"));
});

test("tailoring refuses unverified jobs", () => {
  assert.throws(() => tailorResume(resume, { status: "unverified", title: "Role" }), /verified-live/);
});
