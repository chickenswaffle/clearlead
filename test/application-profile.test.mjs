import test from "node:test";
import assert from "node:assert/strict";
import { normalizeApplicationProfile, applicationProfileReadiness } from "../src/application-profile.mjs";

test("application identity is normalized without inventing legal answers", () => {
  const profile = normalizeApplicationProfile({ fullName: "  Taylor   Example ", email: "taylor@example.com", linkedinUrl: "https://linkedin.com/in/taylor", workAuthorization: "maybe", needsSponsorship: "yes", age18OrOlder: "yes", restrictiveAgreement: "no", backgroundCheckConsent: "sometimes", workArrangement: "either", startAvailability: "two-weeks" });
  assert.equal(profile.firstName, "Taylor");
  assert.equal(profile.lastName, "Example");
  assert.equal(profile.workAuthorization, "unknown");
  assert.equal(profile.needsSponsorship, "yes");
  assert.equal(profile.age18OrOlder, "yes");
  assert.equal(profile.restrictiveAgreement, "no");
  assert.equal(profile.backgroundCheckConsent, "unknown");
  assert.equal(profile.workArrangement, "either");
  assert.equal(profile.startAvailability, "two-weeks");
  assert.equal(applicationProfileReadiness(profile).ready, true);
});

test("application identity requires a name and valid email for autofill", () => {
  const readiness = applicationProfileReadiness({ fullName: "Taylor", email: "not-an-email" });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.missing.includes("valid email"));
});
