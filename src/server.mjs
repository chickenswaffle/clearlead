import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.mjs";
import { verifyPosting } from "./verify.mjs";
import { discoverGreenhouse } from "./greenhouse.mjs";
import { profileReadiness, roleRelevance } from "./profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createAppServer({
  dataDir = path.join(root, "data"),
  verifyFn = verifyPosting,
  discoverFn = discoverGreenhouse,
} = {}) {
  const store = createStore(dataDir);
  const liveVerifications = new Map();

  return http.createServer(async (req, res) => {
    if (!isTrustedLocalRequest(req)) return json(res, 403, { error: "ClearLead only accepts requests from this local app." });
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/") return sendFile(res, path.join(root, "public", "index.html"), "text/html");
      if (req.method === "GET" && url.pathname === "/app.js") return sendFile(res, path.join(root, "public", "app.js"), "text/javascript");
      if (req.method === "GET" && url.pathname === "/api/leads") {
        const profile = store.profile();
        return json(res, 200, { leads: store.leads(), profile, readiness: profileReadiness(profile) });
      }
      if (req.method === "POST" && url.pathname === "/api/verify") {
        const { url: jobUrl } = await body(req);
        const verification = await verifyFn(jobUrl || "");
        if (verification.status !== "live") return json(res, 200, verification);
        const verificationId = randomUUID();
        pruneVerifications(liveVerifications);
        liveVerifications.set(verificationId, {
          lead: verification,
          expiresAt: Date.now() + 15 * 60 * 1000,
        });
        return json(res, 200, { ...verification, verificationId });
      }
      if (req.method === "POST" && url.pathname === "/api/leads") {
        const { verificationId } = await body(req);
        const verified = liveVerifications.get(verificationId);
        if (!verified || verified.expiresAt <= Date.now()) {
          liveVerifications.delete(verificationId);
          throw new Error("Run the live verifier again before saving this lead.");
        }
        const saved = store.saveLiveLead(verified.lead);
        liveVerifications.delete(verificationId);
        return json(res, 200, saved);
      }
      if (req.method === "POST" && url.pathname === "/api/profile") {
        const profile = await body(req);
        store.saveProfile({
          targetRoles: strings(profile.targetRoles),
          locations: strings(profile.locations),
          mustHaves: strings(profile.mustHaves),
        });
        const saved = store.profile();
        return json(res, 200, { ok: true, profile: saved, readiness: profileReadiness(saved) });
      }
      if (req.method === "POST" && url.pathname === "/api/discover/greenhouse") {
        const { board } = await body(req);
        const discovery = await discoverFn(board);
        const profile = store.profile();
        return json(res, 200, {
          ...discovery,
          jobs: discovery.jobs.map((job) => ({ ...job, relevance: roleRelevance(job.title, profile) })),
          readiness: profileReadiness(profile),
        });
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : "Request failed" });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const dataDir = process.env.CLEARLEAD_DATA_DIR
    ? path.resolve(process.env.CLEARLEAD_DATA_DIR)
    : path.join(root, "data");
  const server = createAppServer({ dataDir });
  server.listen(port, "127.0.0.1", () => console.log(`ClearLead listening on http://localhost:${server.address().port}`));
}

function strings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []; }
function isTrustedLocalRequest(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}
function pruneVerifications(verifications) {
  const now = Date.now();
  for (const [id, verification] of verifications) {
    if (verification.expiresAt <= now) verifications.delete(id);
  }
}
function json(res, status, value) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
function sendFile(res, file, type) { res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(fs.readFileSync(file)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ""; req.on("data", (part) => { raw += part; if (raw.length > 100_000) { reject(new Error("Request body is too large.")); req.destroy(); } }); req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON")); } }); req.on("error", reject); }); }
