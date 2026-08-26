# ClearLead

ClearLead is a local-first job-search tool that indexes large public job sources, ranks postings from resume evidence, verifies the best matches, and creates grounded tailored resume drafts.

It is intentionally evidence-first: discovery can call a role published, but only the verifier can call it live.

## Run

```bash
npm test
npm start
```

Open `http://localhost:4173`.

## Current workflow

1. Paste or load a plain-text/Markdown resume. Its raw text stays in the local data directory; the browser state API returns only an extracted summary.
2. Search Greenhouse, Lever, and Ashby company boards plus the broad Remotive and Arbeitnow feeds. Starter source tokens are validated and configurable.
3. ClearLead normalizes and deduplicates the combined pool, then ranks each role with an explainable title/resume/location/freshness breakdown.
4. The highest-ranked 5–20 roles can be verified automatically with at most three checks running concurrently. Discovery alone never labels a role live.
5. Save only a server-verified live role to the local review queue.
6. Create a tailored Markdown resume for a verified-live role. Tailoring changes emphasis by reordering existing resume bullets; job-description claims are never inserted into the resume.
7. Optional auto-refresh repeats the saved search every 2, 5, 15, or 30 minutes while the app is open. Broad feeds are cached according to their public API guidance.

The interface takes visual cues from [virobit.dev](https://virobit.dev): terminal typography, near-black panels, compact status signals, and restrained green/blue accents.

## Status model

- **Live** — the fetch reached a job page containing both an apply action and job-detail evidence.
- **Closed** — the response or page contains an explicit closed/expired signal.
- **Blocked** — the source presented an access challenge; open it yourself in a browser if you want to proceed.
- **Inconclusive** — the source could not be checked with confidence. You can retry, open it yourself, or discard it; it is never silently blocked.

The foundation and rebuild rules live in [POSTMORTEM.md](POSTMORTEM.md).
