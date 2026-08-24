const CLOSED_RE = /\b(position|role|job|posting)\s+(is\s+)?(closed|expired|filled|no longer available)|\bno longer accepting applications\b|\b404\b/i;
const BLOCKED_RE = /\bverify you are human\b|\bchecking your browser\b|\bcaptcha\b|\baccess denied\b|\bcloudflare\b/i;
const LIVE_RE = /\bapply( now| for this job)?\b|\bjob description\b|\bresponsibilities\b|\bqualifications\b/i;

/**
 * Check a public posting with evidence that can be shown back to the user.
 * `fetchFn` is injected so every outcome is tested locally without network I/O.
 */
export async function verifyPosting(url, { fetchFn = fetch, timeoutMs = 10_000, now = () => new Date() } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return outcome("inconclusive", { url, reason: "Enter a complete http(s) job URL.", checkedAt: now().toISOString() });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return outcome("inconclusive", { url, reason: "Only http(s) job URLs can be checked.", checkedAt: now().toISOString() });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(parsed, {
      redirect: "follow",
      headers: { "user-agent": "ClearLead/0.1 (+local liveness check)" },
      signal: controller.signal,
    });
    const html = (await response.text()).slice(0, 300_000);
    const evidence = compactText(html);
    const finalUrl = response.url || parsed.toString();
    if (BLOCKED_RE.test(evidence)) {
      return outcome("blocked", {
        url: parsed.toString(), finalUrl, httpStatus: response.status,
        reason: "The source presented a bot challenge or access block; open it in your browser to continue.",
        checkedAt: now().toISOString(),
      });
    }
    if (response.status === 404 || response.status === 410 || CLOSED_RE.test(evidence)) {
      return outcome("closed", {
        url: parsed.toString(), finalUrl, httpStatus: response.status,
        reason: response.status === 404 || response.status === 410 ? `Source returned HTTP ${response.status}.` : "Page explicitly says the role is closed or unavailable.",
        checkedAt: now().toISOString(),
      });
    }
    if (!response.ok) {
      return outcome("inconclusive", {
        url: parsed.toString(), finalUrl, httpStatus: response.status,
        reason: `Source returned HTTP ${response.status}; that is not enough evidence to call the role closed.`,
        checkedAt: now().toISOString(),
      });
    }
    if (LIVE_RE.test(evidence)) {
      return outcome("live", {
        url: parsed.toString(), finalUrl, httpStatus: response.status,
        reason: "Fetched a job-detail page with an apply or role-detail signal.",
        checkedAt: now().toISOString(),
      });
    }
    return outcome("inconclusive", {
      url: parsed.toString(), finalUrl, httpStatus: response.status,
      reason: "Page loaded, but no reliable job-detail or apply signal was found.",
      checkedAt: now().toISOString(),
    });
  } catch (error) {
    return outcome("inconclusive", {
      url: parsed.toString(),
      reason: error?.name === "AbortError" ? "Check timed out before the source answered." : "Source could not be reached from this machine.",
      checkedAt: now().toISOString(),
    });
  } finally {
    clearTimeout(timer);
  }
}

function compactText(html) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

function outcome(status, fields) {
  return { status, ...fields };
}
