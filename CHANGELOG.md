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
