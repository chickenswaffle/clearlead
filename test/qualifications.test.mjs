import test from "node:test";
import assert from "node:assert/strict";
import { analyzeQualifications } from "../src/qualifications.mjs";

test("qualification analysis distinguishes proven, reviewable, and missing requirements", () => {
  const result = analyzeQualifications({
    title: "Support Technician",
    description: "Bachelor's degree or equivalent experience. 5+ years' experience. Security+ certification required.",
  }, {
    text: "Experience\nSupport Analyst\n03/2020 - Present\nEducation\nAssociate degree in technology",
    skills: ["Windows"],
  }, { now: new Date("2026-09-22T00:00:00Z") });
  assert.equal(result.items.find((item) => item.code === "experience-years").status, "uncertain");
  assert.equal(result.items.find((item) => item.code === "education").status, "uncertain");
  assert.equal(result.items.find((item) => item.code === "cert-security").status, "missing");
  assert.equal(result.penalty, 23);
  assert.match(result.items[0].postingEvidence, /5\+ years/);
  assert.match(result.items[0].candidateEvidence, /[67] years/);
});

test("matching degree and certification evidence are credited without inventing relevance", () => {
  const result = analyzeQualifications({ description: "Bachelor's degree required. ITIL certification required." }, { text: "Bachelor of Science\nITIL Foundation certified" });
  assert.deepEqual(result.items.map((item) => item.status), ["met", "met"]);
  assert.equal(result.penalty, 0);
});

test("preferred certifications are typed and do not become hard missing counts", () => {
  const result = analyzeQualifications({ description: "A+ and Network+ are highly desirable." }, { text: "Desktop support" });
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((item) => item.importance === "preferred" && item.status === "missing"));
  assert.equal(result.counts.missing, 0);
  assert.equal(result.counts.preferredMissing, 2);
});

test("spelled-out experience and required language cannot score as risk-free", () => {
  const result = analyzeQualifications({ description: "Five years experience required. Fluent Spanish required." }, { text: "Windows help desk" });
  assert.equal(result.items.find((item) => item.code === "experience-years").status, "missing");
  assert.equal(result.items.find((item) => item.code === "language-spanish").status, "missing");
  assert.equal(result.counts.missing, 2);
});

test("skills, clearance, and onsite location constraints remain individually auditable", () => {
  const result = analyzeQualifications({
    location: "Dallas, TX",
    description: "Kubernetes is required. Active security clearance required. This is an onsite role and local candidates are required.",
  }, { text: "Built Kubernetes services.\nActive security clearance." }, {
    applicationProfile: { city: "Dallas", state: "TX" },
  });
  assert.equal(result.items.find((item) => item.code === "skill-kubernetes").status, "met");
  assert.equal(result.items.find((item) => item.code === "security-clearance").status, "met");
  assert.equal(result.items.find((item) => item.code === "location").status, "met");
});

