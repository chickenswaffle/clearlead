import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "../src/vault.mjs";

test("credential vault encrypts keys, exposes only a hint, and supports safe model updates", (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearlead-vault-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const vault = createCredentialVault(dataDir);
  const key = "sk-test-super-secret-1234";
  const saved = vault.save({ provider: "openrouter", model: "test/model", apiKey: key });
  assert.equal(saved.keyHint, "••••1234");
  assert.equal("apiKey" in saved, false);
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, "credentials.enc"), "utf8"), /super-secret/);
  assert.equal(fs.statSync(path.join(dataDir, "credentials.enc")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dataDir, ".credential-key")).mode & 0o777, 0o600);
  vault.save({ provider: "openrouter", model: "better/model", apiKey: "" });
  assert.equal(vault.load().apiKey, key);
  assert.equal(vault.load().model, "better/model");
  assert.throws(() => vault.save({ provider: "openai", model: "model", apiKey: "" }), /valid provider API key/);
  assert.equal(vault.remove().configured, false);
});
