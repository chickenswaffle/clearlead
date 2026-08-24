# Replacement project rules

Read `POSTMORTEM.md` before changing product behavior.

- Never show an inert “waiting for verification” state. Every uncertain outcome needs a user action.
- Never call a lead live without recording the check evidence.
- Do not add a dashboard, analytics, AI integration, or browser extension before the paste → verify → save path is proven by automated tests.
- The application never submits job applications.
- Preserve local-first data in `data/`; do not send a CV or profile to a provider by default.