test("minimum-qualification sections make listed skills and domain-qualified experience required", () => {
  const result = analyzeQualifications({
    description: "Minimum Qualifications:\nActive Directory\n3 years of IT support experience",
  }, { text: "General customer support\n2024 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
  const experience = result.items.find((item) => item.code === "experience-years");
  const activeDirectory = result.items.find((item) => item.code === "skill-active-directory");
  assert.equal(experience.importance, "required");
  assert.equal(experience.status, "missing");
  assert.equal(activeDirectory.importance, "required");
  assert.equal(activeDirectory.status, "missing");
  assert.equal(result.counts.missing, 2);
});

test("negated availability conflicts with required weekend and overnight schedules", () => {
  for (const preference of ["No weekends", "Cannot work overnight"]) {
    const result = analyzeQualifications({ description: "Requirements:\nMust be available for weekends and overnight shifts." }, { text: "IT support" }, { profile: { preferences: [preference] } });
    const schedule = result.items.find((item) => item.code === "schedule");
    assert.equal(schedule.importance, "required");
    assert.equal(schedule.status, "missing");
    assert.match(schedule.explanation, /conflicts/i);
  }
});

test("required heading context stops at the next unrelated section", () => {
  const result = analyzeQualifications({ description: "Minimum Qualifications:\nActive Directory\nPreferred Skills:\nKubernetes" }, { text: "Active Directory" });
  assert.equal(result.items.find((item) => item.code === "skill-active-directory").importance, "required");
  assert.equal(result.items.find((item) => item.code === "skill-kubernetes").importance, "preferred");
});

test("required heading context also stops at colonless responsibility headings", () => {
  const result = analyzeQualifications({ description: "Minimum Qualifications\nWindows\nResponsibilities\nActive Directory" }, { text: "Windows" });
  assert.equal(result.items.find((item) => item.code === "skill-windows").importance, "required");
  assert.equal(result.items.find((item) => item.code === "skill-active-directory").importance, "preferred");
});

test("common years-before-domain and experience-prefix requirements are detected", () => {
  for (const requirement of ["3+ years in IT support", "Experience: 3+ years supporting Windows"]) {
    const result = analyzeQualifications({ description: `Minimum Qualifications\n${requirement}` }, { text: "Support associate\n2025 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
    const experience = result.items.find((item) => item.code === "experience-years");
    assert.equal(experience?.importance, "required", requirement);
    assert.equal(experience?.status, "missing", requirement);
    assert.match(experience?.postingEvidence || "", /3\+ years/i, requirement);
  }
});

test("posting-side negation does not invent missing degree or certification gates", () => {
  const result = analyzeQualifications({ description: "A+ certification is not required. No bachelor's degree is required." }, { text: "IT support" });
  assert.equal(result.items.some((item) => item.code === "cert-a"), false);
  assert.equal(result.items.some((item) => item.code === "education"), false);
  assert.equal(result.counts.missing, 0);
});

test("requirement polarity is scoped to contrast clauses", () => {
  const mixedEducation = analyzeQualifications({ description: "No bachelor's degree is required, but 3+ years in IT support is required." }, { text: "Support associate\n2025 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
  assert.equal(mixedEducation.items.some((item) => item.code === "education"), false);
  assert.equal(mixedEducation.items.find((item) => item.code === "experience-years")?.status, "missing");

  const mixedCertifications = analyzeQualifications({ description: "A+ certification is not required, but Network+ certification is required." }, { text: "IT support" });
  assert.equal(mixedCertifications.items.some((item) => item.code === "cert-a"), false);
  assert.equal(mixedCertifications.items.find((item) => item.code === "cert-network")?.status, "missing");
});

test("company history and optional credentials do not become candidate gates", () => {
  for (const description of [
    "Our company brings 25 years in IT support to customers.",
    "Our leadership team has 10 years supporting Windows customers.",
    "A+ certification is optional.",
  ]) {
    const result = analyzeQualifications({ description }, { text: "IT support" });
    assert.equal(result.items.some((item) => item.code === "experience-years"), false, description);
    assert.equal(result.counts.missing, 0, description);
  }
});

test("contrast connectors preserve the requirement they actually qualify", () => {
  const mixedEducation = analyzeQualifications({ description: "Although a bachelor's degree is not required, 3+ years in IT support is required." }, { text: "Support associate\n2025 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
  assert.equal(mixedEducation.items.some((item) => item.code === "education"), false);
  assert.equal(mixedEducation.items.find((item) => item.code === "experience-years")?.status, "missing");

  const mixedCertifications = analyzeQualifications({ description: "A+ is optional, while Network+ is required." }, { text: "IT support" });
  assert.equal(mixedCertifications.items.some((item) => item.code === "cert-a"), false);
  assert.equal(mixedCertifications.items.find((item) => item.code === "cert-network")?.status, "missing");
});

test("candidate tenure, generic qualification headings, and named-company history stay distinct", () => {
  for (const description of ["The company requires candidates to have 5 years in IT support.", "Qualifications:\n3+ years in IT support"]) {
    const result = analyzeQualifications({ description }, { text: "Support associate\n2025 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
    assert.equal(result.items.find((item) => item.code === "experience-years")?.status, "missing", description);
  }
  const history = analyzeQualifications({ description: "Acme has 25 years of IT support experience." }, { text: "IT support" });
  assert.equal(history.items.some((item) => item.code === "experience-years"), false);
  assert.equal(history.counts.missing, 0);
});

test("natural not-needed credential language does not become a hard gate", () => {
  for (const description of ["You do not need A+ certification.", "A+ certification is not needed.", "A+ certification is not necessary."]) {
    const result = analyzeQualifications({ description }, { text: "IT support" });
    assert.equal(result.items.some((item) => item.code === "cert-a"), false, description);
    assert.equal(result.counts.missing, 0, description);
  }
});

test("contrast connectors do not require punctuation to preserve hard gates", () => {
  for (const connector of ["but", "while", "whereas", "yet", "however"]) {
    const result = analyzeQualifications({ description: `A+ is optional ${connector} Network+ is required.` }, { text: "IT support" });
    assert.equal(result.items.some((item) => item.code === "cert-a"), false, connector);
    assert.equal(result.items.find((item) => item.code === "cert-network")?.status, "missing", connector);
  }
});

test("candidate-has tenure, clause-scoped degrees, and year-leading marketing stay distinct", () => {
  const candidateTenure = analyzeQualifications({ description: "The ideal candidate has 5+ years of IT support experience." }, { text: "Support Associate\n2025 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
  assert.equal(candidateTenure.items.find((item) => item.code === "experience-years")?.status, "missing");

  for (const description of ["Bachelor's degree is not required, but a high school diploma is required.", "Bachelor's degree preferred, but high school diploma required."]) {
    const result = analyzeQualifications({ description }, { text: "Support Associate" });
    const education = result.items.find((item) => item.code === "education");
    assert.equal(education?.label, "high school diploma", description);
    assert.equal(education?.importance, "required", description);
    assert.equal(education?.status, "missing", description);
  }

  const marketing = analyzeQualifications({ description: "25 years of IT support experience powers Acme customer service." }, { text: "IT support" });
  assert.equal(marketing.items.some((item) => item.code === "experience-years"), false);
  assert.equal(marketing.counts.missing, 0);
});

test("and or although can separate optional and required credentials", () => {
  for (const connector of ["and", "although"]) {
    const result = analyzeQualifications({ description: `A+ is optional ${connector} Network+ is required.` }, { text: "IT support" });
    assert.equal(result.items.some((item) => item.code === "cert-a"), false, connector);
    assert.equal(result.items.find((item) => item.code === "cert-network")?.status, "missing", connector);
  }
});

test("natural candidate-tenure phrases are gates while trailing marketing prose is not", () => {
  for (const description of ["You should have 5+ years of IT support experience.", "We are looking for someone with 5+ years of IT support experience."]) {
    const result = analyzeQualifications({ description }, { text: "Support Associate\n2025 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
    assert.equal(result.items.find((item) => item.code === "experience-years")?.status, "missing", description);
  }
  const marketing = analyzeQualifications({ description: "10 years of IT support experience powers Acme customer service." }, { text: "IT support" });
  assert.equal(marketing.items.some((item) => item.code === "experience-years"), false);
});

test("employment uses of associate do not prove an academic degree", () => {
  const result = analyzeQualifications({ description: "Associate degree is required." }, { text: "Support Associate in Dallas" });
  assert.equal(result.items.find((item) => item.code === "education")?.status, "missing");
});

test("polarity qualifiers before and do not erase the following requirement", () => {
  for (const optional of ["A+ is optional for this role", "A+ is not required for this role"]) {
    const result = analyzeQualifications({ description: `${optional} and Network+ is required.` }, { text: "IT support" });
    assert.equal(result.items.some((item) => item.code === "cert-a"), false, optional);
    assert.equal(result.items.find((item) => item.code === "cert-network")?.status, "missing", optional);
  }
});

test("looking for someone who has tenure is a candidate requirement", () => {
  for (const description of ["We are looking for someone who has 5+ years of IT support experience.", "We seek someone who has 5+ years of IT support experience."]) {
    const result = analyzeQualifications({ description }, { text: "Support analyst\n2025 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
    assert.equal(result.items.find((item) => item.code === "experience-years")?.status, "missing", description);
  }
});

test("plain as is not an associate degree abbreviation but uppercase academic forms are", () => {
  const requirement = { description: "Associate degree is required." };
  const employment = analyzeQualifications(requirement, { text: "Worked as an IT Support Specialist" });
  assert.equal(employment.items.find((item) => item.code === "education")?.status, "missing");
  for (const abbreviation of ["AA", "AS", "AAS", "A.S."]) {
    const education = analyzeQualifications(requirement, { text: `Education\n${abbreviation} in Information Technology` });
    const item = education.items.find((entry) => entry.code === "education");
    assert.equal(item?.status, "met", abbreviation);
    assert.match(item?.candidateEvidence || "", new RegExp(abbreviation.replaceAll(".", "\\.")));
  }
});

test("canonical year-first domain requirements survive flattened posting prose", () => {
  for (const description of [
    "5+ years of experience in IT support",
    "5+ years experience in IT support",
    "At least 5+ years of IT support experience",
    "5+ years of IT support experience working with Windows",
  ]) {
    const result = analyzeQualifications({ description }, { text: "Support analyst\n2025 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
    assert.equal(result.items.find((item) => item.code === "experience-years")?.status, "missing", description);
    assert.equal(result.counts.missing, 1, description);
  }
  const marketing = analyzeQualifications({ description: "10 years of IT support experience powers Acme customer service." }, { text: "IT support" });
  assert.equal(marketing.items.some((item) => item.code === "experience-years"), false);
});

test("or-more tenure phrases remain hard requirements without capturing company history", () => {
  for (const description of [
    "Candidates must have five or more years of IT support experience.",
    "Minimum qualifications: 5 or more years in desktop support.",
    "Experience: five or more years supporting Windows users.",
  ]) {
    const result = analyzeQualifications({ description }, { text: "Windows desktop IT support analyst\n2025 - Present" }, { now: new Date("2026-09-22T00:00:00Z") });
    assert.equal(result.items.find((item) => item.code === "experience-years")?.status, "missing", description);
    assert.ok(result.counts.missing >= 1, description);
  }
  const marketing = analyzeQualifications({ description: "Acme has 20 or more years of IT support experience." }, { text: "IT support" });
  assert.equal(marketing.items.some((item) => item.code === "experience-years"), false);
});
