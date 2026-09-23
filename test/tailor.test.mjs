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
  assert.doesNotMatch(draft.markdown, /Terraform|\$9M|secret instruction/);
  assert.doesNotMatch(draft.markdown, /Grounding report|Verified source|Generated:/);
  assert.match(draft.groundingNotes.join(" "), /no claims or metrics were invented/i);
  for (const line of resume.split("\n").filter(Boolean)) assert.ok(draft.markdown.includes(line));
  assert.ok(draft.absentTerms.includes("terraform"));
  assert.ok(draft.requirementMatrix.items.some((item) => item.code === "skill-terraform" && item.status === "missing"));
  assert.ok(draft.changes.every((change) => change.reason));
  assert.match(draft.markdown, /## Targeted Profile/);
  assert.equal(draft.tailoringAudit.policy, "extractive-targeted-profile; source-lines-preserved; employment-history-retained");
  assert.ok(draft.tailoringAudit.selections.every((selection) => resume.includes(selection.evidence)));
  assert.deepEqual(draft.tailoringAudit.omissions, []);
});

test("tailoring uses required evidence as the strongest reorder signal and explains each move", () => {
  const draft = tailorResume(resume, {
    status: "live", title: "Platform Engineer", company: "Acme",
    description: "Kubernetes is required. Customer support is preferred.",
  });
  const bullets = draft.markdown.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bullets[0], "- Built Python services on Kubernetes.");
  assert.ok(draft.requirementMatrix.items.some((item) => item.label === "kubernetes" && item.importance === "required" && item.status === "met"));
  assert.ok(draft.changes.some((change) => change.type === "reorder" && /kubernetes/i.test(change.reason)));
  assert.ok(draft.changes.some((change) => change.type === "selection" && /kubernetes/i.test(change.reason)));
});

test("local tailoring materially changes positioning with an extractive profile while retaining employment history", () => {
  const draft = tailorResume(resume, { status: "live", title: "Platform Engineer", description: "Python and Kubernetes are required. Terraform is preferred." });
  const profile = draft.markdown.slice(draft.markdown.indexOf("## Targeted Profile"), draft.markdown.indexOf("## Experience"));
  assert.match(profile, /Built Python services on Kubernetes/);
  assert.doesNotMatch(profile, /Terraform/);
  assert.match(draft.markdown, /Managed a customer support team/);
  assert.match(draft.markdown, /Improved deployment reliability by 30%/);
  assert.ok(draft.tailoringAudit.selections.some((selection) => selection.sourceLine === 5));
});

test("targeted profile never promotes a role or employer header as candidate evidence", () => {
  const headed = `# Taylor Example\n\nSupport Engineer\nAcme Corporation • Dallas, TX\n2022 - Present\n- Resolved Windows support requests and documented outcomes.\n- Managed Active Directory accounts for end users.\n\n## Skills\nWindows and Active Directory`;
  const draft = tailorResume(headed, { status: "live", title: "Support Engineer", description: "Windows and Active Directory support required." });
  const profile = draft.markdown.slice(draft.markdown.indexOf("## Targeted Profile")).split("\n\n")[0];
  assert.doesNotMatch(profile, /Acme Corporation|Dallas, TX/);
  assert.match(profile, /Windows support requests|Active Directory accounts/);
});

test("tailoring refuses unverified jobs", () => {
  assert.throws(() => tailorResume(resume, { status: "unverified", title: "Role" }), /verified-live/);
});

test("tailoring restores a missing header only from the saved application identity", () => {
  const extracted = `${resume.replace("# Taylor Example\n\n", "")}\n\n## Education\nTaylor Example\ntaylor@example.com\nCedar Hill, TX`;
  const draft = tailorResume(extracted, { status: "live", title: "Support Engineer", description: "Python support" }, {
    identity: { fullName: "Taylor Example", email: "taylor@example.com", location: "Cedar Hill, TX" },
  });
  assert.match(draft.markdown, /^# Taylor Example\n\ntaylor@example\.com \| Cedar Hill, TX/);
  assert.equal(draft.markdown.match(/Taylor Example/g)?.length, 1);
  assert.equal(draft.markdown.match(/taylor@example\.com/g)?.length, 1);
  assert.match(draft.groundingNotes[0], /saved resume or application identity/);
});

test("tailoring repairs common PDF ligature spacing without changing claims", () => {
  const broken = resume.replace("Built Python services", "Built work fl ows and con fi gured Python services while raising fi rst-contact quality and\nfi rmware reliability, Con fi gure systems, track certi fi cations, and complete Insurance Veri fi cation");
  const draft = tailorResume(broken, { status: "live", title: "Support Engineer", description: "Python support" });
  assert.match(draft.markdown, /Built workflows and configured Python services while raising first-contact quality and firmware reliability/);
  assert.match(draft.markdown, /Configure systems, track certifications, and complete Insurance Verification/);
  assert.doesNotMatch(draft.markdown, /fl ows|fi gured/);
});

test("ligature repair preserves legitimate words and role abbreviations", () => {
  const intact = resume.replace("Built Python services", "Tracked sales figure trends and partnered with an FI analyst on Python services");
  const draft = tailorResume(intact, { status: "live", title: "Support Engineer", description: "Python support" });
  assert.match(draft.markdown, /sales figure trends/);
  assert.match(draft.markdown, /FI analyst/);
  assert.doesNotMatch(draft.markdown, /salesfigure|FIanalyst/);
});

test("tailoring rejoins wrapped PDF bullets without absorbing the next role", () => {
  const wrapped = `# Taylor Example\n\n## Experience\nRole One\nExample Co • Dallas, TX\n2023 - Present\n• Improved first-\ncontact support while documenting reliable technical\nresolutions.\nNext Role\nOther Co • Irving, TX\n2021 - 2023\n• Supported end users and systems.\n\n## Skills\nPython and Linux administration`;
  const draft = tailorResume(wrapped, { status: "live", title: "Support Engineer", description: "technical support" });
  assert.match(draft.markdown, /• Improved first-contact support while documenting reliable technical resolutions\./);
  assert.match(draft.markdown, /\nNext Role\nOther Co/);
  assert.doesNotMatch(draft.markdown, /resolutions\. Next Role/);
});
