# ClearLead first live application

Use a real role you would genuinely apply to. ClearLead fills safe profile fields, attaches the selected resume after your explicit approval, and tracks progress, but you remain responsible for legal answers, review, and the final Submit click.

## Start

1. Run `npm run preflight`. Resolve every `BLOCK` before opening a job.
2. Run `npm start` and open `http://127.0.0.1:4173`.
3. Open `chrome://extensions`, find ClearLead Application Copilot, and click **Reload**. Confirm version **0.9.0**.
4. If the extension rejects its token, create a new pairing token in ClearLead and paste it into the extension.

## Complete one application

1. Run the saved DFW search and choose one role that passes the eligibility gate.
2. Verify the employer page. Continue only when ClearLead shows evidence-backed `live` status.
3. Choose **Make custom resume**. Review the content, then download the ATS-safe DOCX or polished PDF.
4. Choose **Use for this application** or **Prepare application**, then open the verified employer URL.
5. If a job board sends you to a different employer/ATS site, open the actual form and choose **Bind current application page** once. Confirm only when the extension names the same company and role. Skip this step when the prepared URL is already the form.
6. Click the ClearLead extension icon to keep its Application Copilot side panel open beside the employer form.
7. Keep **Auto-fill each safe step** on. If a resume field is present, choose **Attach selected resume**, then confirm the correct filename appears on the employer page. Use **Fill safe fields now** only to rerun the current step manually.
8. Resolve every amber or red field yourself. ClearLead never invents legal, demographic, salary, sponsorship, attestation, or free-text answers.
9. On Workday or SmartRecruiters, use the employer's Next/Continue control. The side panel should detect and fill the next safe step without another click.
10. Choose **Check step**. Continue only when it says the run is ready for final approval.
11. Review the entire employer page once, click Submit yourself, then choose **Check step** on the confirmation page.

## Pass criteria

- The recommended role is genuinely eligible and relevant.
- The tailored resume contains no unsupported claim and downloads as both PDF and DOCX.
- ClearLead fills name/contact/location/profile links, confirmed exact-match answers, and saved relative start availability without changing existing answers; it attaches only the selected resume after an explicit click.
- Sensitive, legal, free-text, radio, and checkbox fields remain reviewable or manual.
- The run survives a ClearLead restart and resumes after employer-page revalidation.
- A board-to-employer handoff binds only after your confirmation and rejects unrelated or second-page binding attempts.
- Completion is recorded only from confirmation-page evidence.

If anything fails, record the ATS family, employer URL, visible step name, and exact ClearLead message. Do not include passwords, answers, or demographic information in the report.
