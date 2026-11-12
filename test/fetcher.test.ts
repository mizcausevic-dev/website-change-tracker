import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { netTransport, PageFetcher } from '../src/core/fetcher.ts';
import { routingTransport } from '../src/core/transport.ts';

/**
 * Negative tests for the network path. A guard that has never been seen to
 * block anything proves nothing, so these point the real transport at a
 * server on 127.0.0.1 and assert it refuses to connect.
 */
let server: http.Server;
let port = 0;
before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<p>internal secret</p>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

describe('network transport SSRF guard', () => {
  it('refuses a loopback address even on an allowed port list', async () => {
    const t = netTransport({ allowedPorts: [port] });
    await assert.rejects(t({ url: `http://127.0.0.1:${port}/` }), (e: Error & { code?: string }) => e.code === 'ssrf_blocked');
  });

  it('refuses a public-looking hostname that resolves to loopback', async () => {
    const t = netTransport({ allowedPorts: [port] });
    await assert.rejects(t({ url: `http://localhost:${port}/` }), (e: Error & { code?: string }) => e.code === 'ssrf_blocked');
  });

  it('refuses non-default ports by default', async () => {
    const t = netTransport();
    await assert.rejects(t({ url: `http://example.com:${port}/` }), (e: Error & { code?: string }) => e.code === 'port_not_allowed');
  });

  it('reports a blocked outcome through the page fetcher, not an exception', async () => {
    const f = new PageFetcher(netTransport({ allowedPorts: [port] }), Date.now);
    const r = await f.fetchPage(`http://127.0.0.1:${port}/`);
    assert.equal(r.kind, 'blocked');
    assert.match(r.error!, /ssrf_blocked/);
  });
});

describe('routing transport', () => {
  const t = 1_762_000_000_000;
  const transport = routingTransport({ now: () => t, net: async () => { throw new Error('should not be called'); }, allowExternal: false, receiverSecret: () => null, received: [] });
  const fetcher = new PageFetcher(transport, () => t);

  it('blocks external hosts when external fetching is disabled', async () => {
    const r = await fetcher.fetchPage('https://example.com/');
    assert.equal(r.kind, 'blocked');
    assert.match(r.error!, /external_fetch_disabled/);
  });

  it('honours robots.txt for the tracker user agent', async () => {
    const r = await fetcher.fetchPage('https://orrery.example/careers/internal');
    assert.equal(r.kind, 'blocked');
    assert.match(r.error!, /robots/);
    assert.equal((await fetcher.fetchPage('https://orrery.example/careers')).kind, 'ok');
  });

  it('gets 304 Not Modified when the ETag still matches', async () => {
    const first = await fetcher.fetchPage('https://quarry.example/legal/terms');
    assert.equal(first.kind, 'ok');
    assert.ok(first.etag);
    const second = await fetcher.fetchPage('https://quarry.example/legal/terms', { etag: first.etag });
    assert.equal(second.kind, 'not_modified');
  });
});
