import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

const CLOSED_RE = /\b(position|role|job|posting)\s+(is\s+)?(closed|expired|filled|no longer available)|\bno longer accepting applications\b/i;
const BLOCKED_CHALLENGE_RE = /\bverify you are human\b|\bchecking your browser\b|\bcomplete (?:the )?captcha\b|\bcaptcha verification\b|\bg-recaptcha\b|\bhcaptcha\b|\bcf-turnstile\b|\bchallenge-platform\b/i;
const APPLY_LABEL_RE = /\b(?:apply(?: now| for this job)?|submit application|i['’]?m interested|start (?:your )?application)\b/i;
const DETAIL_SIGNALS = [
  ["job description", /\bjob description\b/i],
  ["responsibilities", /\bresponsibilities\b/i],
  ["qualifications", /\bqualifications\b/i],
  ["job schema", /["']@type["']\s*:\s*["']JobPosting["']/i],
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_RESPONSE_BYTES = 300_000;

/**
 * Check a public posting with evidence that can be shown back to the user.
 * Network dependencies are injected so every outcome is testable without I/O.
 */
export async function verifyPosting(url, {
  fetchFn,
  lookupFn = lookup,
  timeoutMs = 10_000,
  now = () => new Date(),
} = {}) {
  let current;
  try {
    current = new URL(url);
  } catch {
    return outcome("inconclusive", { url, reason: "Enter a complete http(s) job URL.", checkedAt: now().toISOString() });
  }
  if (!isHttp(current)) {
    return outcome("inconclusive", { url, reason: "Only http(s) job URLs can be checked.", checkedAt: now().toISOString() });
  }

  const originalUrl = current.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = fetchFn
        ? await checkedInjectedFetch(current, { fetchFn, lookupFn, signal: controller.signal })
        : await fetchPinnedPublic(current, { lookupFn, signal: controller.signal });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get("location");
      if (!location) break;
      if (redirects === 5) throw new Error("Too many redirects");
      current = new URL(location, current);
      if (!isHttp(current)) throw new UnsafeDestinationError();
    }

    const html = await response.text();
    const evidence = compactText(html);
    const finalUrl = current.toString();
    if (response.status === 401 || response.status === 403 || BLOCKED_CHALLENGE_RE.test(html) || BLOCKED_CHALLENGE_RE.test(evidence)) {
      return outcome("blocked", {
        url: originalUrl, finalUrl, httpStatus: response.status,
        reason: "The source presented a bot challenge or access block; open it in your browser to continue.",
        checkedAt: now().toISOString(), signals: ["access challenge"],
      });
    }
    if (response.status === 404 || response.status === 410 || CLOSED_RE.test(evidence)) {
      return outcome("closed", {
        url: originalUrl, finalUrl, httpStatus: response.status,
        reason: response.status === 404 || response.status === 410 ? `Source returned HTTP ${response.status}.` : "Page explicitly says the role is closed or unavailable.",
        checkedAt: now().toISOString(), signals: [response.status === 404 || response.status === 410 ? `HTTP ${response.status}` : "closed language"],
      });
    }
    if (!response.ok) {
      return outcome("inconclusive", {
        url: originalUrl, finalUrl, httpStatus: response.status,
        reason: `Source returned HTTP ${response.status}; that is not enough evidence to call the role closed.`,
        checkedAt: now().toISOString(), signals: [],
      });
    }

    const details = DETAIL_SIGNALS.filter(([, pattern]) => pattern.test(html) || pattern.test(evidence)).map(([name]) => name);
    const applyAction = hasApplyAction(html);
    if (applyAction && details.length > 0) {
      return outcome("live", {
        url: originalUrl, finalUrl, httpStatus: response.status,
        reason: `Live evidence: apply action + ${details.join(", ")}.`,
        checkedAt: now().toISOString(), signals: ["apply action", ...details],
      });
    }
    const workday = await workdayPostingEvidence(current, { fetchFn, lookupFn, signal: controller.signal }).catch(() => null);
    if (workday?.canApply && workday.posted) {
      const workdayDetails = [...new Set([...details, ...(workday.hasDescription ? ["job description"] : [])])];
      if (workdayDetails.length > 0) {
        return outcome("live", {
          url: originalUrl, finalUrl, httpStatus: response.status,
          reason: `Workday public job API confirms posted=true, canApply=true, and ${workdayDetails.join(", ")}.`,
          checkedAt: now().toISOString(), signals: ["apply action", ...workdayDetails],
          verificationMethod: "workday public job API",
        });
      }
    }
    return outcome("inconclusive", {
      url: originalUrl, finalUrl, httpStatus: response.status,
      reason: "Page loaded, but it did not contain both an apply action and job-detail evidence.",
      checkedAt: now().toISOString(), signals: [...(applyAction ? ["apply action"] : []), ...details],
    });
  } catch (error) {
    return outcome("inconclusive", {
      url: originalUrl,
      reason: error instanceof UnsafeDestinationError
        ? "Private, local, or reserved network destinations cannot be checked."
        : error?.name === "AbortError"
          ? "Check timed out before the source answered."
          : "Source could not be reached from this machine.",
      checkedAt: now().toISOString(), signals: [],
    });
  } finally {
    clearTimeout(timer);
  }
}

async function workdayPostingEvidence(url, { fetchFn, lookupFn, signal }) {
  const apiUrl = workdayApiUrl(url);
  if (!apiUrl) return null;
  const response = fetchFn
    ? await checkedInjectedFetch(apiUrl, { fetchFn, lookupFn, signal, accept: "application/json" })
    : await fetchPinnedPublic(apiUrl, { lookupFn, signal, accept: "application/json" });
  if (!response.ok) return null;
  const payload = JSON.parse(await response.text());
  const posting = payload?.jobPostingInfo;
  if (!posting || typeof posting !== "object") return null;
  const postingId = String(posting.jobPostingId || "").trim();
  const requestedPath = decodeURIComponent(url.pathname).toLowerCase();
  if (!postingId || !requestedPath.includes(postingId.toLowerCase())) return null;
  return {
    canApply: posting.canApply === true,
    posted: posting.posted === true,
    hasDescription: compactText(String(posting.jobDescription || "")).length >= 40,
  };
}

function workdayApiUrl(url) {
  const hostMatch = url.hostname.toLowerCase().match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/);
  if (!hostMatch) return null;
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const jobIndex = parts.findIndex((part) => part.toLowerCase() === "job");
  if (jobIndex < 1 || jobIndex === parts.length - 1) return null;
  const site = parts[jobIndex - 1];
  const jobPath = parts.slice(jobIndex + 1);
  const encoded = ["wday", "cxs", hostMatch[1], site, "job", ...jobPath].map(encodeURIComponent).join("/");
  return new URL(`/${encoded}`, url.origin);
}

async function assertPublicDestination(url, lookupFn) {
  await publicAddresses(url, lookupFn);
}

async function publicAddresses(url, lookupFn) {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new UnsafeDestinationError();
  }

  const literalFamily = isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookupFn(hostname, { all: true, verbatim: true });
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new UnsafeDestinationError();
  }
  return addresses;
}

