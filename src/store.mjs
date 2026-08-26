import fs from "node:fs";
import path from "node:path";
import { normalizeProfile } from "./profile.mjs";
import { normalizeSearchConfig } from "./search.mjs";
import { normalizeResume } from "./resume.mjs";

export function createStore(dataDir) {
  const leadsPath = path.join(dataDir, "leads.json");
  const profilePath = path.join(dataDir, "profile.json");
  const searchConfigPath = path.join(dataDir, "search-config.json");
  const searchStatePath = path.join(dataDir, "search-state.json");
  const resumePath = path.join(dataDir, "resume.json");
  const tailoredPath = path.join(dataDir, "tailored");
  const kitsPath = path.join(dataDir, "kits");

  function read(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return fallback;
      throw new Error(`ClearLead could not read ${path.basename(file)}. The file was left untouched.`);
    }
  }
  function write(file, value) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    withFileLock(lock, () => {
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        const descriptor = fs.openSync(temporary, "wx", 0o600);
        try {
          fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n");
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        fs.renameSync(temporary, file);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    });
  }

  return {
    resume: () => normalizeResume(read(resumePath, {})),
    saveResume(resume) {
      const normalized = normalizeResume(resume);
      if (!normalized.ready) throw new Error("Resume text is too short. Paste the complete resume before continuing.");
      write(resumePath, normalized);
      return normalized;
    },
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
    saveTailoredDraft(job, draft) {
      const id = crypto.randomUUID();
      fs.mkdirSync(tailoredPath, { recursive: true });
      const filename = `${slug(job.company)}-${slug(job.title)}-${id}.md`;
      const file = path.join(tailoredPath, filename);
      fs.writeFileSync(file, draft.markdown, { encoding: "utf8", mode: 0o600 });
      return { id, filename, file, downloadUrl: `/api/tailored/${id}`, createdAt: new Date().toISOString(), ...draft };
    },
    tailoredFile(id) {
      if (!/^[a-f0-9-]{36}$/i.test(String(id || ""))) return null;
      if (!fs.existsSync(tailoredPath)) return null;
      const suffix = `-${String(id)}.md`;
      const filename = fs.readdirSync(tailoredPath).find((name) => name.endsWith(suffix));
      if (!filename) return null;
      return { filename, file: path.join(tailoredPath, filename) };
    },
    saveApplicationKit(job, kit) {
      const id = crypto.randomUUID();
      const directory = path.join(kitsPath, id);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const files = {};
      for (const [artifact, content] of Object.entries(kit.files || {})) {
        if (!/^(resume|fit-report|cover-letter|interview-prep|claim-audit)$/.test(artifact)) continue;
        const extension = artifact === "claim-audit" ? "json" : "md";
        const filename = `${slug(job.company)}-${slug(job.title)}-${artifact}.${extension}`;
        const file = path.join(directory, filename);
        const descriptor = fs.openSync(file, "wx", 0o600);
        try {
          fs.writeFileSync(descriptor, String(content), "utf8");
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        files[artifact] = { filename, file, downloadUrl: `/api/kits/${id}/${artifact}` };
      }
      return { ...kit, id, createdAt: new Date().toISOString(), files };
    },
    applicationKitFile(id, artifact) {
      if (!/^[a-f0-9-]{36}$/i.test(String(id || ""))) return null;
      if (!/^(resume|fit-report|cover-letter|interview-prep|claim-audit)$/.test(String(artifact || ""))) return null;
      const directory = path.join(kitsPath, String(id));
      if (!fs.existsSync(directory)) return null;
      const suffix = `-${artifact}.${artifact === "claim-audit" ? "json" : "md"}`;
      const filename = fs.readdirSync(directory).find((name) => name.endsWith(suffix));
      if (!filename) return null;
      return { filename, file: path.join(directory, filename), type: artifact === "claim-audit" ? "application/json" : "text/markdown" };
    },
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

function slug(value) {
  return String(value || "role").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "role";
}

function withFileLock(lock, action) {
  const deadline = Date.now() + 2_000;
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw new Error(`ClearLead could not acquire the ${path.basename(lock)} write lock.`);
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`ClearLead could not acquire the ${path.basename(lock)} write lock.`);
      sleepSync(10);
    }
  }
  try {
    fs.writeFileSync(descriptor, `${process.pid}\n`);
    return action();
  } finally {
    fs.closeSync(descriptor);
    try { fs.unlinkSync(lock); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
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
