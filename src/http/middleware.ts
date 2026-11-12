import { createHash, randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Ctx } from '../context.ts';
import { one, run } from '../db.ts';
import { authenticate, type ApiKey } from './auth.ts';
import { ApiError } from './problem.ts';
import type { RateLimiter } from './ratelimit.ts';

export type Env = { Variables: { requestId: string; key: ApiKey | null; clientIp: string } };

export const etagFor = (body: string): string => `"${createHash('sha1').update(body).digest('base64url').slice(0, 22)}"`;

/** Matches If-None-Match / If-Match lists using weak comparison for If-None-Match (RFC 9110 §13.1.2). */
export function etagMatches(header: string | undefined, etag: string, weak: boolean): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const strip = (t: string): string => (weak ? t.trim().replace(/^W\//, '') : t.trim());
  return header.split(',').some((t) => strip(t) === strip(etag));
}

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    // Cloud Run's front end appends the connecting client's address as the last entry.
    const xff = c.req.header('x-forwarded-for');
    const last = xff?.split(',').pop()?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function requestContext(ctx: Ctx): MiddlewareHandler<Env> {
  return async (c, next) => {
    const started = performance.now();
    const supplied = c.req.header('x-request-id');
    const requestId = supplied && /^[A-Za-z0-9._-]{8,64}$/.test(supplied) ? supplied : randomUUID();
    c.set('requestId', requestId);
    c.set('key', null);
    c.set('clientIp', clientIp(c, ctx.config.trustProxy));
    await next();
    c.header('X-Request-Id', requestId);
    const path = c.req.path;
    const h = c.res.headers;
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    const https = c.req.url.startsWith('https://') || (ctx.config.trustProxy && c.req.header('x-forwarded-proto') === 'https');
    if (https) h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    if (path.startsWith('/demo-sites/')) {
      h.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; sandbox");
    } else if (path.startsWith('/v1') || path.startsWith('/healthz') || path.startsWith('/readyz')) {
      h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      h.set('Cross-Origin-Resource-Policy', 'cross-origin');
    } else {
      h.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
      h.set('X-Frame-Options', 'DENY');
    }
    if (!path.startsWith('/healthz') && process.env.LOG_REQUESTS !== 'off') {
      console.log(JSON.stringify({
        severity: c.res.status >= 500 ? 'ERROR' : c.res.status >= 400 ? 'WARNING' : 'INFO',
        msg: 'request', method: c.req.method, path, status: c.res.status,
        ms: Math.round((performance.now() - started) * 10) / 10, request_id: requestId, key_id: c.get('key')?.id ?? null,
      }));
    }
  };
}

const PUBLIC_V1 = new Set(['/v1', '/v1/', '/v1/openapi.json']);

/** Bearer auth plus per-key-and-client rate limiting. Anonymous discovery endpoints are limited by IP. */
export function authAndRateLimit(ctx: Ctx, limiter: RateLimiter): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const now = ctx.clock.now();
    const ip = c.get('clientIp');
    let bucketId: string;
    let limit: number;
    if (PUBLIC_V1.has(c.req.path) && !c.req.header('authorization')) {
      bucketId = `anon:${ip}`;
      limit = 60;
    } else {
      let key: ApiKey;
      try {
        key = authenticate(ctx.db, c.req.header('authorization'), now);
      } catch (err) {
        // Failed auth still costs a token, which slows key guessing.
        const d = limiter.take(`authfail:${ip}`, 20, now);
        if (!d.allowed) throw new ApiError(429, 'rate-limited', 'Too many requests', `Retry after ${d.retryAfterSec} seconds.`, {}, { 'Retry-After': String(d.retryAfterSec) });
        throw err;
      }
      c.set('key', key);
      bucketId = `${key.id}:${ip}`;
      limit = key.rateLimitPerMin;
    }
    const d = limiter.take(bucketId, limit, now);
    const headers = { 'RateLimit-Limit': String(d.limit), 'RateLimit-Remaining': String(d.remaining), 'RateLimit-Reset': String(d.resetSec) };
    if (!d.allowed) {
      throw new ApiError(429, 'rate-limited', 'Too many requests', `Limit is ${d.limit} requests per minute. Retry after ${d.retryAfterSec} seconds.`, {}, { ...headers, 'Retry-After': String(d.retryAfterSec) });
    }
    await next();
    for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v);
  };
}

