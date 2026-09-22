# ClearLead accelerated build plan

ClearLead is becoming a high-intent application agent: it should reject jobs that are not worth the candidate's time, build a claim-safe tailored resume, and complete supported ATS applications up to one final approval.

This is an execution plan, not a long product rewrite. Each slice must leave the local app usable and must pass the complete test suite.

## Current progress

- [x] Search-first release: broad-market discovery is the default, with source coverage shown honestly
- [x] Search result intelligence: direct-apply preference, application friction, confidence, and fit reasons
- [x] Official ZipRecruiter search adapter with explicit rate-limit/error handling
- [ ] Search-to-tailor-to-application guided path verified end to end
- [x] Hard eligibility gate with coded rejection reasons
- [x] Live-search rejection diagnostics
- [x] Candidate truth schema v1 with immutable metric tokens and answer review boundaries
- [x] ATS detection and field maps for Workday, Greenhouse, Lever, Ashby, and SmartRecruiters
- [x] Greenhouse application-step reader and controlled field runner
- [x] Lever and Ashby application-step readers and controlled field runners
- [x] Claim-preserving resume rewrite audit with source-line provenance
- [x] ATS-safe DOCX output
- [x] Workday and SmartRecruiters multi-page readers and controlled field runners
- [x] Persistent application run log with final-review and completion evidence
- [x] Restart-safe resume/retry controls and single final approval UX
- [x] One-command dogfood preflight and first-live-application checklist

## Release contract

- Never recommend a role that fails a known hard eligibility rule.
- Every rejection and recommendation has machine-readable reasons.
- Every resume claim traces to candidate-provided evidence.
- Supported ATS flows complete all safe steps and stop once for final approval.
- Unknown legal, demographic, authorization, compensation, and attestation answers never get invented.
- No application is reported complete without recorded evidence from the employer page.

## Accelerated sequence

### Now — search-first release

- Make one plain-English search the primary entry point and keep pasted URLs as the fallback.
- Search broad public/employer-direct sources by default; treat hand-picked ATS boards as optional enrichment.
- Prefer an employer or ATS application URL when duplicate listings appear on aggregators.
- Rank on eligibility, role fit, resume evidence, geography, freshness, sector, and application friction.
- Show why each result ranked, how confident ClearLead is, and whether the application path is direct.
- Integrate job boards only through supported public/partner interfaces. Indeed and Glassdoor remain visibly partner-gated until credentials/approval exist; do not scrape them or imply coverage.
- Carry a selected result directly into verification, tailored-resume generation, and the resumable ATS runner.

Exit gate: a candidate can describe a target once, receive a deduplicated ranked pool with honest source health, and take a verified role into the guided application flow without pasting its URL.

### Day 0–1 — eligibility gate

- Reject stale roles and special programs the candidate has not shown eligibility for.
- Enforce entry-level seniority and required-sector constraints.
- Detect active-clearance requirements and compare them with candidate evidence.
- Record rejection codes, explanations, and aggregate search diagnostics.
- Prove the gate with unit, search, and live-regression tests.

Exit gate: clearly ineligible roles never reach verification or application preparation.

### Day 1–3 — candidate truth model and strategic tailoring

- Parse employment, education, certifications, skills, metrics, and reusable answers into a versioned local truth record.
- Extract required and preferred job qualifications into a requirement matrix.
- Permit claim-preserving rewrites with source-fact provenance and a visible diff.
- Produce ATS-safe DOCX and PDF artifacts.

Exit gate: every generated claim is supported, and the tailored document materially changes positioning rather than merely reordering bullets.

### Day 3–5 — first application runner

- Introduce an ATS adapter contract with navigation, field mapping, validation, attachment, and completion evidence.
- Implement Greenhouse, Lever, and Ashby first.
- Store reusable answers and ask only for unknown or sensitive decisions.
- Stop once at a review-and-submit boundary.

Exit gate: at least 90% of safe fields complete on fixtures and controlled live dry runs for all three ATS families.

### Day 5–7 — difficult ATS coverage

- Add Workday and SmartRecruiters adapters.
- Add multi-page recovery, expired-session handling, and per-step evidence logs.
- Add application status and retry/resume support.

Exit gate: an interrupted application can resume without duplicating answers or losing the selected resume.

### Day 7–10 — dogfood and private beta

- Complete 25–50 reviewed applications across the five supported ATS families.
- Measure eligibility false positives, field completion, completion failures, user-attention time, and recruiter responses.
- Package the existing local service as a signed/notarized macOS control plane only after the browser workflow is dependable.

Exit gate: under 5% clearly ineligible recommendations, at least 85% safe-field completion, at least 90% supported-flow completion, zero unsupported resume claims, and under 60 seconds of candidate attention per application.

## What stays

- Evidence-backed liveness verification
- Local encrypted credential vault
- Source adapters and deduplication
- Claim provenance and audit tests
- Local PDF generation

## What changes

- Lexical scoring becomes eligibility first, evidence fit second.
- The resume becomes structured candidate truth, not one mutable text blob.
- Generic DOM autofill becomes tested ATS adapters.
- “Application handoff” becomes a resumable application run with a single final approval.
