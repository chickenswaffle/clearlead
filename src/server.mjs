import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.mjs";
import { verifyPosting } from "./verify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = createStore(path.join(root, "data"));
const port = Number(process.env.PORT || 4173);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") return sendFile(res, path.join(root, "public", "index.html"), "text/html");
    if (req.method === "GET" && url.pathname === "/app.js") return sendFile(res, path.join(root, "public", "app.js"), "text/javascript");
    if (req.method === "GET" && url.pathname === "/api/leads") return json(res, 200, { leads: store.leads(), profile: store.profile() });
    if (req.method === "POST" && url.pathname === "/api/verify") {
      const { url: jobUrl } = await body(req);
      return json(res, 200, await verifyPosting(jobUrl || ""));
    }
    if (req.method === "POST" && url.pathname === "/api/leads") {
      const lead = await body(req);
      return json(res, 200, store.saveLiveLead(lead));
    }
    if (req.method === "POST" && url.pathname === "/api/profile") {
      const profile = await body(req);
      store.saveProfile({ targetRoles: strings(profile.targetRoles), locations: strings(profile.locations) });
      return json(res, 200, { ok: true, profile: store.profile() });
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : "Request failed" });
  }
});

server.listen(port, () => console.log(`ClearLead listening on http://localhost:${port}`));

function strings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []; }
function json(res, status, value) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
function sendFile(res, file, type) { res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(fs.readFileSync(file)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ""; req.on("data", (part) => { raw += part; }); req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON")); } }); req.on("error", reject); }); }
