const PROVIDER_NAMES = { openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic" };

export function createProviderClient({ fetchFn = fetch, timeoutMs = 90_000 } = {}) {
  async function requestJson(url, init, provider, requestTimeout = timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const response = await fetchFn(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`${PROVIDER_NAMES[provider]} returned HTTP ${response.status}. Check the key, model access, and provider balance.`);
      const payload = await response.json();
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`${PROVIDER_NAMES[provider]} timed out. Nothing was saved; retry when the provider is available.`);
      if (error instanceof Error && error.message.startsWith(PROVIDER_NAMES[provider])) throw error;
      throw new Error(`Could not reach ${PROVIDER_NAMES[provider]} from this machine. Check the connection and retry.`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function testConnection(secret) {
    validateSecret(secret);
    if (secret.provider === "openrouter") {
      await requestJson("https://openrouter.ai/api/v1/key", { headers: bearer(secret.apiKey) }, secret.provider, 20_000);
    } else if (secret.provider === "openai") {
      await requestJson("https://api.openai.com/v1/models", { headers: bearer(secret.apiKey) }, secret.provider, 20_000);
    } else {
      await requestJson("https://api.anthropic.com/v1/models?limit=1", { headers: anthropicHeaders(secret.apiKey) }, secret.provider, 20_000);
    }
    return { ok: true, provider: secret.provider, model: secret.model, message: `${PROVIDER_NAMES[secret.provider]} accepted the saved key. No resume data was sent.` };
  }

  async function generate(secret, { instructions, input, maxOutputTokens = 7_500 }) {
    validateSecret(secret);
    const safeInput = String(input || "").slice(0, 180_000);
    const safeInstructions = String(instructions || "").slice(0, 30_000);
    let payload;
    if (secret.provider === "openrouter") {
      payload = await requestJson("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { ...bearer(secret.apiKey), "content-type": "application/json", "HTTP-Referer": "http://127.0.0.1", "X-Title": "ClearLead" },
        body: JSON.stringify({ model: secret.model, temperature: 0.1, max_tokens: maxOutputTokens, messages: [{ role: "system", content: safeInstructions }, { role: "user", content: safeInput }] }),
      }, secret.provider);
      return requiredText(payload?.choices?.[0]?.message?.content, secret.provider);
    }
    if (secret.provider === "openai") {
      payload = await requestJson("https://api.openai.com/v1/responses", {
        method: "POST", headers: { ...bearer(secret.apiKey), "content-type": "application/json" },
        body: JSON.stringify({ model: secret.model, instructions: safeInstructions, input: safeInput, max_output_tokens: maxOutputTokens, store: false }),
      }, secret.provider);
      const text = payload?.output_text || (payload?.output || []).flatMap((item) => item?.content || []).filter((item) => item?.type === "output_text").map((item) => item.text).join("\n");
      return requiredText(text, secret.provider);
    }
    payload = await requestJson("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { ...anthropicHeaders(secret.apiKey), "content-type": "application/json" },
      body: JSON.stringify({ model: secret.model, max_tokens: maxOutputTokens, system: safeInstructions, messages: [{ role: "user", content: safeInput }] }),
    }, secret.provider);
    return requiredText((payload?.content || []).filter((item) => item?.type === "text").map((item) => item.text).join("\n"), secret.provider);
  }

  return { testConnection, generate };
}

function bearer(apiKey) { return { authorization: `Bearer ${apiKey}`, accept: "application/json" }; }
function anthropicHeaders(apiKey) { return { "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" }; }
function validateSecret(secret) {
  if (!secret || !PROVIDER_NAMES[secret.provider] || !secret.apiKey || !secret.model) throw new Error("Configure an AI provider, model, and API key first.");
}
function requiredText(value, provider) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${PROVIDER_NAMES[provider]} returned no usable text. Try another model or retry.`);
  return text;
}
