import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { enqueueEvent, matchesFilter, type ChangeEventData } from '../src/core/webhooks.ts';
import { DEMO_KEY } from '../src/http/auth.ts';
import { csvCell } from '../src/routes/activity.ts';
import { harness, type Harness } from './helpers.ts';

type J = Record<string, any>;
const json = async (r: Response): Promise<J> => (await r.json()) as J;

let h: Harness;
before(async () => {
  h = await harness({ days: 10 });
});
const sourceId = async (q: string): Promise<string> => (await json(await h.req('GET', `/v1/sources?q=${q}`))).data[0].id;
const event = (over: Partial<ChangeEventData>): ChangeEventData => ({
  change_id: 'chg_X', source_id: 'src_A', source_name: 'A', url: 'https://a.example/', significance: 30, category: 'pricing',
  summary: 's', meaningful: true, tags: [], links: { self: 'x' }, ...over,
});

describe('webhook subscription filters', () => {
  it('keeps the old rule without a filter, and lets min_significance replace it', () => {
    assert.equal(matchesFilter({}, event({ meaningful: false, significance: 12 })), false, 'unfiltered: meaningful only');
    assert.equal(matchesFilter({}, event({ meaningful: true })), true);
    assert.equal(matchesFilter({ min_significance: 0 }, event({ meaningful: false, significance: 3 })), true, 'legal can take every edit');
    assert.equal(matchesFilter({ min_significance: 50 }, event({ meaningful: true, significance: 40 })), false);
    assert.equal(matchesFilter({ categories: ['status'] }, event({ category: 'pricing' })), false);
    assert.equal(matchesFilter({ tags: ['vendor', 'legal'] }, event({ tags: ['legal'] })), true, 'any listed tag matches');
    assert.equal(matchesFilter({ source_ids: ['src_B'] }, event({})), false);
  });

  it('routes a minor legal edit only to the subscription that asked for it', async () => {
    const r = await h.req('POST', '/v1/webhooks', { body: { url: 'https://hooks.example.net/legal', events: ['change.detected'], filter: { min_significance: 0, categories: ['legal'] } } });
    assert.equal(r.status, 201);
    const legal = await json(r);
    assert.deepEqual(legal.filter, { min_significance: 0, categories: ['legal'] });
    const count = (id: string) => (h.ctx.db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE webhook_id = ?').get(id) as { n: number }).n;
    const demo = (await json(await h.req('GET', '/v1/webhooks'))).data.find((w: J) => w.url.includes('receiver.example'));
    const before = { legal: count(legal.id), demo: count(demo.id) };
    enqueueEvent(h.ctx.db, h.clock.now(), 'change.detected', event({ category: 'legal', meaningful: false, significance: 6 }));
    assert.equal(count(legal.id), before.legal + 1);
    assert.equal(count(demo.id), before.demo, 'the unfiltered demo hook ignores minor changes');
    enqueueEvent(h.ctx.db, h.clock.now(), 'change.detected', event({ category: 'pricing', meaningful: true, significance: 80 }));
    assert.equal(count(legal.id), before.legal + 1, 'legal is not paged for pricing');
    assert.equal(count(demo.id), before.demo + 1);
  });

  it('validates filters field by field', async () => {
    const r = await h.req('POST', '/v1/webhooks', { body: { url: 'https://hooks.example.net/x', events: ['change.detected'], filter: { min_significance: 101, categories: ['gossip'], colour: 'red' } } });
    assert.equal(r.status, 422);
    assert.deepEqual((await json(r)).errors.map((e: J) => e.field).sort(), ['filter.categories', 'filter.colour', 'filter.min_significance']);
  });

  it('PATCHes with If-Match, merging the filter key by key', async () => {
    const created = await json(await h.req('POST', '/v1/webhooks', { body: { url: 'https://hooks.example.net/p', events: ['change.detected'], filter: { min_significance: 10, tags: ['vendor'] } } }));
    const mp = (body: unknown, etag?: string) => h.req('PATCH', `/v1/webhooks/${created.id}`, { raw: JSON.stringify(body), headers: { 'content-type': 'application/merge-patch+json', ...(etag ? { 'if-match': etag } : {}) } });
    assert.equal((await mp({ active: false })).status, 428);
    let etag = (await h.req('GET', `/v1/webhooks/${created.id}`)).headers.get('etag')!;
    const r1 = await mp({ filter: { tags: null, categories: ['legal'] }, active: false }, etag);
    assert.equal(r1.status, 200);
    const w1 = await json(r1);
    assert.deepEqual(w1.filter, { min_significance: 10, categories: ['legal'] });
    assert.equal(w1.active, false);
    assert.equal((await mp({ filter: null }, etag)).status, 412, 'the old ETag is stale now');
    etag = r1.headers.get('etag')!;
    assert.deepEqual((await json(await mp({ filter: null }, etag))).filter, {});
    assert.equal((await mp({ url: 'https://evil.example.net/' }, (await h.req('GET', `/v1/webhooks/${created.id}`)).headers.get('etag')!)).status, 422);
  });

  it('sends a signed test event that the receiver verifies', async () => {
    const demo = (await json(await h.req('GET', '/v1/webhooks'))).data.find((w: J) => w.url.includes('receiver.example'));
    const r = await h.req('POST', `/v1/webhooks/${demo.id}/test`);
    assert.equal(r.status, 201);
    const d = await json(r);
    assert.equal(d.event_type, 'webhook.test');
    assert.equal(d.status, 'succeeded');
    assert.equal(d.last_response_status, 204);
    assert.equal((await h.req('POST', `/v1/webhooks/${demo.id}/test`, { key: DEMO_KEY })).status, 403);
  });
});

describe('ignore-rule preview', () => {
  it('reports which past changes a pattern would have suppressed, with the read-only demo key', async () => {
    const id = await sourceId('kestrel');
    const r = await h.req('POST', `/v1/sources/${id}/ignore-preview`, { key: DEMO_KEY, body: { ignore_patterns: ['Rated 4.7 out of 5 from * reviews'] } });
    assert.equal(r.status, 200);
    const p = await json(r);
    assert.ok(p.changes_examined > 0);
    assert.ok(p.would_suppress > 0, 'review-count edits disappear');
    assert.ok(p.would_suppress < p.changes_examined, 'price and stock edits do not');
    for (const c of p.changes.filter((x: J) => x.suppressed)) assert.match(c.summary, /reviews/);
    assert.equal(p.budget_exhausted, false);
  });

  it('changes nothing and validates input', async () => {
    const id = await sourceId('kestrel');
    const before = (await json(await h.req('GET', `/v1/sources/${id}`))).revision;
    await h.req('POST', `/v1/sources/${id}/ignore-preview`, { key: DEMO_KEY, body: { ignore_patterns: ['Price*'] } });
    assert.equal((await json(await h.req('GET', `/v1/sources/${id}`))).revision, before);
    assert.equal((await h.req('POST', `/v1/sources/${id}/ignore-preview`, { key: DEMO_KEY, body: { ignore_patterns: ['**'] } })).status, 422);
    assert.equal((await h.req('POST', '/v1/sources/src_01M00000000000000000000000/ignore-preview', { key: DEMO_KEY, body: { ignore_patterns: ['x'] } })).status, 404);
  });
});

describe('feedback on the meaningful flag', () => {
  it('starts with no labels and reports null precision rather than a made-up number', async () => {
    const s = await json(await h.req('GET', '/v1/stats/overview'));
    assert.equal(s.feedback.labels, 0);
    assert.equal(s.feedback.precision, null);
  });

  it('creates with 201, replaces with 200, and feeds per-category precision', async () => {
    const changes = (await json(await h.req('GET', '/v1/changes?category=pricing&limit=2'))).data;
    const [a, b] = changes;
    const put = (id: string, verdict: string) => h.req('PUT', `/v1/changes/${id}/feedback`, { key: DEMO_KEY, body: { verdict } });
    const r1 = await put(a.id, 'not_meaningful');
    assert.equal(r1.status, 201);
    assert.equal((await json(r1)).agrees_with_flag, false);
    const r2 = await put(a.id, 'meaningful');
    assert.equal(r2.status, 200);
    assert.equal((await json(r2)).agrees_with_flag, true);
    await put(b.id, 'not_meaningful');
    const s = await json(await h.req('GET', '/v1/stats/overview'));
    assert.equal(s.feedback.labels, 2, 'one label per client per change');
    assert.equal(s.feedback.by_category.pricing.flagged_labels, 2);
    assert.equal(s.feedback.by_category.pricing.precision, 0.5);
    assert.equal((await json(await h.req('GET', `/v1/changes/${a.id}/feedback`, { key: DEMO_KEY }))).verdict, 'meaningful');
    assert.equal((await h.req('DELETE', `/v1/changes/${a.id}/feedback`, { key: DEMO_KEY })).status, 204);
    assert.equal((await h.req('GET', `/v1/changes/${a.id}/feedback`, { key: DEMO_KEY })).status, 404);
  });

  it('validates the verdict and requires the scope', async () => {
    const id = (await json(await h.req('GET', '/v1/changes?limit=1'))).data[0].id;
    assert.equal((await h.req('PUT', `/v1/changes/${id}/feedback`, { key: DEMO_KEY, body: { verdict: 'maybe' } })).status, 422);
    const readOnly = h.keyWith(['changes:read'], 'reader');
    assert.equal((await h.req('PUT', `/v1/changes/${id}/feedback`, { key: readOnly, body: { verdict: 'meaningful' } })).status, 403);
  });
});

describe('change history export', () => {
  it('serves CSV with a header row, quoted cells, and a Link to the next page', async () => {
    const r = await h.req('GET', '/v1/changes?limit=3&meaningful=any', { key: DEMO_KEY, headers: { accept: 'text/csv' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /^text\/csv/);
    assert.match(r.headers.get('content-disposition')!, /attachment; filename="driftline-changes-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.match(r.headers.get('link')!, /rel="next"/);
    const lines = (await r.text()).trimEnd().split('\r\n');
    assert.equal(lines[0], 'id,detected_at,source_id,source_name,url,category,significance,meaningful,summary,words_added,words_removed,fact_changes');
    assert.equal(lines.length, 4);
    assert.ok(lines.slice(1).every((l) => l.startsWith('"chg_')));
  });

  it('serves NDJSON, one change per line', async () => {
    const r = await h.req('GET', '/v1/changes?limit=5', { key: DEMO_KEY, headers: { accept: 'application/x-ndjson' } });
    assert.match(r.headers.get('content-type')!, /^application\/x-ndjson/);
    const rows = (await r.text()).trimEnd().split('\n').map((l) => JSON.parse(l) as J);
    assert.equal(rows.length, 5);
    assert.ok(rows.every((x) => x.object === 'change' && !('hunks' in x)));
  });

  it('neutralises spreadsheet formulas in cells', () => {
    assert.equal(csvCell('=HYPERLINK("http://evil.example","x")'), `"'=HYPERLINK(""http://evil.example"",""x"")"`);
    assert.equal(csvCell('-21.2% price cut'), `"'-21.2% price cut"`);
    assert.equal(csvCell('Plain text'), '"Plain text"');
  });

  it('allows large export pages, keeps JSON pages small, and enforces scope and Accept', async () => {
    assert.equal((await h.req('GET', '/v1/changes?limit=1000', { key: DEMO_KEY, headers: { accept: 'text/csv' } })).status, 200);
    assert.equal((await h.req('GET', '/v1/changes?limit=1000')).status, 400);
    assert.equal((await h.req('GET', '/v1/changes', { headers: { accept: 'image/png' } })).status, 406);
    const reader = h.keyWith(['changes:read'], 'csvless');
    assert.equal((await h.req('GET', '/v1/changes', { key: reader, headers: { accept: 'text/csv' } })).status, 403);
    assert.equal((await h.req('GET', '/v1/changes', { key: reader })).status, 200, 'JSON still works without the export scope');
  });
});

describe('1.1 security review regressions', () => {
  it('bounds a preview over large snapshots (whole-line work is now charged)', async () => {
    const id = await sourceId('larkspur');
    // Plant 2 MB snapshot texts, as a real deployment could store; the demo cannot reach this.
    h.ctx.db.prepare('UPDATE snapshots SET text = ? WHERE source_id = ?').run(Array.from({ length: 1000 }, () => 'g'.repeat(2000)).join('\n'), id);
    const t = performance.now();
    const r = await h.req('POST', `/v1/sources/${id}/ignore-preview`, { key: DEMO_KEY, body: { ignore_patterns: Array.from({ length: 20 }, (_, i) => `*nomatch${i}`) } });
    const ms = performance.now() - t;
    assert.equal(r.status, 200);
    assert.equal((await json(r)).budget_exhausted, true);
    assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
  });

  it('groups IPv6 clients by /64 and unwraps IPv4-mapped addresses', async () => {
    const { clientKey } = await import('../src/http/middleware.ts');
    assert.equal(clientKey('2001:db8:1:2:3:4:5:6'), clientKey('2001:db8:1:2::9'));
    assert.equal(clientKey('2001:db8:1:2::9'), '2001:db8:1:2::/64');
    assert.notEqual(clientKey('2001:db8:1:3::9'), clientKey('2001:db8:1:2::9'));
    assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  });

  it('neutralises formulas hidden behind whitespace or fullwidth characters', () => {
    for (const v of [' =1+1', ' =1+1', '　+1', '​@x', '＝1+1', '\n=1']) assert.ok(csvCell(v).startsWith(`"'`), JSON.stringify(v));
    assert.equal(csvCell('a = b'), '"a = b"');
  });

  it('caps labels per change', async () => {
    const id = (await json(await h.req('GET', '/v1/changes?limit=1&category=status'))).data[0].id;
    const ins = h.ctx.db.prepare(`INSERT INTO feedback (change_id, client_fp, verdict, created_at, updated_at) VALUES (?, ?, 'meaningful', 'x', 'x')`);
    for (let i = 0; i < 200; i++) ins.run(id, `fp${i}`);
    const r = await h.req('PUT', `/v1/changes/${id}/feedback`, { key: DEMO_KEY, body: { verdict: 'meaningful' } });
    assert.equal(r.status, 429);
    assert.match((await json(r)).type, /feedback-limit/);
  });

  it('rejects prototype keys in a merge-patched filter', async () => {
    const w = await json(await h.req('POST', '/v1/webhooks', { body: { url: 'https://hooks.example.net/proto', events: ['change.detected'] } }));
    const etag = (await h.req('GET', `/v1/webhooks/${w.id}`)).headers.get('etag')!;
    const r = await h.req('PATCH', `/v1/webhooks/${w.id}`, { raw: '{"filter":{"__proto__":{"bogus":1}}}', headers: { 'content-type': 'application/merge-patch+json', 'if-match': etag } });
    assert.equal(r.status, 422);
  });
});
