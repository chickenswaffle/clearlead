# ClearLead

ClearLead is a local-first job-search control room built around one reliable action: verify a role before saving it.

It is intentionally not a dashboard. Paste a job URL, inspect the evidence, then explicitly save only live roles.

## Run

```bash
npm test
npm start
```

Open `http://localhost:4173`.

## Status model

- **Live** — the fetch reached a job page with an apply or job-detail signal.
- **Closed** — the response or page contains an explicit closed/expired signal.
- **Blocked** — the source presented an access challenge; open it yourself in a browser if you want to proceed.
- **Inconclusive** — the source could not be checked with confidence. You can retry, open it yourself, or discard it; it is never silently blocked.

The foundation and rebuild rules live in [POSTMORTEM.md](POSTMORTEM.md).
