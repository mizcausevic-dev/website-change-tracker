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
import { deliverDue, deliverOne, enqueueTest, EVENT_TYPES, generateSecret, type WebhookFilter } from '../core/webhooks.ts';
import { DEMO_KEY, requireScope, SCOPES } from '../http/auth.ts';
import { clientFingerprint, etagFor, etagMatches, type Env } from '../http/middleware.ts';
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
      version: '1.1.0',
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
  // One collection, three representations: JSON (the paged envelope), CSV and NDJSON for exports.
  // Exports page the same way, with bigger pages and the cursor only in the Link header.
  const CHANGE_TYPES = ['application/json', 'text/csv', 'application/x-ndjson'];
  app.get('/v1/changes', (c) => {
    requireScope(c.get('key')!, 'changes:read');
    c.header('Vary', 'Accept');
    const type = negotiate(c.req.header('accept'), CHANGE_TYPES);
    if (!type) throw notAcceptable(CHANGE_TYPES);
    const exporting = type !== 'application/json';
    if (exporting) requireScope(c.get('key')!, 'changes:export');
    const { limit, before } = exporting ? pageParams(c, 500, 1000) : pageParams(c);
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
      `SELECT c.*, s.name AS source_name, s.url AS source_url FROM changes c JOIN sources s ON s.id = c.source_id WHERE ${where.join(' AND ')} ORDER BY c.id DESC LIMIT ?`, ...params, limit + 1);
    const envelope = page(c, base, rows, limit, (r) => changeOut(r, base, false)); // also sets the Link header
    if (!exporting) return c.json(envelope);
    const day = new Date(ctx.clock.now()).toISOString().slice(0, 10);
    const items = rows.slice(0, limit);
    if (type === 'text/csv') {
      return c.body(toCsv(items), 200, {
        'Content-Type': 'text/csv; charset=utf-8; header=present',
        'Content-Disposition': `attachment; filename="driftline-changes-${day}.csv"`,
      });
    }
    return c.body(envelope.data.map((r) => JSON.stringify(r)).join('\n') + (items.length ? '\n' : ''), 200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="driftline-changes-${day}.ndjson"`,
    });
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
    // Two buckets: per client, and per key overall (the demo key is shared by every visitor).
    const perKey = limiter.take(`runs-key:${key.id}`, 12, ctx.clock.now());
    if (!perKey.allowed) throw new ApiError(429, 'rate-limited', 'Too many check runs', `This key may start 12 check runs per minute across all clients. Retry after ${perKey.retryAfterSec} seconds.`, {}, { 'Retry-After': String(perKey.retryAfterSec) });
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
    const { filter: rawFilter, ...rest } = body;
    const { value, errors } = validate(rest, {
      url: { type: 'string', required: true, maxLength: 2048, check: (v: string) => (v.startsWith('https://') ? normalizeUrl(v).error ?? null : 'must be an https URL') },
      events: { type: 'string[]', required: true, maxItems: EVENT_TYPES.length, enum: EVENT_TYPES },
      description: { type: 'string', maxLength: 200, nullable: true },
    });
    const f = rawFilter === undefined || rawFilter === null ? { filter: {}, errors: [] } : validateFilter(rawFilter);
    errors.push(...f.errors);
    if (errors.length) throw Problems.validation(errors);
    if (!(value.events as string[]).length) throw Problems.validation([{ field: 'events', message: 'must list at least one event type' }]);
    const now = ctx.clock.now();
    const id = newId('whk', now);
    const secret = generateSecret();
    run(ctx.db, 'INSERT INTO webhooks (id, url, description, secret, events, filter, active, created_at) VALUES (?,?,?,?,?,?,1,?)',
      id, normalizeUrl(String(value.url)).url!, (value.description as string | null) ?? null, secret, JSON.stringify([...new Set(value.events as string[])]),
      JSON.stringify(f.filter), iso(now));
    const out = { ...webhookOut(loadHook(id), base), secret };
    c.header('Location', out.links.self);
    c.header('Cache-Control', 'no-store');
    return c.json(out, 201);
  });

  app.get('/v1/webhooks/:id', (c) => {
    requireScope(c.get('key')!, 'webhooks:manage');
    return c.json(webhookOut(loadHook(c.req.param('id')), base));
  });

  // JSON Merge Patch (RFC 7396) with optimistic concurrency, like sources. `filter` merges key by
  // key; setting a filter key to null removes it, and `"filter": null` clears the whole filter.
  app.patch('/v1/webhooks/:id', async (c) => {
    requireScope(c.get('key')!, 'webhooks:manage');
    const row = loadHook(c.req.param('id'));
    const ifMatch = c.req.header('if-match');
    if (!ifMatch) throw new ApiError(428, 'precondition-required', 'If-Match header required', 'Send the ETag from your last GET as If-Match.');
    const current = etagFor(JSON.stringify(webhookOut(row, base)));
    if (!etagMatches(ifMatch, current, false)) throw new ApiError(412, 'precondition-failed', 'Webhook changed since you read it', 'Re-fetch it and retry with the new ETag.', { current_etag: current });
    const body = await readJsonObject(c, ['application/merge-patch+json']);
    for (const ro of ['url', 'id', 'secret']) if (ro in body) throw Problems.validation([{ field: ro, message: ro === 'url' ? 'is read-only; create a new webhook for a new URL' : 'is read-only' }]);
    const { filter: rawFilter, ...rest } = body;
    const { value, errors } = validate(rest, {
      events: { type: 'string[]', maxItems: EVENT_TYPES.length, enum: EVENT_TYPES, check: (v: string[]) => (v.length ? null : 'must list at least one event type') },
      description: { type: 'string', maxLength: 200, nullable: true },
      active: { type: 'boolean' },
    }, true);
    let filter = JSON.parse(String(row.filter)) as Record<string, unknown>;
    if (rawFilter === null) filter = {};
    else if (rawFilter !== undefined) {
      if (typeof rawFilter !== 'object' || Array.isArray(rawFilter)) errors.push({ field: 'filter', message: 'must be an object or null' });
      else {
        for (const [k, v] of Object.entries(rawFilter as Record<string, unknown>)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
            errors.push({ field: `filter.${k}`, message: 'unknown field' });
            continue;
          }
          if (v === null) delete filter[k];
          else filter[k] = v;
        }
        const f = validateFilter(filter);
        errors.push(...f.errors);
        filter = f.filter as Record<string, unknown>;
      }
    }
    if (errors.length) throw Problems.validation(errors);
    run(ctx.db, `UPDATE webhooks SET events = COALESCE(?, events), description = CASE WHEN ? THEN ? ELSE description END,
                 active = COALESCE(?, active), filter = ? WHERE id = ?`,
      value.events ? JSON.stringify([...new Set(value.events as string[])]) : null, 'description' in value ? 1 : 0, (value.description as string | null) ?? null,
      value.active === undefined ? null : value.active ? 1 : 0, JSON.stringify(filter), String(row.id));
    const out = webhookOut(loadHook(String(row.id)), base);
    const json = JSON.stringify(out);
    c.header('ETag', etagFor(json));
    return c.body(json, 200, { 'Content-Type': 'application/json' });
  });

  // Send a signed `webhook.test` event now and report the attempt. Useful to check a receiver's
  // signature verification without waiting for a real change.
  app.post('/v1/webhooks/:id/test', async (c) => {
    requireScope(c.get('key')!, 'webhooks:manage');
    const row = loadHook(c.req.param('id'));
    const now = ctx.clock.now();
    const deliveryId = enqueueTest(ctx.db, now, String(row.id));
    await deliverOne(ctx.db, ctx.transport, ctx.clock.now(), deliveryId);
    const d = one<Row>(ctx.db, 'SELECT * FROM deliveries WHERE id = ?', deliveryId)!;
    return c.json(deliveryOut(d), 201);
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
    return c.json({ ...out, recent_deliveries: deliveries, receiver: { verified: ctx.receiver.received.filter((r) => r.verified && !r.duplicate).length, duplicates: ctx.receiver.received.filter((r) => r.duplicate).length, rejected: ctx.receiver.received.filter((r) => !r.verified).length } });
  });
}

/** Validate a webhook filter object field by field; returns the cleaned filter. */
export function validateFilter(raw: unknown): { filter: WebhookFilter; errors: Array<{ field: string; message: string }> } {
  const errors: Array<{ field: string; message: string }> = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { filter: {}, errors: [{ field: 'filter', message: 'must be an object' }] };
  const r = raw as Record<string, unknown>;
  const out: WebhookFilter = {};
  for (const k of Object.keys(r)) if (!['min_significance', 'categories', 'source_ids', 'tags'].includes(k)) errors.push({ field: `filter.${k}`, message: 'unknown field' });
  const list = (k: 'categories' | 'source_ids' | 'tags', ok: (s: string) => boolean, msg: string): void => {
    const v = r[k];
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length > 20 || v.some((x) => typeof x !== 'string' || !ok(x))) errors.push({ field: `filter.${k}`, message: msg });
    else if (v.length) out[k] = [...new Set(v as string[])];
  };
  if (r.min_significance !== undefined) {
    const m = r.min_significance;
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > 100) errors.push({ field: 'filter.min_significance', message: 'must be an integer from 0 to 100' });
    else out.min_significance = m;
  }
  list('categories', (s) => (CATEGORIES as readonly string[]).includes(s), `must be an array of up to 20 of: ${CATEGORIES.join(', ')}`);
  list('source_ids', (s) => isId(s, 'src'), 'must be an array of up to 20 source IDs');
  list('tags', (s) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(s), 'must be an array of up to 20 tags');
  return { filter: out, errors };
}

/**
 * Feedback on the meaningful flag: one verdict per client per change, as a sub-resource the client
 * owns. PUT is naturally idempotent (201 on create, 200 on replace); GET and DELETE address the same
 * resource. These labels are the only input to the precision figures in the stats overview.
 */
const FEEDBACK_PER_CHANGE = 200;
const FEEDBACK_TOTAL = 5000;

export function registerFeedback(app: Hono<Env>, ctx: Ctx): void {
  const base = ctx.config.publicBaseUrl;
  const loadChange = (id: string): Row => {
    const row = isId(id, 'chg') ? one<Row>(ctx.db, 'SELECT id, meaningful, category FROM changes WHERE id = ?', id) : undefined;
    if (!row) throw Problems.notFound('Change', id);
    return row;
  };
  const out = (f: Row, change: Row) => ({
    object: 'feedback',
    change_id: f.change_id,
    verdict: f.verdict,
    agrees_with_flag: (f.verdict === 'meaningful') === (change.meaningful === 1),
    note: f.note ?? null,
    suggested_ignore_pattern: f.suggested_ignore_pattern ?? null,
    created_at: f.created_at,
    updated_at: f.updated_at,
    links: { self: `${base}/v1/changes/${f.change_id}/feedback`, change: `${base}/v1/changes/${f.change_id}` },
  });

  app.put('/v1/changes/:id/feedback', async (c) => {
    requireScope(c.get('key')!, 'changes:feedback');
    const change = loadChange(c.req.param('id'));
    const body = await readJsonObject(c);
    const { value, errors } = validate(body, {
      verdict: { type: 'string', required: true, enum: ['meaningful', 'not_meaningful'] },
      note: { type: 'string', maxLength: 500, nullable: true },
      suggested_ignore_pattern: { type: 'string', maxLength: 200, nullable: true },
    });
    if (errors.length) throw Problems.validation(errors);
    const fp = clientFingerprint(c);
    const now = iso(ctx.clock.now());
    const existed = one(ctx.db, 'SELECT 1 AS x FROM feedback WHERE change_id = ? AND client_fp = ?', String(change.id), fp);
    if (!existed) {
      // Labels are cheap to submit with a shared key, so storage is bounded per change and overall.
      const perChange = one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM feedback WHERE change_id = ?', String(change.id))!.n;
      const total = one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM feedback')!.n;
      if (perChange >= FEEDBACK_PER_CHANGE || total >= FEEDBACK_TOTAL) {
        throw new ApiError(429, 'feedback-limit', 'Feedback limit reached', perChange >= FEEDBACK_PER_CHANGE ? `This change already has ${FEEDBACK_PER_CHANGE} labels.` : 'The feedback store is full; older labels expire after 24 hours on the demo.', {}, { 'Retry-After': '3600' });
      }
    }
    run(ctx.db, `INSERT INTO feedback (change_id, client_fp, verdict, note, suggested_ignore_pattern, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
                 ON CONFLICT (change_id, client_fp) DO UPDATE SET verdict = excluded.verdict, note = excluded.note,
                 suggested_ignore_pattern = excluded.suggested_ignore_pattern, updated_at = excluded.updated_at`,
      String(change.id), fp, String(value.verdict), (value.note as string | null) ?? null, (value.suggested_ignore_pattern as string | null) ?? null, now, now);
    const f = one<Row>(ctx.db, 'SELECT * FROM feedback WHERE change_id = ? AND client_fp = ?', String(change.id), fp)!;
    const res = out(f, change);
    if (!existed) c.header('Location', res.links.self);
    return c.json(res, existed ? 200 : 201);
  });

  app.get('/v1/changes/:id/feedback', (c) => {
    requireScope(c.get('key')!, 'changes:feedback');
    const change = loadChange(c.req.param('id'));
    const f = one<Row>(ctx.db, 'SELECT * FROM feedback WHERE change_id = ? AND client_fp = ?', String(change.id), clientFingerprint(c));
    if (!f) throw Problems.notFound('Feedback from this client for change', String(change.id));
    return c.json(out(f, change));
  });

  app.delete('/v1/changes/:id/feedback', (c) => {
    requireScope(c.get('key')!, 'changes:feedback');
    const change = loadChange(c.req.param('id'));
    run(ctx.db, 'DELETE FROM feedback WHERE change_id = ? AND client_fp = ?', String(change.id), clientFingerprint(c));
    return c.body(null, 204);
  });
}

const CSV_COLUMNS = ['id', 'detected_at', 'source_id', 'source_name', 'url', 'category', 'significance', 'meaningful', 'summary', 'words_added', 'words_removed', 'fact_changes'] as const;

/**
 * RFC 4180 CSV. Summaries and names come from third-party page text, so any cell that a spreadsheet
 * would evaluate as a formula (leading = + - @, tab or carriage return) is prefixed with an
 * apostrophe, per the OWASP guidance on CSV injection. Every cell is quoted.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Spreadsheets may trim leading whitespace (including NBSP, ideographic and zero-width spaces) before
  // evaluating, and some treat fullwidth = + - @ like their ASCII forms.
  if (/^[\s\u200B-\u200D\u2060\uFEFF]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(rows: Row[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const rec: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      id: r.id, detected_at: r.detected_at, source_id: r.source_id, source_name: r.source_name, url: r.source_url,
      category: r.category, significance: r.significance, meaningful: r.meaningful === 1, summary: r.summary,
      words_added: r.words_added, words_removed: r.words_removed, fact_changes: JSON.parse(String(r.fact_changes)),
    };
    lines.push(CSV_COLUMNS.map((k) => csvCell(rec[k])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