/**
 * Strong ETags for every successful GET. A dashboard that polls with
 * If-None-Match gets an empty 304 when nothing changed, which is most of the time.
 */
export function conditionalGet(): MiddlewareHandler<Env> {
  return async (c, next) => {
    await next();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return;
    if (c.res.status !== 200) return;
    let etag = c.res.headers.get('ETag');
    if (!etag) {
      const body = await c.res.clone().text();
      etag = etagFor(body);
      c.res.headers.set('ETag', etag);
    }
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'private, no-cache');
    if (etagMatches(c.req.header('if-none-match'), etag, true)) {
      const headers = new Headers(c.res.headers);
      headers.delete('Content-Type');
      headers.delete('Content-Length');
      c.res = new Response(null, { status: 304, headers });
    }
  };
}

const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

/**
 * Idempotency-Key support for POST. The first request with a key runs; a retry
 * with the same key and same body replays the stored response; the same key
 * with a different body is a client bug and gets 422. Keys are scoped to the
 * API key, so two clients can't collide.
 */
export function idempotency(ctx: Ctx): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const key = c.req.header('idempotency-key');
    // Anonymous requests can't create anything, so they get no idempotency storage.
    if (!key || !c.get('key')) return next();
    if (key.length < 1 || key.length > 255) throw new ApiError(400, 'invalid-idempotency-key', 'Invalid Idempotency-Key', 'Keys must be 1–255 characters.');
    const now = ctx.clock.now();
    const apiKey = c.get('key');
    const body = await c.req.text();
    const scope = `${apiKey?.id ?? 'anon'}:${c.req.path}:${key}`;
    const requestHash = createHash('sha256').update(`${c.req.method} ${c.req.path}\n${body}`).digest('hex');
    run(ctx.db, 'DELETE FROM idempotency_keys WHERE created_at < ?', now - IDEMPOTENCY_TTL_MS);
    const existing = one<{ request_hash: string; state: string; status: number; headers: string; body: string }>(ctx.db, 'SELECT * FROM idempotency_keys WHERE scope = ?', scope);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError(422, 'idempotency-key-reused', 'Idempotency-Key reused with a different request', 'Use a new key for a different request body or path.');
      }
      if (existing.state === 'in_progress') {
        throw new ApiError(409, 'idempotency-in-progress', 'Original request still in progress', 'Retry after the first request completes.', {}, { 'Retry-After': '1' });
      }
      const headers = new Headers(JSON.parse(existing.headers) as Record<string, string>);
      headers.set('Idempotent-Replayed', 'true');
      c.res = new Response(existing.body, { status: existing.status, headers });
      return;
    }
    run(ctx.db, `INSERT INTO idempotency_keys (scope, request_hash, state, created_at) VALUES (?, ?, 'in_progress', ?)`, scope, requestHash, now);
    try {
      await next();
    } catch (err) {
      run(ctx.db, 'DELETE FROM idempotency_keys WHERE scope = ?', scope);
      throw err;
    }
    // Only store outcomes worth replaying; a 404 or 5xx should simply be retried.
    if (c.res.status >= 500 || c.res.status === 404) {
      run(ctx.db, 'DELETE FROM idempotency_keys WHERE scope = ?', scope);
      return;
    }
    const keep: Record<string, string> = {};
    for (const h of ['content-type', 'location', 'etag', 'retry-after']) {
      const v = c.res.headers.get(h);
      if (v) keep[h] = v;
    }
    const stored = await c.res.clone().text();
    run(ctx.db, `UPDATE idempotency_keys SET state = 'complete', status = ?, headers = ?, body = ? WHERE scope = ?`, c.res.status, JSON.stringify(keep), stored, scope);
  };
}
