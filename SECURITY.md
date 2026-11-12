# Security

## Reporting

Report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository. Please do not open a public issue.

## Threat model and controls

| Threat | Control | Where |
|---|---|---|
| SSRF: a caller asks the tracker to fetch `169.254.169.254`, `localhost`, or an internal name | URLs are validated at creation; at fetch time, DNS answers are checked inside the socket `lookup`, so the address validated is the address connected to (no DNS-rebinding gap). IP-literal hosts are checked separately because Node skips `lookup` for them. Only ports 80/443. Redirects re-validated and kept on the same site. | `src/core/ssrf.ts`, `src/core/fetcher.ts`, `test/fetcher.test.ts` |
| Fetching sources nobody approved | Proposals are created `pending`; only a key with `sources:approve` moves them to `approved`, and only approved sources are scheduled. External fetching is off unless `ALLOW_EXTERNAL_FETCH=true`. | `src/routes/sources.ts`, `src/core/transport.ts` |
| ReDoS through user-supplied patterns | `ignore_patterns` are literal text with `*` wildcards, compiled with bounded quantifiers. No user regex is ever evaluated. | `src/core/extract.ts` |
| Resource exhaustion from large or compressed responses | 2 MB cap measured after decompression, 10 s timeout, 64 KB request body cap. | `src/core/fetcher.ts`, `src/http/validate.ts` |
| Stolen database leaks credentials | API keys are stored as SHA-256 hashes. Webhook secrets are returned once at creation and never again. | `src/http/auth.ts`, `src/routes/activity.ts` |
| Key guessing, abuse | Token-bucket rate limits per key and client; failed authentication is limited separately per client. | `src/http/ratelimit.ts`, `src/http/middleware.ts` |
| Forged or replayed webhooks | Standard Webhooks HMAC-SHA256 signatures with a timestamp; receivers reject anything older than 5 minutes. Comparison is constant-time. | `src/core/webhooks.ts` |
| XSS in the dashboard | Strict CSP (`script-src 'self'`, no inline scripts), all API strings escaped before insertion, digest previews rendered in a sandboxed iframe. | `src/http/middleware.ts`, `public/assets/app.js` |
| Leaking internals in errors | Problem details only; stack traces are logged server-side with the request ID. | `src/app.ts` |

## Known limits

- Rate limits, idempotency keys and the scheduler live in one process. A multi-instance deployment needs a shared store for each.
- Webhook signing secrets are stored in plaintext in the database because they are needed to sign; production storage should encrypt them with a KMS key.
- The demo deployment keeps its database in memory and reseeds on restart.
