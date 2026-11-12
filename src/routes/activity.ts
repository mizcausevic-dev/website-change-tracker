import type { Hono } from 'hono';
import type { Ctx } from '../context.ts';
import { iso } from '../clock.ts';
import { all, one, run, type Row } from '../db.ts';
import { isId, newId } from '../ids.ts';
import { toUnified, type Hunk } from '../core/diff.ts';
import { createDigest } from '../core/digest.ts';
import { createRun } from '../core/scheduler.ts';
import { CATEGORIES } from '../core/significance.ts';
import { overview } from '../core/stats.ts';
import { deliverDue, EVENT_TYPES, generateSecret } from '../core/webhooks.ts';
import { DEMO_KEY, requireScope, SCOPES } from '../http/auth.ts';
import type { Env } from '../http/middleware.ts';
import { page, pageParams } from '../http/pagination.ts';
import { ApiError, Problems } from '../http/problem.ts';
import type { RateLimiter } from '../http/ratelimit.ts';
import { changeOut, deliveryOut, digestOut, runOut, webhookOut } from '../http/repr.ts';
import { dateParam, enumParam, intParam, readJsonObject, validate } from '../http/validate.ts';
import { normalizeUrl } from './sources.ts';

const DAY = 86_400_000;

/** Server-driven content negotiation over a fixed list of media types. Returns null for 406. */
function negotiate(accept: string | undefined, offered: string[]): string | null {
  if (!accept || accept.trim() === '') return offered[0]!;
  const ranges = accept.split(',').map((part) => {
    const [type, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return { type: (type ?? '').trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
  }).filter((r) => r.q > 0).sort((a, b) => b.q - a.q);
  for (const r of ranges) {
    if (r.type === '*/*') return offered[0]!;
    const hit = offered.find((o) => o === r.type || (r.type.endsWith('/*') && o.startsWith(r.type.slice(0, -1))));
    if (hit) return hit;
  }
  return null;
}
const notAcceptable = (offered: string[]) => new ApiError(406, 'not-acceptable', 'Not acceptable', `This resource is available as: ${offered.join(', ')}.`, { available: offered });

export function registerActivity(app: Hono<Env>, ctx: Ctx, limiter: RateLimiter): void {
  const base = ctx.config.publicBaseUrl;

  // ------------------------------------------------------------------ root & discovery
  app.get('/v1', (c) =>
    c.json({
      object: 'api_root',
      name: 'Driftline website change tracker',
      version: '1.0.0',
      documentation: `${base}/docs`,
      openapi: `${base}/v1/openapi.json`,
      authentication: { scheme: 'Bearer', demo_key: ctx.config.demoMode ? DEMO_KEY : null, scopes: SCOPES },
      links: {
        sources: `${base}/v1/sources`, changes: `${base}/v1/changes`, check_runs: `${base}/v1/check-runs`,
        digests: `${base}/v1/digests`, webhooks: `${base}/v1/webhooks`, stats: `${base}/v1/stats/overview`,
      },
    }),
  );

  // ------------------------------------------------------------------ changes
  app.get('/v1/changes', (c) => {
    requireScope(c.get('key')!, 'changes:read');
    const { limit, before } = pageParams(c);
    const category = enumParam(c, 'category', CATEGORIES);
    const meaningful = enumParam(c, 'meaningful', ['true', 'false', 'any'] as const) ?? 'true';
    const minSig = intParam(c, 'min_significance', 0, 0, 100);
    const since = dateParam(c, 'since');
    const until = dateParam(c, 'until');
    const sourceId = c.req.query('source_id');
    if (sourceId && !isId(sourceId, 'src')) throw Problems.badParam('source_id', 'is not a source ID');
    const where: string[] = ['c.significance >= ?'];
    const params: Array<string | number> = [minSig];
    if (before) (where.push('c.id < ?'), params.push(before));
    if (category) (where.push('c.category = ?'), params.push(category));
    if (meaningful !== 'any') (where.push('c.meaningful = ?'), params.push(meaningful === 'true' ? 1 : 0));
    if (since) (where.push('c.detected_at >= ?'), params.push(since));
    if (until) (where.push('c.detected_at < ?'), params.push(until));
    if (sourceId) (where.push('c.source_id = ?'), params.push(sourceId));
    const rows = all<Row & { id: string }>(ctx.db,
      `SELECT c.*, s.name AS source_name FROM changes c JOIN sources s ON s.id = c.source_id WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ?`, ...params, limit + 1);
    return c.json(page(c, base, rows, limit, (r) => changeOut(r, base, false)));
  });

  app.get('/v1/changes/:id', (c) => {
    requireScope(c.get('key')!, 'changes:read');
    const id = c.req.param('id');
    const row = isId(id, 'chg') ? one<Row>(ctx.db, 'SELECT c.*, s.name AS source_name, s.url FROM changes c JOIN sources s ON s.id = c.source_id WHERE c.id = ?', id) : undefined;
    if (!row) throw Problems.notFound('Change', id);
    c.header('Vary', 'Accept');
    const offered = ['application/json', 'text/x-diff', 'text/plain'];
    const type = negotiate(c.req.header('accept'), offered);
    if (!type) throw notAcceptable(offered);
    if (type === 'application/json') return c.json(changeOut(row, base, true));
    const hunks = JSON.parse(String(row.hunks)) as Hunk[];
    const diff = toUnified(hunks, `${row.url} @ ${row.from_snapshot_id}`, `${row.url} @ ${row.to_snapshot_id}`);
    return c.body(diff, 200, { 'Content-Type': `${type}; charset=utf-8` });
  });

  // ------------------------------------------------------------------ check runs (async, 202 Accepted)
  app.post('/v1/check-runs', async (c) => {
    const key = c.get('key')!;
    requireScope(key, 'checks:run');
    const d = limiter.take(`runs:${key.id}:${c.get('clientIp')}`, 6, ctx.clock.now());
    if (!d.allowed) throw new ApiError(429, 'rate-limited', 'Too many check runs', `Check runs are limited to 6 per minute. Retry after ${d.retryAfterSec} seconds.`, {}, { 'Retry-After': String(d.retryAfterSec) });
    const body = await readJsonObject(c);
    const { value, errors } = validate(body, { source_ids: { type: 'string[]', maxItems: 20, check: (v: string[]) => (v.every((x) => isId(x, 'src')) ? null : 'items must be source IDs') } });
    if (errors.length) throw Problems.validation(errors);
    let ids = (value.source_ids as string[] | undefined) ?? all<{ id: string }>(ctx.db, "SELECT id FROM sources WHERE status = 'approved' ORDER BY id").map((r) => r.id);
    ids = [...new Set(ids)];
    const missing = ids.filter((id) => !one(ctx.db, 'SELECT 1 AS x FROM sources WHERE id = ?', id));
    if (missing.length) throw Problems.validation(missing.map((m) => ({ field: 'source_ids', message: `${m} does not exist` })));
    if (!ids.length) throw Problems.validation([{ field: 'source_ids', message: 'no approved sources to check' }]);
    const runId = createRun(ctx, ids, key.name);
    const row = one<Row>(ctx.db, 'SELECT * FROM check_runs WHERE id = ?', runId)!;
    const out = runOut(row, base);
    c.header('Location', out.links.self);
    c.header('Retry-After', '1');
    return c.json(out, 202);
  });

  app.get('/v1/check-runs/:id', (c) => {
    requireScope(c.get('key')!, 'checks:run');
    const id = c.req.param('id');
    const row = isId(id, 'run') ? one<Row>(ctx.db, 'SELECT * FROM check_runs WHERE id = ?', id) : undefined;
    if (!row) throw Problems.notFound('Check run', id);
    if (row.status === 'queued' || row.status === 'running') c.header('Retry-After', '1');
    return c.json(runOut(row, base));
  });

  // ------------------------------------------------------------------ digests
  app.get('/v1/digests', (c) => {
    requireScope(c.get('key')!, 'digests:read');
    const { limit, before } = pageParams(c);
    const rows = all<Row & { id: string }>(ctx.db, `SELECT * FROM digests ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`, ...([...(before ? [before] : []), limit + 1] as Array<string | number>));
    return c.json(page(c, base, rows, limit, (r) => digestOut(r, base, false)));
  });

  app.get('/v1/digests/:id', (c) => {
    requireScope(c.get('key')!, 'digests:read');
    const id = c.req.param('id');
    const row = isId(id, 'dig') ? one<Row>(ctx.db, 'SELECT * FROM digests WHERE id = ?', id) : undefined;
    if (!row) throw Problems.notFound('Digest', id);
    c.header('Vary', 'Accept');
    const offered = ['application/json', 'text/html', 'text/plain'];
    const type = negotiate(c.req.header('accept'), offered);
    if (!type) throw notAcceptable(offered);
    if (type === 'text/html') {
      // The email body is rendered for preview; lock it down hard since it is HTML from our own template only.
      return c.body(String(row.html), 200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" });
    }
    if (type === 'text/plain') return c.text(String(row.text));
    return c.json(digestOut(row, base, true));
  });

  app.post('/v1/digests', async (c) => {
    requireScope(c.get('key')!, 'digests:write');
    const body = await readJsonObject(c);
    const isDate = (v: string): string | null => (Number.isFinite(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v) ? null : 'must be an RFC 3339 date-time');
    const { value, errors } = validate(body, {
      period_start: { type: 'string', required: true, maxLength: 40, check: isDate },
      period_end: { type: 'string', required: true, maxLength: 40, check: isDate },
      send: { type: 'boolean' },
    });
    if (errors.length) throw Problems.validation(errors);
    const start = Date.parse(String(value.period_start));
    const end = Date.parse(String(value.period_end));
    if (end <= start) throw Problems.validation([{ field: 'period_end', message: 'must be after period_start' }]);
    if (end - start > 31 * DAY) throw Problems.validation([{ field: 'period_end', message: 'period must be at most 31 days' }]);
    const existing = one<{ id: string }>(ctx.db, 'SELECT id FROM digests WHERE period_start = ? AND period_end = ?', iso(start), iso(end));
    if (existing) throw Problems.conflict('digest-exists', 'Digest already exists for this period', 'Fetch the existing digest instead.', { existing: { id: existing.id, href: `${base}/v1/digests/${existing.id}` } });
    const d = await createDigest(ctx, start, end, { send: value.send !== false });
    void deliverDue(ctx.db, ctx.transport, ctx.clock.now());
    const row = one<Row>(ctx.db, 'SELECT * FROM digests WHERE id = ?', d.id)!;
    const out = digestOut(row, base, true);
    c.header('Location', out.links.self);
    return c.json(out, 201);
  });

  // ------------------------------------------------------------------ webhooks
  const loadHook = (id: string): Row => {
    const row = isId(id, 'whk') ? one<Row>(ctx.db, 'SELECT * FROM webhooks WHERE id = ?', id) : undefined;
    if (!row) throw Problems.notFound('Webhook', id);
    return row;
  };

  app.get('/v1/webhooks', (c) => {
    requireScope(c.get('key')!, 'webhooks:manage');
    const { limit, before } = pageParams(c);
    const rows = all<Row & { id: string }>(ctx.db, `SELECT * FROM webhooks ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`, ...([...(before ? [before] : []), limit + 1] as Array<string | number>));
    return c.json(page(c, base, rows, limit, (r) => webhookOut(r, base)));
  });

  app.post('/v1/webhooks', async (c) => {
    requireScope(c.get('key')!, 'webhooks:manage');
    const body = await readJsonObject(c);
    const { value, errors } = validate(body, {
      url: { type: 'string', required: true, maxLength: 2048, check: (v: string) => (v.startsWith('https://') ? normalizeUrl(v).error ?? null : 'must be an https URL') },
      events: { type: 'string[]', required: true, maxItems: EVENT_TYPES.length, enum: EVENT_TYPES },
      description: { type: 'string', maxLength: 200, nullable: true },
    });
    if (errors.length) throw Problems.validation(errors);
    if (!(value.events as string[]).length) throw Problems.validation([{ field: 'events', message: 'must list at least one event type' }]);
    const now = ctx.clock.now();
    const id = newId('whk', now);
    const secret = generateSecret();
    run(ctx.db, 'INSERT INTO webhooks (id, url, description, secret, events, active, created_at) VALUES (?,?,?,?,?,1,?)',
      id, normalizeUrl(String(value.url)).url!, (value.description as string | null) ?? null, secret, JSON.stringify([...new Set(value.events as string[])]), iso(now));
    const out = { ...webhookOut(loadHook(id), base), secret };
    c.header('Location', out.links.self);
    c.header('Cache-Control', 'no-store');
    return c.json(out, 201);
  });

  app.get('/v1/webhooks/:id', (c) => {
    requireScope(c.get('key')!, 'webhooks:manage');
    return c.json(webhookOut(loadHook(c.req.param('id')), base));
  });

  app.delete('/v1/webhooks/:id', (c) => {
    requireScope(c.get('key')!, 'webhooks:manage');
    const row = loadHook(c.req.param('id'));
    run(ctx.db, 'DELETE FROM webhooks WHERE id = ?', String(row.id));
    return c.body(null, 204);
  });

  app.get('/v1/webhooks/:id/deliveries', (c) => {
    requireScope(c.get('key')!, 'webhooks:manage');
    const row = loadHook(c.req.param('id'));
    const { limit, before } = pageParams(c);
    const rows = all<Row & { id: string }>(ctx.db, `SELECT * FROM deliveries WHERE webhook_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
      ...([String(row.id), ...(before ? [before] : []), limit + 1] as Array<string | number>));
    return c.json(page(c, base, rows, limit, deliveryOut));
  });

  // ------------------------------------------------------------------ stats
  app.get('/v1/stats/overview', (c) => {
    requireScope(c.get('key')!, 'stats:read');
    const days = intParam(c, 'days', 30, 1, 90);
    const out = overview(ctx.db, ctx.clock.now(), days);
    // Public, demo-wide delivery feed for the dashboard: deliveries are only visible in aggregate here.
    const deliveries = all<Row>(ctx.db, `SELECT d.* FROM deliveries d ORDER BY d.id DESC LIMIT 8`).map(deliveryOut);
    return c.json({ ...out, recent_deliveries: deliveries, receiver: { verified: ctx.receiver.received.filter((r) => r.verified).length, rejected: ctx.receiver.received.filter((r) => !r.verified).length } });
  });
}
