# ClearLead

ClearLead is a local-first job-search tool built around one reliable action: verify a role before saving it.

It is intentionally not a dashboard. Paste a job URL or discover published Greenhouse roles, inspect the evidence, then explicitly save only live roles.

## Run

```bash
npm test
npm start
```

Open `http://localhost:4173`.

## Current workflow

1. Save target roles and optional location/must-have preferences locally.
2. Paste any job URL, or enter a company Greenhouse board token to discover published roles.
3. Verify the source. Discovery never labels a role live by itself.
4. Save only a verified live role to the local review queue.

Greenhouse is the first source adapter. Lever and Ashby are next; each source will use the same published → verified → review contract.

## Status model

- **Live** — the fetch reached a job page with an apply or job-detail signal.
- **Closed** — the response or page contains an explicit closed/expired signal.
- **Blocked** — the source presented an access challenge; open it yourself in a browser if you want to proceed.
- **Inconclusive** — the source could not be checked with confidence. You can retry, open it yourself, or discard it; it is never silently blocked.

The foundation and rebuild rules live in [POSTMORTEM.md](POSTMORTEM.md).
