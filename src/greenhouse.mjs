const BOARD_RE = /^[a-z0-9_-]{2,80}$/i;

export async function discoverGreenhouse(board, { fetchFn = fetch, limit = 200, timeoutMs = 10_000 } = {}) {
  const token = String(board || "").trim();
  if (!BOARD_RE.test(token)) {
    return { source: "greenhouse", board: token, jobs: [], error: "Enter a valid Greenhouse board token." };
  }

  const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      return {
        source: "greenhouse",
        board: token,
        jobs: [],
        error: `Greenhouse returned HTTP ${response.status}. Check the board token and retry.`,
      };
    }

    const payload = await response.json();
    const jobs = (Array.isArray(payload.jobs) ? payload.jobs : [])
      .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 500))
      .map((job) => ({
        source: "greenhouse",
        board: token,
        title: String(job.title || "Untitled role"),
        location: String(job.location?.name || "Location not listed"),
        url: String(job.absolute_url || ""),
        postedAt: job.updated_at || null,
      }))
      .filter((job) => isHttpUrl(job.url));

    return { source: "greenhouse", board: token, jobs, error: null };
  } catch (error) {
    return {
      source: "greenhouse",
      board: token,
      jobs: [],
      error: error?.name === "AbortError"
        ? "Greenhouse timed out. Retry or discard this discovery."
        : "Could not reach Greenhouse from this machine. Retry or discard this discovery.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function isHttpUrl(value) {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}
