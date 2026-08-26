# ClearLead

ClearLead is a local-first job-search tool that watches company publishing feeds, shows newly published matching roles, and verifies a posting before saving it.

It is intentionally evidence-first: discovery can call a role published, but only the verifier can call it live.

## Run

```bash
npm test
npm start
```

Open `http://localhost:4173`.

## Current workflow

1. Save target roles and optional location/must-have preferences locally.
2. Search up to 12 Greenhouse company boards at once. Eight validated boards are included as starters.
3. ClearLead deduplicates matches, records when each URL first appeared, and marks new roles on later scans.
4. Optional auto-refresh repeats the saved search every 2, 5, 15, or 30 minutes while the app is open.
5. Verify a source. Discovery never labels a role live by itself.
6. Save only a server-verified live role to the local review queue.

Greenhouse is the first source adapter. Lever and Ashby are next; each source will use the same published → verified → review contract.

The interface takes visual cues from [virobit.dev](https://virobit.dev): terminal typography, near-black panels, compact status signals, and restrained green/blue accents.

## Status model

- **Live** — the fetch reached a job page with an apply or job-detail signal.
- **Closed** — the response or page contains an explicit closed/expired signal.
- **Blocked** — the source presented an access challenge; open it yourself in a browser if you want to proceed.
- **Inconclusive** — the source could not be checked with confidence. You can retry, open it yourself, or discard it; it is never silently blocked.

The foundation and rebuild rules live in [POSTMORTEM.md](POSTMORTEM.md).
