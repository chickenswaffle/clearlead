import test from "node:test";
import assert from "node:assert/strict";
import { dogfoodPreflight, formatDogfoodPreflight } from "../src/preflight.mjs";

function store(overrides = {}) {
  return {
    resume: () => ({ text: "Experienced support technician with extensive experience troubleshooting Windows devices, networks, software, tickets, users, documentation, and customer requests across busy teams.", filename: "resume.md" }),
    applicationProfile: () => ({ fullName: "Taylor Example", email: "taylor@example.com" }),
    extensionPairing: () => ({ tokenHash: "abc", expiresAt: "2026-10-01T00:00:00.000Z" }),
    searchConfig: () => ({ greenhouseBoards: ["acme"], leverSites: [], ashbyBoards: [], broadFeeds: ["jobledger"] }),
    ...overrides,
  };
}

test("dogfood preflight gives one concrete start action when local state is ready", () => {
  const result = dogfoodPreflight({ store: store(), runtime: { coreReady: true }, extensionVersion: "0.5.0", now: Date.parse("2026-09-22T00:00:00.000Z") });
  assert.equal(result.ready, true);
  assert.equal(result.checks.every((item) => item.ready), true);
  assert.match(formatDogfoodPreflight(result), /ready for a controlled live application/);
  assert.match(result.nextAction, /FIRST_TEST\.md/);
});

test("dogfood preflight blocks expired pairing with an actionable repair", () => {
  const result = dogfoodPreflight({
    store: store({ extensionPairing: () => ({ tokenHash: "abc", expiresAt: "2026-09-01T00:00:00.000Z" }) }),
    runtime: { coreReady: true },
    extensionVersion: "0.5.0",
    now: Date.parse("2026-09-22T00:00:00.000Z"),
  });
  assert.equal(result.ready, false);
  assert.match(result.nextAction, /fresh pairing token/i);
  assert.match(formatDogfoodPreflight(result), /BLOCK  extension pairing/);
});
