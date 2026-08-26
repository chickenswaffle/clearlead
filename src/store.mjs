import fs from "node:fs";
import path from "node:path";
import { normalizeProfile } from "./profile.mjs";
import { normalizeSearchConfig } from "./search.mjs";

export function createStore(dataDir) {
  const leadsPath = path.join(dataDir, "leads.json");
  const profilePath = path.join(dataDir, "profile.json");
  const searchConfigPath = path.join(dataDir, "search-config.json");
  const searchStatePath = path.join(dataDir, "search-state.json");

  function read(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return fallback;
      throw new Error(`ClearLead could not read ${path.basename(file)}. The file was left untouched.`);
    }
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
    searchConfig: () => normalizeSearchConfig(read(searchConfigPath, {})),
    saveSearchConfig(config) {
      const normalized = normalizeSearchConfig(config);
      write(searchConfigPath, normalized);
      return normalized;
    },
    searchStatus() {
      const state = read(searchStatePath, { seen: {}, lastRunAt: null });
      return { lastRunAt: state.lastRunAt || null, seenCount: Object.keys(state.seen || {}).length };
    },
    recordSearch(jobs, searchedAt = new Date().toISOString()) {
      const state = read(searchStatePath, { seen: {}, lastRunAt: null });
      const seen = state.seen && typeof state.seen === "object" ? state.seen : {};
      const hasBaseline = Boolean(state.lastRunAt);
      const annotated = jobs.map((job) => {
        const previous = normalizeSeenEntry(seen[job.url]);
        const firstSeenAt = previous?.firstSeenAt || searchedAt;
        const isNew = hasBaseline && !previous;
        seen[job.url] = { firstSeenAt, lastSeenAt: searchedAt };
        return { ...job, isNew, firstSeenAt };
      });
      const recentSeen = Object.fromEntries(Object.entries(seen)
        .sort(([, left], [, right]) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)))
        .slice(0, 10_000));
      write(searchStatePath, { seen: recentSeen, lastRunAt: searchedAt });
      return annotated;
    },
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

function normalizeSeenEntry(value) {
  if (typeof value === "string") return { firstSeenAt: value, lastSeenAt: value };
  if (value && typeof value === "object" && value.firstSeenAt) {
    return { firstSeenAt: value.firstSeenAt, lastSeenAt: value.lastSeenAt || value.firstSeenAt };
  }
  return null;
}

function isHttpUrl(value) {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}
