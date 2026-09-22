import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applicationProfileReadiness } from "./application-profile.mjs";
import { runtimeReadiness } from "./doctor.mjs";
import { resumeSummary } from "./resume.mjs";
import { createStore } from "./store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function dogfoodPreflight({ store, runtime, extensionVersion = "unknown", now = Date.now() }) {
  const resume = resumeSummary(store.resume());
  const application = applicationProfileReadiness(store.applicationProfile());
  const pairing = store.extensionPairing();
  const pairingExpiresAt = String(pairing?.expiresAt || "");
  const pairingReady = Boolean(pairing?.tokenHash) && Date.parse(pairingExpiresAt) > now;
  const search = store.searchConfig();
  const sourceCount = (search.greenhouseBoards?.length || 0) + (search.leverSites?.length || 0) + (search.ashbyBoards?.length || 0) + (search.broadFeeds?.length || 0);
  const checks = [
    check("runtime", runtime.coreReady, runtime.coreReady ? "Node runtime and core dependencies ready." : runtime.message || "Run npm ci."),
    check("resume", resume.ready, resume.message),
    check("application identity", application.ready, application.message),
    check("extension pairing", pairingReady, pairingReady ? `Pairing valid until ${pairingExpiresAt}. Reload extension v${extensionVersion}.` : "Create a fresh pairing token in ClearLead, then paste it into the extension."),
    check("job sources", sourceCount > 0, sourceCount > 0 ? `${sourceCount} employer/feed sources configured.` : "Add at least one employer board or broad feed."),
  ];
  const ready = checks.every((item) => item.ready);
  return {
    ready,
    extensionVersion,
    checks,
    nextAction: ready
      ? "Run npm start, reload the unpacked extension, then use FIRST_TEST.md for one reviewed application."
      : checks.find((item) => !item.ready)?.message || "Resolve the failed preflight check.",
  };
}

export function formatDogfoodPreflight(result) {
  return [
    result.ready ? "ClearLead is ready for a controlled live application." : "ClearLead is not ready for a live application yet.",
    "",
    ...result.checks.map((item) => `${item.ready ? "PASS" : "BLOCK"}  ${item.name} — ${item.message}`),
    "",
    `NEXT  ${result.nextAction}`,
  ].join("\n");
}

function check(name, ready, message) { return { name, ready: Boolean(ready), message: String(message || "") }; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.CLEARLEAD_DATA_DIR ? path.resolve(process.env.CLEARLEAD_DATA_DIR) : path.join(root, "data");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
  const result = dogfoodPreflight({ store: createStore(dataDir), runtime: runtimeReadiness({ rootDir: root }), extensionVersion: manifest.version });
  console.log(formatDogfoodPreflight(result));
  if (!result.ready) process.exitCode = 1;
}
