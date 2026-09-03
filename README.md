# ClearLead

ClearLead is a local-first job-search tool that indexes large public job sources, ranks postings from resume evidence, verifies the best matches, and creates grounded application kits.

It is intentionally evidence-first: discovery can call a role published, but only the verifier can call it live.

## Run

```bash
npm start
```

Open `http://localhost:4173`. The core paste → verify → save workflow starts without an account, resume, model key, or third-party setup.

For PDF resume upload and the complete test suite, install the locked dependency and check readiness:

```bash
npm ci
npm run doctor
npm test
```

The readiness check names each missing prerequisite and prints its exact repair command. Optional dependency problems never masquerade as a failed verification.

## Current workflow

1. Paste any public job URL, review its evidence-backed `live`, `closed`, `blocked`, or `inconclusive` outcome, and explicitly save only a live result.
2. Optionally paste a resume or load a PDF, plain-text, or Markdown file. PDF text is extracted in memory and shown for review; the upload is not persisted. Nothing becomes the saved resume until the user confirms **Index resume locally**. The browser state API returns only an extracted summary.
3. Search Greenhouse, Lever, and Ashby company boards plus the broad Public Job Ledger, Remotive, and Arbeitnow feeds. Starter source tokens are validated and configurable.
4. ClearLead normalizes and deduplicates the combined pool, then ranks each role with an explainable title/resume/location/sector/freshness breakdown.
5. The highest-ranked 5–20 roles can be verified automatically with at most three checks running concurrently. Discovery alone never labels a role live.
6. Review verification evidence and click **Save verified lead** before a role enters the local queue.
7. Create a local-only tailored Markdown resume for a verified-live role. This deterministic fallback reorders existing bullets and never calls a model.
8. Optionally add your own OpenRouter, OpenAI API, or Anthropic API key and model ID. Saving and testing the key sends no resume data. AI search is separately opt-in and sends only a compact skills/title index. An OpenAI API key is separate from a ChatGPT subscription.
9. After an explicit confirmation, build an AI application kit for one verified role: tailored resume, fit/skill-gap report, cover-letter draft, interview prep, and a machine-readable claim audit.
10. **Prepare application** creates a reviewable, exact-page safe-fill pack. It never submits an application.

## Application Copilot extension

ClearLead includes an unpacked Manifest V3 Chrome extension under `extension/`:

1. Open `chrome://extensions`, enable Developer mode, and load the `extension/` folder.
2. Save the Application Identity section in ClearLead.
3. Create a pairing token and paste it into the extension. ClearLead stores only the token hash.
4. If verification is blocked, open the source, complete its challenge yourself, wait for the posting to render, and choose **Verify current job page**. The compact evidence appears automatically in ClearLead.
5. For a verified ranked job, choose **Prepare application**.
6. Open the prepared application and choose **Fill safe fields** in the extension.

Browser-assisted verification sends only the current public URL, page title, navigation status, and detected evidence labels to the local server; it does not send page text, cookies, storage, or form contents. The extension fills only recognized candidate contact/location/public-link fields, never overwrites an existing answer, and only runs on the exact verified HTTPS page (including its job-specific query). Pairing expires, binds to one extension installation, and exchanges for a short-lived pack capability. Review-only fields are amber, sensitive/legal/third-party-contact fields are red and untouched, and manual file uploads are blue. The extension has no code path that clicks or invokes Submit.

## AI safety and local credentials

- API keys are kept out of browser storage and API responses. ClearLead stores one selected provider credential in a private AES-256-GCM vault under `data/`; both the encrypted vault and its machine-local key file are mode `0600` and ignored by Git.
- A resume and verified job description leave the machine only when the user confirms **Build AI kit**. ClearLead never submits, sends, or applies to a job.
- Job descriptions are treated as untrusted data. The model must attach resume line IDs to every candidate claim.
- The model may select and prioritize resume source-line IDs, but it is never trusted to author prose. Resume, fit, cover-letter evidence, and interview talking points use verbatim source lines; fit gaps, keywords, and questions are computed locally from the verified posting and resume. Any model-authored prose is rejected and recorded in `claim-audit.json`.
- Generated Markdown remains a draft for human review. The deterministic local tailor is always available when no key is configured or a model is unavailable.

The interface takes visual cues from [virobit.dev](https://virobit.dev): terminal typography, near-black panels, compact status signals, and restrained green/blue accents.

## Status model

- **Live** — the fetch reached a job page containing both an apply action and job-detail evidence.
- **Closed** — the response or page contains an explicit closed/expired signal.
- **Blocked** — the source presented an access challenge; complete it yourself, then use the paired extension to return rendered evidence to ClearLead.
- **Inconclusive** — the source could not be checked with confidence. You can retry, open it yourself, or discard it; it is never silently blocked.

The foundation and rebuild rules live in [POSTMORTEM.md](POSTMORTEM.md).
