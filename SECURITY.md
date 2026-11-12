# Security

## Reporting

Report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository. Please do not open a public issue.

## Threat model and controls

| Threat | Control | Where |
|---|---|---|
| SSRF: a caller asks the tracker to fetch `169.254.169.254`, `localhost`, or an internal name | URLs are validated at creation; at fetch time, DNS answers are checked inside the socket `lookup`, so the address validated is the address connected to (no DNS-rebinding gap). IP-literal hosts are checked separately because Node skips `lookup` for them. Only ports 80/443. Redirects re-validated and kept on the same site. | `src/core/ssrf.ts`, `src/core/fetcher.ts`, `test/fetcher.test.ts` |
| Fetching sources nobody approved | Proposals are created `pending`; only a key with `sources:approve` moves them to `approved`, and only approved sources are scheduled. External fetching is off unless `ALLOW_EXTERNAL_FETCH=true`. | `src/routes/sources.ts`, `src/core/transport.ts` |
| Catastrophic backtracking (ReDoS) from patterns or page text | `ignore_patterns` are literal text with `*` wildcards, matched by a scanner (`indexOf` in bounded windows) with a 20M-character work budget per page; past the budget, patterns stop applying and the check records an `ignore_patterns_budget_exceeded` warning (visible in `GET /v1/sources/{id}/checks`). Built-in noise filters use bounded quantifiers only, and price-label extraction reads a bounded window and keeps at most 100 facts per page. Fixed in 1.0.2: earlier versions compiled wildcards to a backtracking regex that `a*a*a*b` could stall for over 20 s, and two built-in filters were quadratic on hostile page text. | `src/core/extract.ts`, `test/core.test.ts` |
| Resource exhaustion from large or compressed responses | 2 MB cap measured after decompression, 10 s timeout, 64 KB request body cap. | `src/core/fetcher.ts`, `src/http/validate.ts` |
| Stolen database leaks credentials | API keys are stored as SHA-256 hashes. Webhook secrets are returned once at creation and never again. | `src/http/auth.ts`, `src/routes/activity.ts` |
| Memory exhaustion from large bodies | 64 KB cap enforced while streaming (chunked bodies are cut off, not buffered), before any middleware reads the body. Anonymous requests get no idempotency storage. | `src/app.ts`, `test/hardening.test.ts` |
| One visitor degrading the shared demo | Proposal-only keys may hold 3 pending proposals per client; visitor proposals expire after 30 minutes; check runs are limited per client and per key, and a source checked in the last minute is skipped; operational tables are pruned. | `src/routes/sources.ts`, `src/core/scheduler.ts` |
| Key guessing, abuse | Token-bucket rate limits per key and client; failed authentication is limited separately per client. | `src/http/ratelimit.ts`, `src/http/middleware.ts` |
| Forged or replayed webhooks | Standard Webhooks HMAC-SHA256 signatures with a timestamp; receivers reject anything older than 5 minutes. Comparison is constant-time. | `src/core/webhooks.ts` |
| XSS in the dashboard | Strict CSP (`script-src 'self'`, no inline scripts), all API strings escaped before insertion, digest previews rendered in a sandboxed iframe. | `src/http/middleware.ts`, `public/assets/app.js` |
| Leaking internals in errors | Problem details only; stack traces are logged server-side with the request ID. | `src/app.ts` |

## Known limits

- Rate limits, idempotency keys and the scheduler live in one process. A multi-instance deployment needs a shared store for each.
- Webhook signing secrets are stored in plaintext in the database because they are needed to sign; production storage should encrypt them with a KMS key.
- The demo deployment keeps its database in memory and reseeds on restart.
