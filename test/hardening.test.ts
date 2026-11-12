import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { checkSource, getSourceRow } from '../src/core/pipeline.ts';
import { isPublicAddress } from '../src/core/ssrf.ts';
import { sign } from '../src/core/webhooks.ts';
import { openDb } from '../src/db.ts';
import { DEMO_KEY } from '../src/http/auth.ts';
import { harness, type Harness } from './helpers.ts';

/** Regression tests for the pre-launch security review findings. */
let h: Harness;
before(async () => {
  h = await harness({ days: 3 });
});

describe('request body limits', () => {
  it('stops reading an oversized chunked body early and answers 413', async () => {
    // The risk is memory, not the status code: an earlier version also answered 413, but only after
    // buffering the whole body. Count how much of a 20 MB lazy stream actually gets pulled.
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    const total = 20 * 1024 * 1024;
    let pulled = 0;
    const stream = new ReadableStream({
      pull(ctrl) {
        if (pulled >= total) return ctrl.close();
        pulled += chunk.length;
        ctrl.enqueue(chunk);
      },
    });
    const r = await h.app.request('http://test.local/v1/sources', {
      method: 'POST',
      headers: { authorization: `Bearer ${DEMO_KEY}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    assert.equal(r.status, 413);
    assert.match(r.headers.get('content-type')!, /problem\+json/);
    assert.ok(pulled < 1024 * 1024, `read ${pulled} bytes of a ${total}-byte body`);
  });

  it('rejects an oversized declared Content-Length before reading', async () => {
    const r = await h.req('POST', '/v1/sources', { raw: 'x'.repeat(70 * 1024), headers: { 'content-type': 'application/json', 'content-length': String(70 * 1024) } });
    assert.equal(r.status, 413);
  });
});

describe('shared demo key abuse', () => {
  it('caps pending proposals per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await h.req('POST', '/v1/sources', { key: DEMO_KEY, body: { url: `https://cap${i}.example.org/`, name: `cap ${i}` } });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [201, 201, 201, 429]);
  });

  it('charges one rate-limit token per request on /v1', async () => {
    const key = h.keyWith(['sources:read'], 'counter', 50);
    const a = Number((await h.req('GET', '/v1', { key })).headers.get('ratelimit-remaining'));
    const b = Number((await h.req('GET', '/v1', { key })).headers.get('ratelimit-remaining'));
    assert.equal(a - b, 1);
  });

  it('does not store idempotency records for anonymous requests', async () => {
    await h.req('POST', '/v1', { key: null, raw: '{}', headers: { 'content-type': 'application/json', 'idempotency-key': 'anon-1' } });
    const r = await h.req('POST', '/v1', { key: null, raw: '{}', headers: { 'content-type': 'application/json', 'idempotency-key': 'anon-1' } });
    assert.equal(r.headers.get('idempotent-replayed'), null);
  });
});

describe('conditional requests over time', () => {
  it('answers 304 for the stats overview when time passes but no data changed', async () => {
    // Regression: the body once embedded the request time, so its ETag never matched in production
    // (the frozen test clock hid it). Move the clock and expect the ETag to hold.
    const r1 = await h.req('GET', '/v1/stats/overview', { key: DEMO_KEY });
    h.clock.advance(5_000);
    const r2 = await h.req('GET', '/v1/stats/overview', { key: DEMO_KEY, headers: { 'if-none-match': r1.headers.get('etag')! } });
    assert.equal(r2.status, 304);
  });
});

describe('editing extraction rules', () => {
  it('re-baselines silently instead of recording a phantom change', async () => {
    // Regression: changing ignore rules on an unchanged page produced a "meaningful" change
    // (significance 31 on Tessellate), which also fired webhooks and reached the digest.
    const src = (await (await h.req('GET', '/v1/sources?q=tessellate')).json() as { data: Array<{ id: string }> }).data[0]!;
    h.clock.advance(60_000);
    assert.equal((await checkSource(h.ctx, getSourceRow(h.ctx, src.id)!)).outcome, 'unchanged');
    const g = await h.req('GET', `/v1/sources/${src.id}`);
    const p = await h.req('PATCH', `/v1/sources/${src.id}`, {
      raw: JSON.stringify({ ignore_patterns: ['Limits apply per API key*'] }),
      headers: { 'content-type': 'application/merge-patch+json', 'if-match': g.headers.get('etag')! },
    });
    assert.equal(p.status, 200);
    const changesBefore = (h.ctx.db.prepare('SELECT COUNT(*) AS n FROM changes WHERE source_id = ?').get(src.id) as { n: number }).n;
    h.clock.advance(60_000);
    const first = await checkSource(h.ctx, getSourceRow(h.ctx, src.id)!);
    assert.equal(first.outcome, 'baseline');
    assert.equal(first.change_id, null);
    const changesAfter = (h.ctx.db.prepare('SELECT COUNT(*) AS n FROM changes WHERE source_id = ?').get(src.id) as { n: number }).n;
    assert.equal(changesAfter, changesBefore);
    assert.equal(getSourceRow(h.ctx, src.id)!.rebaseline_pending, 0, 'the flag is consumed after one baseline');
    h.clock.advance(60_000);
    // Tessellate honours ETags, so an unchanged page now answers 304.
    assert.ok(['unchanged', 'not_modified'].includes((await checkSource(h.ctx, getSourceRow(h.ctx, src.id)!)).outcome));
  });
});

describe('extraction rule edits: races, no-op edits, warnings', () => {
  const sourceId = async (q: string) => ((await (await h.req('GET', `/v1/sources?q=${q}`)).json()) as { data: Array<{ id: string }> }).data[0]!.id;
  const patch = async (id: string, body: unknown) => {
    const g = await h.req('GET', `/v1/sources/${id}`);
    return h.req('PATCH', `/v1/sources/${id}`, { raw: JSON.stringify(body), headers: { 'content-type': 'application/merge-patch+json', 'if-match': g.headers.get('etag')! } });
  };

  it('keeps the re-baseline when a PATCH lands while a check is in flight', async () => {
    const id = await sourceId('quarry');
    h.clock.advance(120_000);
    const stale = getSourceRow(h.ctx, id)!; // loaded before the edit, as checkSource does
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = h.ctx.fetcher;
    h.ctx.fetcher = { fetchPage: async (...a: Parameters<typeof real.fetchPage>) => { await gate; return real.fetchPage(...a); } } as typeof real;
    const inFlight = checkSource(h.ctx, stale);
    assert.equal((await patch(id, { ignore_patterns: ['We retain account data*closure'] })).status, 200);
    release();
    await inFlight;
    h.ctx.fetcher = real;
    const row = getSourceRow(h.ctx, id)!;
    assert.equal(row.rebaseline_pending, 1, 'the stale check must not consume the flag');
    assert.equal(row.http_etag, null, 'nor restore the validators the edit cleared');
    h.clock.advance(60_000);
    assert.equal((await checkSource(h.ctx, getSourceRow(h.ctx, id)!)).outcome, 'baseline');
  });

  it('does not re-baseline when a PATCH resends identical rules', async () => {
    const id = await sourceId('larkspur');
    const current = (await (await h.req('GET', `/v1/sources/${id}`)).json()) as { ignore_selectors: string[] };
    assert.equal((await patch(id, { ignore_selectors: current.ignore_selectors })).status, 200);
    assert.equal(getSourceRow(h.ctx, id)!.rebaseline_pending, 0);
  });

  it('reports a selector that matched nothing as a check warning', async () => {
    const id = await sourceId('kestrel');
    assert.equal((await patch(id, { selector: '#does-not-exist' })).status, 200);
    h.clock.advance(60_000);
    await checkSource(h.ctx, getSourceRow(h.ctx, id)!);
    const checks = (await (await h.req('GET', `/v1/sources/${id}/checks?limit=1`)).json()) as { data: Array<{ warnings: string[] }> };
    assert.deepEqual(checks.data[0]!.warnings, ['selector_not_found']);
  });
});

describe('schema migration', () => {
  it('adds new columns to a database created by an earlier version', () => {
    const file = path.join(os.tmpdir(), `driftline-migrate-${process.pid}-${Date.now()}.db`);
    try {
      let db = openDb(file);
      db.exec('ALTER TABLE sources DROP COLUMN rebaseline_pending; ALTER TABLE sources DROP COLUMN proposer_fp; ALTER TABLE checks DROP COLUMN warnings;');
      db.prepare(`INSERT INTO sources (id, url, name, status, ignore_patterns, check_interval_minutes, min_significance, proposed_by, created_at, updated_at)
                  VALUES ('src_01M00000000000000000000000', 'https://a.example/', 'a', 'approved', '["x*y"]', 60, 20, 't', 'now', 'now')`).run();
      db.close();
      db = openDb(file);
      const row = db.prepare('SELECT rebaseline_pending, proposer_fp FROM sources').get() as { rebaseline_pending: number; proposer_fp: string | null };
      assert.equal(row.rebaseline_pending, 1, 'sources with ignore_patterns re-baseline after the matcher change');
      assert.ok((db.prepare('PRAGMA table_info(checks)').all() as Array<{ name: string }>).some((c) => c.name === 'warnings'));
      db.close();
    } finally {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    }
  });
});

describe('ssrf address forms', () => {
  for (const ip of ['::7f00:1', '::127.0.0.1', '::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe']) {
    it(`blocks ${ip}`, () => assert.equal(isPublicAddress(ip), false));
  }
});

describe('auth token characters', () => {
  it('accepts standard base64 keys (+ / =)', async () => {
    const r = await h.req('GET', '/v1/sources?limit=1', { key: 'wct+test/key+with/base64chars==' });
    assert.equal(r.status, 401, 'well-formed but unknown: invalid_token, not invalid_request');
    assert.match(r.headers.get('www-authenticate')!, /invalid_token/);
  });
});

describe('demo webhook receiver', () => {
  it('acknowledges a replayed delivery without counting it twice', async () => {
    const secret = h.ctx.receiver.secret!;
    const body = JSON.stringify({ type: 'digest.ready', data: {} });
    const ts = Math.floor(h.clock.now() / 1000);
    const headers = { 'content-type': 'application/json', 'webhook-id': 'msg_replay_1', 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, 'msg_replay_1', ts, body) };
    const first = await h.ctx.transport({ url: 'https://receiver.example/hooks/driftline', method: 'POST', body, headers });
    const second = await h.ctx.transport({ url: 'https://receiver.example/hooks/driftline', method: 'POST', body, headers });
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
    const events = h.ctx.receiver.received.filter((e) => e.message_id === 'msg_replay_1');
    assert.deepEqual(events.map((e) => e.duplicate).sort(), [false, true]);
  });
});
