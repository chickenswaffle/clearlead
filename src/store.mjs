import fs from "node:fs";
import path from "node:path";
import { normalizeProfile } from "./profile.mjs";

export function createStore(dataDir) {
  const leadsPath = path.join(dataDir, "leads.json");
  const profilePath = path.join(dataDir, "profile.json");

  function read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
  }
  function write(file, value) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
    fs.renameSync(temporary, file);
  }

  return {
    profile: () => normalizeProfile(read(profilePath, {})),
    saveProfile: (profile) => write(profilePath, normalizeProfile(profile)),
    leads: () => read(leadsPath, []),
    saveLiveLead(lead) {
      if (lead.status !== "live") throw new Error("Only live leads can be saved.");
      if (!isHttpUrl(lead.finalUrl || lead.url)) throw new Error("A verified http(s) source URL is required.");
      if (!lead.checkedAt || !lead.reason) throw new Error("Verification evidence is required.");
      const leads = read(leadsPath, []);
      if (leads.some((item) => item.finalUrl === lead.finalUrl)) return { saved: false, reason: "This live URL is already saved." };
      const saved = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), ...lead };
      leads.unshift(saved);
      write(leadsPath, leads);
      return { saved: true, lead: saved };
    },
  };
}

function isHttpUrl(value) {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}
