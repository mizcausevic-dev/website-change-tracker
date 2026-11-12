import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { DEMO_KEY } from '../src/http/auth.ts';
import { harness, type Harness } from './helpers.ts';

type J = Record<string, any>;
const json = async (r: Response): Promise<J> => (await r.json()) as J;

let h: Harness;
before(async () => {
  h = await harness({ days: 10 });
});

describe('authentication and authorization', () => {
  it('401s without a key, with a Bearer challenge and problem+json', async () => {
    const r = await h.req('GET', '/v1/sources', { key: null });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('content-type')!, /application\/problem\+json/);
    assert.match(r.headers.get('www-authenticate')!, /^Bearer realm="driftline"/);
    const p = await json(r);
    assert.equal(p.status, 401);
    assert.match(p.type, /problems\.md#unauthenticated$/);
    assert.ok(p.request_id);
  });

  it('401s with error="invalid_token" for an unknown key', async () => {
    const r = await h.req('GET', '/v1/sources', { key: 'wct_live_not_a_real_key_000000' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate')!, /error="invalid_token"/);
  });

  it('403s with the missing scope when the demo key tries to edit', async () => {
    const r = await h.req('POST', '/v1/webhooks', { key: DEMO_KEY, body: { url: 'https://example.com/h', events: ['digest.ready'] } });
    assert.equal(r.status, 403);
    assert.equal((await json(r)).required_scope, 'webhooks:manage');
    assert.match(r.headers.get('www-authenticate')!, /error="insufficient_scope", scope="webhooks:manage"/);
  });

  it('serves the API root and OpenAPI document without a key', async () => {
    assert.equal((await h.req('GET', '/v1', { key: null })).status, 200);
    const spec = await json(await h.req('GET', '/v1/openapi.json', { key: null }));
    assert.equal(spec.openapi, '3.1.0');
  });
});

describe('collections, pagination and conditional requests', () => {
  it('walks every page with cursors, no duplicates, with Link headers', async () => {
    const seen: string[] = [];
    let url: string | null = '/v1/sources?limit=3';
    let pages = 0;
    while (url) {
      const r = await h.req('GET', url);
      assert.equal(r.status, 200);
      const body = await json(r);
      seen.push(...body.data.map((s: J) => s.id));
      if (body.page.has_more) {
        assert.match(r.headers.get('link')!, /<http:\/\/test\.local\/v1\/sources\?.*cursor=.*>; rel="next"/);
        url = new URL(body.links.next).pathname + new URL(body.links.next).search;
      } else url = null;
      pages++;
    }
    assert.equal(seen.length, 10);
    assert.equal(new Set(seen).size, 10);
    assert.equal(pages, 4);
    assert.deepEqual([...seen].sort().reverse(), seen, 'newest first');
  });

  it('rejects a forged cursor with 400', async () => {
    const r = await h.req('GET', '/v1/sources?cursor=bm90LWEtY3Vyc29y');
    assert.equal(r.status, 400);
    assert.equal((await json(r)).errors[0].field, 'cursor');
  });

  it('returns 304 for If-None-Match with the current ETag', async () => {
    const r1 = await h.req('GET', '/v1/stats/overview');
    const etag = r1.headers.get('etag')!;
    assert.ok(etag);
    const r2 = await h.req('GET', '/v1/stats/overview', { headers: { 'if-none-match': etag } });
    assert.equal(r2.status, 304);
    assert.equal(await r2.text(), '');
    assert.equal(r2.headers.get('etag'), etag);
  });

  it('filters changes by category and significance', async () => {
    const body = await json(await h.req('GET', '/v1/changes?category=pricing&min_significance=50&limit=100'));
    assert.ok(body.data.length > 0);
    assert.ok(body.data.every((c: J) => c.category === 'pricing' && c.significance >= 50 && c.meaningful));
  });

  it('400s on an invalid enum query parameter', async () => {
    const r = await h.req('GET', '/v1/changes?category=gossip');
    assert.equal(r.status, 400);
  });
});

describe('source lifecycle', () => {
  let id = '';
  let etag = '';

  it('creates a proposal as pending with 201, Location and ETag', async () => {
    const r = await h.req('POST', '/v1/sources', { key: DEMO_KEY, body: { url: 'https://Docs.Example.com/pricing#plans', name: 'Docs pricing', tags: ['pricing'] } });
    assert.equal(r.status, 201);
    const s = await json(r);
    assert.equal(s.status, 'pending');
    assert.equal(s.url, 'https://docs.example.com/pricing', 'host lowercased, fragment dropped');
    assert.equal(r.headers.get('location'), `http://test.local/v1/sources/${s.id}`);
    id = s.id;
  });

  it('409s on a duplicate URL and points at the existing source', async () => {
    const r = await h.req('POST', '/v1/sources', { body: { url: 'https://docs.example.com/pricing', name: 'dup' } });
    assert.equal(r.status, 409);
    assert.equal((await json(r)).existing.id, id);
  });

  it('422s with per-field errors, including unknown fields and SSRF targets', async () => {
    const r = await h.req('POST', '/v1/sources', { body: { url: 'http://169.254.169.254/latest/meta-data', name: '', min_signficance: 5, check_interval_minutes: 1 } });
    assert.equal(r.status, 422);
    const fields = (await json(r)).errors.map((e: J) => e.field).sort();
    assert.deepEqual(fields, ['check_interval_minutes', 'min_signficance', 'name', 'url']);
    for (const bad of ['http://localhost/x', 'http://10.0.0.5/', 'http://[::1]/', 'ftp://example.com/', 'https://user:pw@example.com/', 'https://example.com:8443/']) {
      const res = await h.req('POST', '/v1/sources', { body: { url: bad, name: 'x' } });
      assert.equal(res.status, 422, bad);
    }
  });

  it('415s for a non-JSON body and 400s for malformed JSON', async () => {
    assert.equal((await h.req('POST', '/v1/sources', { raw: 'url=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await h.req('POST', '/v1/sources', { raw: '{"url":', headers: { 'content-type': 'application/json' } })).status, 400);
  });

  it('PATCH requires If-Match (428), rejects stale ETags (412), and needs merge-patch (415)', async () => {
    const g = await h.req('GET', `/v1/sources/${id}`);
    etag = g.headers.get('etag')!;
    assert.equal((await h.req('PATCH', `/v1/sources/${id}`, { raw: '{"name":"x"}', headers: { 'content-type': 'application/merge-patch+json' } })).status, 428);
    assert.equal((await h.req('PATCH', `/v1/sources/${id}`, { raw: '{"name":"x"}', headers: { 'content-type': 'application/merge-patch+json', 'if-match': '"stale"' } })).status, 412);
    const r415 = await h.req('PATCH', `/v1/sources/${id}`, { body: { name: 'x' }, headers: { 'if-match': etag } });
    assert.equal(r415.status, 415);
    assert.equal(r415.headers.get('accept-patch'), 'application/merge-patch+json');
  });

  it('PATCH applies a merge patch and bumps the revision; status is read-only', async () => {
    const r = await h.req('PATCH', `/v1/sources/${id}`, { raw: JSON.stringify({ min_significance: 35, notes: null }), headers: { 'content-type': 'application/merge-patch+json', 'if-match': etag } });
    assert.equal(r.status, 200);
    const s = await json(r);
    assert.equal(s.min_significance, 35);
    assert.equal(s.revision, 2);
    assert.notEqual(r.headers.get('etag'), etag);
    const ro = await h.req('PATCH', `/v1/sources/${id}`, { raw: '{"status":"approved"}', headers: { 'content-type': 'application/merge-patch+json', 'if-match': r.headers.get('etag')! } });
    assert.equal(ro.status, 422);
  });

  it('enforces the review state machine', async () => {
    assert.equal((await h.req('POST', `/v1/sources/${id}/approve`, { key: DEMO_KEY })).status, 403, 'demo key cannot approve');
    assert.equal((await h.req('POST', `/v1/sources/${id}/reject`, { body: {} })).status, 422, 'reject requires a note');
    assert.equal((await h.req('POST', `/v1/sources/${id}/resume`)).status, 409);
    const ok = await json(await h.req('POST', `/v1/sources/${id}/approve`, { body: { note: 'Public pricing page; allowed.' } }));
    assert.equal(ok.status, 'approved');
    assert.equal(ok.review.reviewed_by, 'Test admin');
    const again = await h.req('POST', `/v1/sources/${id}/approve`);
    assert.equal(again.status, 409);
    assert.deepEqual((await json(again)).allowed_actions, ['pause']);
  });

  it('deletes with 204 and then 404s', async () => {
    assert.equal((await h.req('DELETE', `/v1/sources/${id}`)).status, 204);
    assert.equal((await h.req('GET', `/v1/sources/${id}`)).status, 404);
  });
});

describe('idempotency', () => {
  it('replays the first response for the same key and body', async () => {
    const body = { url: 'https://idem.example.org/page', name: 'Idem' };
    const r1 = await h.req('POST', '/v1/sources', { body, headers: { 'idempotency-key': 'abc-123' } });
    const r2 = await h.req('POST', '/v1/sources', { body, headers: { 'idempotency-key': 'abc-123' } });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r2.headers.get('idempotent-replayed'), 'true');
    assert.equal((await json(r1)).id, (await json(r2)).id);
  });

  it('422s when the key is reused with a different body', async () => {
    const r = await h.req('POST', '/v1/sources', { body: { url: 'https://idem.example.org/other', name: 'Other' }, headers: { 'idempotency-key': 'abc-123' } });
    assert.equal(r.status, 422);
    assert.match((await json(r)).type, /idempotency-key-reused/);
  });
});

describe('async check runs, changes, digests and webhooks', () => {
  it('runs checks asynchronously: 202 + Location, then poll to completion', async () => {
    const pending = (await json(await h.req('GET', '/v1/sources?status=pending'))).data.find((s: J) => s.url.includes('vireo'));
    await h.req('POST', `/v1/sources/${pending.id}/approve`);
    const r = await h.req('POST', '/v1/check-runs', { key: DEMO_KEY, body: { source_ids: [pending.id] } });
    assert.equal(r.status, 202);
    assert.equal(r.headers.get('retry-after'), '1');
    const run = await json(r);
    assert.equal(run.status, 'queued');
    await h.ctx.runPromises.get(run.id);
    const done = await json(await h.req('GET', new URL(r.headers.get('location')!).pathname));
    assert.equal(done.status, 'succeeded');
    assert.equal(done.results[0].outcome, 'baseline');
  });

  it('negotiates change representations: JSON, unified diff, or 406', async () => {
    const list = await json(await h.req('GET', '/v1/changes?limit=1'));
    const id = list.data[0].id;
    const j = await json(await h.req('GET', `/v1/changes/${id}`));
    assert.ok(Array.isArray(j.hunks) && j.hunks.length > 0);
    const d = await h.req('GET', `/v1/changes/${id}`, { headers: { accept: 'text/x-diff' } });
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-type')!, /^text\/x-diff/);
    assert.match(await d.text(), /^--- .*\n\+\+\+ .*\n@@ /);
    assert.equal(d.headers.get('vary'), 'Accept');
    assert.equal((await h.req('GET', `/v1/changes/${id}`, { headers: { accept: 'image/png' } })).status, 406);
  });

  it('serves digests as JSON, email HTML and text; refuses duplicate periods', async () => {
    const list = await json(await h.req('GET', '/v1/digests?limit=1'));
    const d = list.data[0];
    const html = await h.req('GET', `/v1/digests/${d.id}`, { headers: { accept: 'text/html' } });
    assert.match(await html.text(), /Driftline daily digest/);
    const dup = await h.req('POST', '/v1/digests', { body: { period_start: d.period_start, period_end: d.period_end } });
    assert.equal(dup.status, 409);
    const fresh = await h.req('POST', '/v1/digests', { body: { period_start: '2026-11-05T00:00:00Z', period_end: '2026-11-12T00:00:00Z', send: false } });
    assert.equal(fresh.status, 201);
    assert.ok((await json(fresh)).payload.totals.meaningful > 0);
    assert.equal((await h.req('POST', '/v1/digests', { body: { period_start: '2026-11-12T00:00:00Z', period_end: '2026-11-01T00:00:00Z' } })).status, 422);
  });

  it('signs webhook deliveries that the demo receiver verifies', async () => {
    const hooks = await json(await h.req('GET', '/v1/webhooks'));
    const demo = hooks.data.find((w: J) => w.url.includes('receiver.example'));
    assert.ok(demo);
    assert.equal(demo.secret, undefined, 'secret is never returned after creation');
    await h.req('POST', '/v1/digests', { body: { period_start: '2026-10-01T00:00:00Z', period_end: '2026-10-08T00:00:00Z' } });
    await new Promise((r) => setTimeout(r, 20));
    const deliveries = await json(await h.req('GET', `/v1/webhooks/${demo.id}/deliveries`));
    const digest = deliveries.data.find((d: J) => d.event_type === 'digest.ready');
    assert.equal(digest.status, 'succeeded');
    assert.equal(digest.last_response_status, 204);
    assert.ok(h.ctx.receiver.received.some((e) => e.event_type === 'digest.ready' && e.verified));
  });

  it('returns the webhook secret exactly once, at creation', async () => {
    const r = await h.req('POST', '/v1/webhooks', { body: { url: 'https://hooks.example.net/driftline', events: ['change.detected'] } });
    assert.equal(r.status, 201);
    const w = await json(r);
    assert.match(w.secret, /^whsec_/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await json(await h.req('GET', `/v1/webhooks/${w.id}`))).secret, undefined);
    assert.equal((await h.req('POST', '/v1/webhooks', { body: { url: 'http://hooks.example.net/x', events: ['change.detected'] } })).status, 422, 'https only');
  });
});

describe('rate limiting and hardening', () => {
  it('429s past the per-key limit with Retry-After and RateLimit headers', async () => {
    const key = h.keyWith(['sources:read'], 'tiny', 3);
    for (let i = 0; i < 3; i++) {
      const r = await h.req('GET', '/v1/sources?limit=1', { key });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('ratelimit-limit'), '3');
    }
    const r = await h.req('GET', '/v1/sources?limit=1', { key });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal(r.headers.get('ratelimit-remaining'), '0');
  });

  it('sets security headers and a strict CSP on API responses', async () => {
    const r = await h.req('GET', '/v1/sources?limit=1');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
    assert.ok(r.headers.get('x-request-id'));
  });

  it('echoes a well-formed X-Request-Id and ignores a malformed one', async () => {
    const ok = await h.req('GET', '/v1', { key: null, headers: { 'x-request-id': 'trace-12345678' } });
    assert.equal(ok.headers.get('x-request-id'), 'trace-12345678');
    const bad = await h.req('GET', '/v1', { key: null, headers: { 'x-request-id': 'bad id; <script>' } });
    assert.match(bad.headers.get('x-request-id')!, /^[0-9a-f-]{36}$/, 'replaced with a generated UUID');
  });

  it('answers unknown routes with a 404 problem', async () => {
    const r = await h.req('GET', '/v1/nope');
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-type')!, /problem\+json/);
  });

  it('answers CORS preflight for the API', async () => {
    const r = await h.req('OPTIONS', '/v1/sources', { key: null, headers: { origin: 'https://app.example.com', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization,if-match' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('access-control-allow-methods')!, /PATCH/);
  });
});
