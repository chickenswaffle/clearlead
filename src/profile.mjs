const STOP_WORDS = new Set(["and", "the", "of", "for", "in", "to", "a", "an", "with"]);

export function normalizeProfile(input = {}) {
  return {
    targetRoles: cleanList(input.targetRoles),
    locations: cleanList(input.locations),
    mustHaves: cleanList(input.mustHaves),
  };
}

export function profileReadiness(profile) {
  const normalized = normalizeProfile(profile);
  const missing = [];
  if (normalized.targetRoles.length === 0) missing.push("target roles");

  return {
    ready: missing.length === 0,
    missing,
    message: missing.length === 0
      ? "Profile ready — relevance is based on your target roles."
      : "Add at least one target role to see relevance signals. You can still verify any URL.",
  };
}

export function roleRelevance(title, profile) {
  const targetTerms = normalizeProfile(profile).targetRoles.flatMap(words);
  const uniqueTerms = [...new Set(targetTerms)];
  if (uniqueTerms.length === 0) return null;

  const titleWords = new Set(words(title));
  const matched = uniqueTerms.filter((word) => titleWords.has(word));
  return {
    matched,
    totalTerms: uniqueTerms.length,
    score: Math.round((matched.length / uniqueTerms.length) * 100),
  };
}

function cleanList(value) {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [];

  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))].slice(0, 20);
}

function words(value) {
  return String(value)
    .toLowerCase()
    .match(/[a-z0-9+#.]{2,}/g)
    ?.filter((word) => !STOP_WORDS.has(word)) ?? [];
}
