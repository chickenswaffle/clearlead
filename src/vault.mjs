import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PROVIDERS = new Set(["openrouter", "openai", "anthropic"]);

export function createCredentialVault(dataDir) {
  const keyPath = path.join(dataDir, ".credential-key");
  const vaultPath = path.join(dataDir, "credentials.enc");

  function load() {
    if (!fs.existsSync(vaultPath)) return null;
    try {
      const envelope = JSON.parse(fs.readFileSync(vaultPath, "utf8"));
      const key = readKey(keyPath);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return normalizeSecret(JSON.parse(plaintext));
    } catch {
      throw new Error("ClearLead could not unlock the local AI credential vault. The encrypted file was left untouched.");
    }
  }

  function save(input) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    const existing = load();
    const incomingProvider = String(input.provider || "").trim().toLowerCase();
    const retainedKey = existing?.provider === incomingProvider ? existing.apiKey : "";
    const candidate = {
      provider: input.provider,
      model: input.model,
      apiKey: String(input.apiKey || "").trim() || retainedKey,
      savedAt: new Date().toISOString(),
    };
    const secret = normalizeSecret(candidate);
    if (!secret.apiKey || secret.apiKey.length < 12) throw new Error("Enter a valid provider API key.");
    const key = ensureKey(keyPath);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
    atomicWrite(vaultPath, JSON.stringify({
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }, null, 2) + "\n");
    return publicStatus(secret);
  }

  function remove() {
    if (fs.existsSync(vaultPath)) fs.unlinkSync(vaultPath);
    return publicStatus(null);
  }

  return { load, save, remove, status: () => publicStatus(load()) };
}

export function publicStatus(secret) {
  if (!secret) return { configured: false, provider: "", model: "", keyHint: "", savedAt: null };
  return {
    configured: true,
    provider: secret.provider,
    model: secret.model,
    keyHint: `••••${secret.apiKey.slice(-4)}`,
    savedAt: secret.savedAt,
  };
}

function normalizeSecret(value = {}) {
  const provider = String(value.provider || "").trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error("Choose OpenRouter, OpenAI, or Anthropic.");
  const model = String(value.model || "").trim().slice(0, 160);
  if (!model) throw new Error("Enter the model ID available to your provider account.");
  return {
    provider,
    model,
    apiKey: String(value.apiKey || "").trim(),
    savedAt: validIso(value.savedAt) || new Date().toISOString(),
  };
}

function ensureKey(file) {
  if (fs.existsSync(file)) return readKey(file);
  const key = randomBytes(32);
  const descriptor = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, key.toString("base64") + "\n");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return key;
}

function readKey(file) {
  const key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error("Invalid credential key.");
  return key;
}

function atomicWrite(file, text) {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, text);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function validIso(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
