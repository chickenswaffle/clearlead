# ClearLead first live application

Use a real role you would genuinely apply to. ClearLead fills safe profile fields and tracks progress, but you remain responsible for legal answers, resume upload, review, and the final Submit click.

## Start

1. Run `npm run preflight`. Resolve every `BLOCK` before opening a job.
2. Run `npm start` and open `http://127.0.0.1:4173`.
3. Open `chrome://extensions`, find ClearLead Application Copilot, and click **Reload**. Confirm version **0.5.0**.
4. If the extension rejects its token, create a new pairing token in ClearLead and paste it into the extension.

## Complete one application

1. Run the saved DFW search and choose one role that passes the eligibility gate.
2. Verify the employer page. Continue only when ClearLead shows evidence-backed `live` status.
3. Choose **Make custom resume**. Review the content, then download the ATS-safe DOCX or polished PDF.
4. Choose **Use for this application** or **Prepare application**, then open the verified employer URL.
5. In the extension, choose **Fill safe fields**. Upload the reviewed resume yourself.
6. Resolve every amber, red, and blue field yourself. ClearLead never invents legal, demographic, salary, sponsorship, attestation, or free-text answers.
7. On Workday or SmartRecruiters, use the employer's Next/Continue control and repeat **Fill safe fields** on each step.
8. Choose **Check application status**. Continue only when it says the run is ready for final approval.
9. Review the entire employer page once, click Submit yourself, then choose **Check application status** on the confirmation page.

## Pass criteria

- The recommended role is genuinely eligible and relevant.
- The tailored resume contains no unsupported claim and downloads as both PDF and DOCX.
- ClearLead fills name/contact/location/profile links without changing existing answers.
- Sensitive, legal, free-text, radio, checkbox, and upload fields remain reviewable or manual.
- The run survives a ClearLead restart and resumes after employer-page revalidation.
- Completion is recorded only from confirmation-page evidence.

If anything fails, record the ATS family, employer URL, visible step name, and exact ClearLead message. Do not include passwords, answers, or demographic information in the report.
