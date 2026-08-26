import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProfile, profileReadiness, roleRelevance } from "../src/profile.mjs";

test("profile readiness requires at least one target role", () => {
  assert.deepEqual(profileReadiness({}), {
    ready: false,
    missing: ["target roles"],
    message: "Add at least one target role to see relevance signals. You can still verify any URL.",
  });
});

test("profile normalization deduplicates values and relevance stays explainable", () => {
  const profile = normalizeProfile({
    targetRoles: "Staff Engineer, ML Platform Engineer, Staff Engineer",
    locations: ["Remote", "Remote", "Chicago"],
  });
  assert.deepEqual(profile.targetRoles, ["Staff Engineer", "ML Platform Engineer"]);
  assert.deepEqual(profile.locations, ["Remote", "Chicago"]);
  assert.deepEqual(roleRelevance("Staff ML Platform Engineer", profile), {
    matched: ["staff", "engineer", "ml", "platform"],
    totalTerms: 4,
    score: 100,
  });
});
