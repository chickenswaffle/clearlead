import test from "node:test";
import assert from "node:assert/strict";
import { createProviderClient } from "../src/ai-providers.mjs";

function response(payload, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => payload }; }

test("provider adapters use native request shapes and normalize generated text", async () => {
  const calls = [];
  const payloads = [
    {}, { choices: [{ message: { content: "openrouter text" } }] },
    { data: [] }, { output: [{ content: [{ type: "output_text", text: "openai text" }] }] },
    { data: [] }, { content: [{ type: "text", text: "anthropic text" }] },
  ];
  const client = createProviderClient({ fetchFn: async (url, init = {}) => { calls.push({ url, init }); return response(payloads.shift()); } });
  for (const secret of [
    { provider: "openrouter", model: "router/model", apiKey: "router-secret-key" },
    { provider: "openai", model: "openai-model", apiKey: "openai-secret-key" },
    { provider: "anthropic", model: "claude-model", apiKey: "anthropic-secret-key" },
  ]) {
    const testResult = await client.testConnection(secret);
    assert.equal(testResult.ok, true);
    const text = await client.generate(secret, { instructions: "rules", input: "data" });
    assert.match(text, new RegExp(secret.provider));
  }
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/key");
  assert.equal(calls[3].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[5].url, "https://api.anthropic.com/v1/messages");
  assert.equal(JSON.parse(calls[3].init.body).store, false);
  assert.equal(JSON.parse(calls[5].init.body).system, "rules");
  assert.equal("temperature" in JSON.parse(calls[5].init.body), false);
});

test("provider errors do not echo credentials or remote response bodies", async () => {
  const client = createProviderClient({ fetchFn: async () => response({ error: "sk-secret-from-body" }, 401) });
  await assert.rejects(() => client.testConnection({ provider: "openrouter", model: "model", apiKey: "sk-private-value" }), (error) => {
    assert.doesNotMatch(error.message, /sk-private|secret-from-body/);
    assert.match(error.message, /HTTP 401/);
    return true;
  });
});
