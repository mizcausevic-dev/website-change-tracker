import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { isPublicAddress } from '../src/core/ssrf.ts';
import { sign } from '../src/core/webhooks.ts';
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
