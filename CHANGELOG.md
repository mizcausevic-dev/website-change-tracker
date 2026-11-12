# Changelog

## 1.0.0 (2026-11-12)

First release.

- REST API `/v1`: sources with a review lifecycle, snapshots, scored changes, async check runs, digests, webhooks, stats.
- Conventions: RFC 9457 problem details, cursor pagination with `Link` headers, ETags and 304s, `If-Match` on PATCH, `Idempotency-Key` on POST, 202 + `Location` for check runs, content negotiation, scoped API keys, rate-limit headers.
- Fetcher: robots.txt, conditional GET, SSRF guard at DNS-lookup time and for IP literals, redirect and size limits.
- Change detection: text extraction with noise masking, Myers line diff with word-level segments, explainable 0-100 significance score.
- Delivery: Standard Webhooks signatures with retries, daily email-safe digest.
- Dashboard, API reference and product brief with seven themes in light and dark.
- OpenAPI 3.1 document held to the router by contract tests.

## 1.0.1 (2026-11-12)

Pre-launch hardening from the appsec and supply-chain reviews: streaming 64 KB body limit, per-client proposal cap and expiry, check-run limits, table pruning, single rate-limit charge on `/v1`, idempotent webhook receiver, extra IPv6 SSRF forms, RFC 6750 token characters, Node 24.22.3, @hono/node-server 2.1.6, no package managers in the runtime image. Fixed the stats overview ETag, which never matched in production because the body embedded the request time.

## 1.0.2 (2026-11-12)

Security and correctness fixes found in a design review of proposed features.

- **ReDoS in ignore patterns (fixed).** Wildcards were compiled to `[^
]{0,400}?` and run on a backtracking regex engine; stacked wildcards were polynomial (`a*a*a*b` against one 2,000-character line ran for over 20 seconds). Earlier docs said this was ruled out; that was wrong. Patterns are now matched by a scanner with a per-page work budget. Not reachable on the public demo, which has no approver key, but reachable on any deployment where a proposal can be approved.
- **Quadratic built-in noise filters (fixed).** The opaque-token and engagement-counter filters were quadratic on hostile page text (about 2 to 3 ms per 2,000-character line). Both are now linear.
- **Phantom changes after editing extraction rules (fixed).** Changing `selector`, `ignore_selectors` or `ignore_patterns` made the next check diff two snapshots produced by different rules and report a change (significance 31 in the reproduction), firing webhooks and reaching the digest. The next successful check now records a silent baseline.
- **Quadratic price-label extraction (fixed).** Trimming separators from the text before each price used an end-anchored regex that was quadratic on long separator runs (about 150 ms per hostile line; a 2 MB page did not finish in 100 s). It now reads a bounded window, trims with a loop, and keeps at most 100 facts per page.
- **Re-baseline race (fixed).** A PATCH landing while a check was in flight let the old-rules check clear the re-baseline flag and restore the HTTP validators the edit had cleared, bringing the phantom change back. A check now commits those fields only if the source revision is unchanged.
- Resending identical extraction rules no longer forces a re-baseline.
- Checks carry `warnings`: `ignore_patterns_budget_exceeded` and `selector_not_found`.
- Ignore patterns: a leading `*` reaches back up to 400 characters (as before); a Turkish dotted capital I no longer disables matching on its line. Behaviour change: a middle segment is taken at its earliest occurrence and is not retried when a later segment is out of range, which is what keeps matching linear.
- Databases created by earlier versions are migrated (new columns added); sources that use `ignore_patterns` re-baseline once because matching changed.