async function checkedInjectedFetch(url, { fetchFn, lookupFn, signal, accept = "text/html,application/xhtml+xml" }) {
  await assertPublicDestination(url, lookupFn);
  return fetchFn(url, {
    redirect: "manual",
    headers: { accept, "user-agent": "ClearLead/0.1 (+local liveness check)" },
    signal,
  });
}

async function fetchPinnedPublic(url, { lookupFn, signal, accept = "text/html,application/xhtml+xml" }) {
  const [destination] = await publicAddresses(url, lookupFn);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = transport.request({
      protocol: url.protocol,
      hostname: destination.address,
      family: destination.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: isIP(url.hostname) ? undefined : url.hostname,
      headers: {
        host: url.host,
        accept,
        "accept-encoding": "identity",
        "user-agent": "ClearLead/0.1 (+local liveness check)",
      },
      signal,
    }, (response) => {
      const chunks = [];
      let size = 0;
      const complete = () => finish(resolve, responseValue(response, Buffer.concat(chunks).toString("utf8")));
      response.on("data", (chunk) => {
        const remaining = MAX_RESPONSE_BYTES - size;
        if (remaining <= 0) return;
        const selected = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(selected);
        size += selected.length;
        if (size >= MAX_RESPONSE_BYTES) {
          complete();
          response.destroy();
        }
      });
      response.on("end", complete);
      response.on("error", (error) => finish(reject, error));
    });
    request.on("error", (error) => finish(reject, error));
    request.end();
  });
}

function responseValue(response, body) {
  const status = response.statusCode || 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const value = response.headers[String(name).toLowerCase()];
        return Array.isArray(value) ? value[0] : value ?? null;
      },
    },
    text: async () => body,
  };
}

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return !(normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89abcdef]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8:") || normalized.startsWith("::ffff:"));
  }
  return false;
}

function isHttp(url) {
  return /^https?:$/.test(url.protocol);
}

function compactText(html) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

function hasApplyAction(html) {
  const interactive = String(html || "").match(/<(?:a|button)\b[^>]*>[\s\S]*?<\/(?:a|button)>/gi) || [];
  if (interactive.some((element) => usableControl(element) && (APPLY_LABEL_RE.test(compactText(element)) || APPLY_LABEL_RE.test(attributeLabel(element))))) return true;
  const inputs = String(html || "").match(/<input\b[^>]*>/gi) || [];
  return inputs.some((element) => usableControl(element) && APPLY_LABEL_RE.test(attributeLabel(element)));
}

function usableControl(element) {
  const opening = String(element).match(/^<[^>]+>/)?.[0] || "";
  if (/\s(?:disabled|hidden)(?:\s|=|>)/i.test(opening) || /\baria-(?:disabled|hidden)\s*=\s*(["'])?true\1/i.test(opening) || /\bstyle\s*=\s*(["'])[^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*\1/i.test(opening)) return false;
  const classes = opening.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2]?.split(/\s+/) || [];
  if (classes.some((value) => /^(?:hidden|invisible|d-none|sr-only|visually-hidden)$/i.test(value))) return false;
  if (/^<a\b/i.test(opening)) {
    const href = opening.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]?.trim();
    if (!href || /^(?:#$|javascript:|data:)/i.test(href)) return false;
  }
  return !/^<input\b[^>]*\btype\s*=\s*(["'])?hidden\1/i.test(opening);
}

function attributeLabel(element) {
  return [...String(element).matchAll(/\b(?:aria-label|title|value)\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]).join(" ");
}

function outcome(status, fields) {
  return { status, ...fields };
}

class UnsafeDestinationError extends Error {}
