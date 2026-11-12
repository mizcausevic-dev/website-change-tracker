# Problem types

Every error response is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem document served as `application/problem+json`. The `type` field links to a heading on this page. Clients should branch on `type`; `title` and `detail` are for people.

Every problem also carries `instance` (the request path) and `request_id` (matches the `X-Request-Id` response header and the server log line).

## invalid-parameter
`400`. A query parameter is malformed or out of range, for example `limit=500` or an unknown `category`. `errors[]` names the parameter.

## malformed-json
`400`. The body is not valid JSON. `detail` carries the parser message.

## invalid-idempotency-key
`400`. `Idempotency-Key` must be 1 to 255 characters.

## unauthenticated
`401`. No API key, a malformed `Authorization` header, or an unknown key. The response includes `WWW-Authenticate: Bearer realm="driftline"` with `error="invalid_token"` or `error="invalid_request"` when applicable (RFC 6750).

## insufficient-scope
`403`. The key is valid but lacks the scope the operation needs. `required_scope` names it, and `WWW-Authenticate` carries `error="insufficient_scope", scope="…"`.

## not-found
`404`. The resource does not exist, or the route does not exist.

## not-acceptable
`406`. The `Accept` header lists no representation this resource offers. `available` lists the media types that are offered.

## duplicate-source
`409`. A source with the same normalized URL already exists. `existing.href` points to it.

## review-queue-full
`409`. Too many sources are already awaiting review. Approve or reject some first.

## invalid-transition
`409`. The source's current status does not allow this action (for example approving an approved source). `allowed_actions` lists what is allowed.

## digest-exists
`409`. A digest for exactly this period already exists. `existing.href` points to it.

## idempotency-in-progress
`409`. An earlier request with the same `Idempotency-Key` is still running. Retry after `Retry-After` seconds.

## precondition-failed
`412`. `If-Match` does not match the current ETag: the resource changed since you read it. Re-fetch, re-apply your change, and retry. `current_etag` is included.

## payload-too-large
`413`. Request bodies are limited to 64 KB.

## unsupported-media-type
`415`. Wrong `Content-Type`. Creation endpoints take `application/json`; `PATCH` takes `application/merge-patch+json` (advertised in `Accept-Patch`).

## validation-error
`422`. The body parsed but failed validation. `errors[]` lists each field and message. Unknown fields are reported as errors rather than ignored.

## idempotency-key-reused
`422`. The `Idempotency-Key` was already used with a different request body or path. Use a new key.

## precondition-required
`428`. `PATCH` requires `If-Match` so concurrent edits are not silently lost.

## rate-limited
`429`. Too many requests for this key and client. Wait `Retry-After` seconds. `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` describe the bucket.

## internal-error
`500`. An unexpected server error. The stack trace is logged with the `request_id`; it is never returned to the client.
