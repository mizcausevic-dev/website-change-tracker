import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Ctx } from './context.ts';
import { one } from './db.ts';
import { renderFixture, SITES } from './fixtures/sites.ts';
import { authAndRateLimit, conditionalGet, idempotency, requestContext, type Env } from './http/middleware.ts';
import { ApiError, problemBody } from './http/problem.ts';
import { RateLimiter } from './http/ratelimit.ts';
import { buildOpenApi } from './openapi.ts';
import { registerActivity } from './routes/activity.ts';
import { registerSources } from './routes/sources.ts';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');

export function buildApp(ctx: Ctx): Hono<Env> {
  const app = new Hono<Env>();
  const limiter = new RateLimiter();

  app.use('*', requestContext(ctx));
  app.use('/v1/*', cors({
    origin: '*',
    allowMethods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'If-Match', 'If-None-Match', 'X-Request-Id'],
    exposeHeaders: ['ETag', 'Link', 'Location', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Idempotent-Replayed', 'X-Request-Id'],
    maxAge: 600,
  }));
  // '/v1/*' also matches '/v1', so this is registered once (registering both charged two tokens).
  app.use('/v1/*', authAndRateLimit(ctx, limiter));
  // Cap bodies while streaming, before anything buffers them. A declared Content-Length check alone
  // misses chunked bodies, which would otherwise be read in full first.
  app.use('/v1/*', bodyLimit({
    maxSize: 64 * 1024,
    onError: () => { throw new ApiError(413, 'payload-too-large', 'Request body too large', 'Bodies are limited to 65536 bytes.'); },
  }));
  app.use('/v1/*', conditionalGet());
  app.use('/v1/*', idempotency(ctx));

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    const apiErr = err instanceof ApiError ? err : new ApiError(500, 'internal-error', 'Internal server error', 'The error has been logged with this request_id.');
    if (!(err instanceof ApiError)) {
      console.error(JSON.stringify({ severity: 'ERROR', msg: 'unhandled', request_id: requestId, err: String(err), stack: (err as Error).stack }));
    }
    return c.body(JSON.stringify(problemBody(apiErr, c.req.path, requestId)), apiErr.status as 400, {
      'Content-Type': 'application/problem+json',
      'Cache-Control': 'no-store',
      ...apiErr.headers,
    });
  });
  app.notFound((c) => {
    const err = new ApiError(404, 'not-found', 'Not found', `No route for ${c.req.method} ${c.req.path}.`);
    return c.body(JSON.stringify(problemBody(err, c.req.path, c.get('requestId') ?? 'unknown')), 404, { 'Content-Type': 'application/problem+json' });
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', (c) => {
    const ok = one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM sources');
    return ok ? c.json({ status: 'ready', sources: ok.n, booted_at: new Date(ctx.bootedAt).toISOString() }) : c.json({ status: 'not_ready' }, 503);
  });
  app.get('/v1/openapi.json', (c) => c.json(buildOpenApi(ctx.config.publicBaseUrl)));

  registerSources(app, ctx);
  registerActivity(app, ctx, limiter);

  // Fictional demo sites, viewable in a browser at their current state.
  app.get('/demo-sites', (c) => c.json({ sites: SITES.map((s) => ({ host: s.host, name: s.name, paths: Object.keys(s.routes), view: Object.keys(s.routes).map((p) => `/demo-sites/${s.host}${p}`) })) }));
  app.get('/demo-sites/:host{[a-z0-9.-]+\\.example}/*', (c) => {
    const host = c.req.param('host');
    const p = c.req.path.slice(`/demo-sites/${host}`.length) || '/';
    const r = renderFixture(host, p, ctx.clock.now(), { 'if-none-match': c.req.header('if-none-match') ?? '' });
    if (r.status === 304) return c.body(null, 304, r.headers);
    return c.body(r.body, r.status as 200, r.headers);
  });

  // Dashboard, docs and the product brief.
  const page = (file: string) => serveStatic({ root: path.relative(process.cwd(), PUBLIC_DIR), path: file });
  app.get('/', page('dashboard-Claude.html'));
  app.get('/docs', page('docs.html'));
  app.get('/brief', page('brief-Claude.html'));
  app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), PUBLIC_DIR) }));
  return app;
}
