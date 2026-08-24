# Why the previous project failed

This document is the binding starting point for the replacement. Do not recreate the old interface, workflow, or failure modes under a new name.

## Evidence from the retired project

1. AI-discovered leads were born permanently blocked. `web/src/lib/explore-ai.ts` hard-coded every AI result as `verification: "unconfirmed"`.
2. The UI made that state a dead end. `web/src/components/explore/discovery-card.tsx` replaced the Add and Evaluate controls with a static “Waiting for live posting verification” element.
3. The writer made the dead end permanent. `web/src/lib/core/pipeline.ts` discarded every lead whose verification value was not exactly `verified`.
4. Evaluation did not close the loop. `web/src/lib/run-prompts.mjs` told headless evaluation to use WebFetch and explicitly mark the report unconfirmed instead of performing the promised live browser check.
5. The product led with a dashboard before it had a dependable job workflow. It could display cards, status pills, analytics, AI configuration, and a pipeline while the essential action—turn a discovered role into a verified, reviewable lead—was impossible.
6. Runtime prerequisites were implicit. A selected Codex worker could fail because the local code-mode host was not installed at its expected path. The app surfaced downstream failures rather than a concrete readiness diagnosis.
7. Setup state was contradictory. The homepage could say “You’re all caught up” while the core doctor reported missing profile data required for meaningful matching.
8. The verifier lacked an honest state model. A bot challenge, a retryable fetch failure, an expired role, and an unconfigured worker did not get distinct actions or diagnostics.

## What to keep from comparable projects

| Source | Keep | Do not copy blindly |
| --- | --- | --- |
| JobSync | Structured profile/resume import, explicit confirmation before saves, scheduled API discovery, narrow assistant context | Account-first complexity and a dashboard as the primary task |
| CareerPulse | Multiple source adapters, per-domain retry/backoff, provider choice, local-first storage | Claims of broad scraping without source health evidence |
| JobNavigator | Browser capture as an opt-in input channel and reviewable autofill drafts | Auto-submission or browser automation presented as a default |

## Non-negotiable rebuild rules

1. The first screen is a workflow, not a dashboard: **find or paste a job → verify it → decide whether to save it**.
2. Every lead has one of four evidence-backed states: `live`, `closed`, `blocked`, or `inconclusive`. “Waiting” is not a state.
3. An inconclusive result always has a next action: retry, open the source, or discard. It is never silently blocked.
4. A lead may be saved only after a human confirms the displayed evidence. The tool never applies or submits.
5. Discovery source, check timestamp, HTTP result, final URL, and liveness rationale travel with every saved lead.
6. Profile completion is a visible prerequisite for matching. Missing data is never hidden behind optimistic copy.
7. Every adapter and integration must have a runnable local test using a live, closed, and inconclusive fixture before it appears in the UI.
8. Readiness checks must name the exact missing dependency and the repair command.
9. A new discovery source does not ship until it has a liveness fixture for a live page, closed page, bot challenge, and transient failure.

## First release acceptance test

From a fresh clone, a user can start one command, paste a job URL, see a precise liveness outcome with evidence, and explicitly save only a live lead. The local test suite covers all three outcomes without any third-party account, model key, or dashboard setup.
