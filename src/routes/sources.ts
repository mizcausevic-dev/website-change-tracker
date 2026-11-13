import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { Ctx } from '../context.ts';
import { iso } from '../clock.ts';
import { all, one, run, tx, type Row } from '../db.ts';
import { isId, newId } from '../ids.ts';
import { applyIgnorePatternsToText, compileIgnorePattern, isValidSelector, PREVIEW_BUDGET } from '../core/extract.ts';
import { isPublicAddress } from '../core/ssrf.ts';
import { isIP } from 'node:net';
import { requireScope } from '../http/auth.ts';
import { etagFor, etagMatches, type Env } from '../http/middleware.ts';
import { page, pageParams } from '../http/pagination.ts';
import { ApiError, Problems } from '../http/problem.ts';
import { checkOut, snapshotOut, sourceOut } from '../http/repr.ts';
import { enumParam, readJsonObject, validate, type Spec } from '../http/validate.ts';
import type { RateLimiter } from '../http/ratelimit.ts';

const STATUSES = ['pending', 'approved', 'paused', 'rejected'] as const;
const MAX_PENDING = 50;
const MAX_PENDING_PER_CLIENT = 3;

/** Normalizes a URL for identity: lowercase host, no fragment, no default port. Returns an error message or the URL. */
export function normalizeUrl(raw: string): { url?: string; error?: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'must be an absolute URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'must use http or https' };
  if (u.username || u.password) return { error: 'must not contain credentials' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return { error: 'must be a public host' };
  if (isIP(host) && !isPublicAddress(host)) return { error: 'must be a public address' };
  if (u.port && !['80', '443'].includes(u.port)) return { error: 'only ports 80 and 443 are tracked' };
  u.hash = '';
  return { url: u.toString() };
}

const selectorList = (v: string[]): string | null => (v.every(isValidSelector) ? null : 'contains an invalid CSS selector');
const tagList = (v: string[]): string | null => (v.every((t) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(t)) ? null : 'tags must be lowercase letters, digits and hyphens');

const EDITABLE: Spec = {
  name: { type: 'string', maxLength: 120, check: (v: string) => (v.trim() ? null : 'must not be blank') },
  tags: { type: 'string[]', maxItems: 10, check: tagList },
  selector: { type: 'string', nullable: true, maxLength: 200, check: (v: string) => (isValidSelector(v) ? null : 'is not a valid CSS selector') },
  ignore_selectors: { type: 'string[]', maxItems: 20, itemMaxLength: 200, check: selectorList },
  ignore_patterns: { type: 'string[]', maxItems: 20, itemMaxLength: 200 },
  check_interval_minutes: { type: 'integer', min: 15, max: 10080 },
  min_significance: { type: 'integer', min: 0, max: 100 },
  notes: { type: 'string', nullable: true, maxLength: 500 },
};
const CREATE: Spec = {
  url: { type: 'string', required: true, maxLength: 2048, check: (v: string) => normalizeUrl(v).error ?? null },
  ...EDITABLE,
  name: { ...EDITABLE.name!, required: true },
};

const TRANSITIONS: Record<string, { from: string[]; to: string; scope: 'sources:approve' | 'sources:write'; noteRequired?: boolean }> = {
  approve: { from: ['pending', 'rejected'], to: 'approved', scope: 'sources:approve' },
  reject: { from: ['pending'], to: 'rejected', scope: 'sources:approve', noteRequired: true },
  pause: { from: ['approved'], to: 'paused', scope: 'sources:write' },
  resume: { from: ['paused'], to: 'approved', scope: 'sources:write' },
};

export function registerSources(app: Hono<Env>, ctx: Ctx): void {
  const base = ctx.config.publicBaseUrl;
  const load = (id: string): Row => {
    if (!isId(id, 'src')) throw Problems.notFound('Source', id);
    const row = one<Row>(ctx.db, 'SELECT * FROM sources WHERE id = ?', id);
    if (!row) throw Problems.notFound('Source', id);
    return row;
  };

  app.get('/v1/sources', (c) => {
    requireScope(c.get('key')!, 'sources:read');
    const { limit, before } = pageParams(c);
    const status = enumParam(c, 'status', STATUSES);
    const tag = c.req.query('tag');
    const q = c.req.query('q');
    if (q && q.length > 100) throw Problems.badParam('q', 'must be at most 100 characters');
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (before) (where.push('id < ?'), params.push(before));
    if (status) (where.push('status = ?'), params.push(status));
    if (tag) (where.push('EXISTS (SELECT 1 FROM json_each(sources.tags) WHERE value = ?)'), params.push(tag));
    if (q) (where.push("(instr(lower(name), lower(?)) > 0 OR instr(lower(url), lower(?)) > 0)"), params.push(q, q));
    const rows = all<Row & { id: string }>(ctx.db, `SELECT * FROM sources ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, limit + 1);
    return c.json(page(c, base, rows, limit, (r) => sourceOut(r, base)));
  });

  app.post('/v1/sources', async (c) => {
    const key = c.get('key')!;
    if (!key.scopes.includes('sources:write')) requireScope(key, 'sources:propose');
    const body = await readJsonObject(c);
    const { value, errors } = validate(body, CREATE);
    if (errors.length) throw Problems.validation(errors);
    const url = normalizeUrl(String(value.url)).url!;
    const now = ctx.clock.now();
    const created = tx(ctx.db, () => {
      const dup = one<{ id: string }>(ctx.db, 'SELECT id FROM sources WHERE url = ?', url);
      if (dup) throw Problems.conflict('duplicate-source', 'Source already exists', `A source for ${url} already exists.`, { existing: { id: dup.id, href: `${base}/v1/sources/${dup.id}` } });
      const pending = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM sources WHERE status = 'pending'")!.n;
      if (pending >= MAX_PENDING) throw Problems.conflict('review-queue-full', 'Review queue is full', `There are already ${MAX_PENDING} sources awaiting review.`);
      // Proposal-only keys are shared (the demo key is public), so cap pending proposals per key-and-client
      // or one visitor could fill the global queue for everyone.
      const fp = createHash('sha256').update(`${key.id}:${c.get('clientIp')}`).digest('hex').slice(0, 32);
      if (!key.scopes.includes('sources:write')) {
        const mine = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM sources WHERE status = 'pending' AND proposer_fp = ?", fp)!.n;
        if (mine >= MAX_PENDING_PER_CLIENT) {
          throw new ApiError(429, 'proposal-limit', 'Too many pending proposals', `Each client may have ${MAX_PENDING_PER_CLIENT} proposals awaiting review.`, {}, { 'Retry-After': '1800' });
        }
      }
      const id = newId('src', now);
      run(ctx.db, `INSERT INTO sources (id, url, name, status, tags, selector, ignore_selectors, ignore_patterns, check_interval_minutes, min_significance, notes, proposed_by, proposer_fp, created_at, updated_at)
                   VALUES (?,?,?, 'pending', ?,?,?,?,?,?,?,?,?,?,?)`,
        id, url, String(value.name).trim(), JSON.stringify(value.tags ?? []), (value.selector as string | null) ?? null,
        JSON.stringify(value.ignore_selectors ?? []), JSON.stringify(value.ignore_patterns ?? []),
        (value.check_interval_minutes as number) ?? 60, (value.min_significance as number) ?? 20, (value.notes as string | null) ?? null, key.name, fp, iso(now), iso(now));
      return one<Row>(ctx.db, 'SELECT * FROM sources WHERE id = ?', id)!;
    });
    const out = sourceOut(created, base);
    const json = JSON.stringify(out);
    c.header('Location', out.links.self);
    c.header('ETag', etagFor(json));
    return c.body(json, 201, { 'Content-Type': 'application/json' });
  });

  app.get('/v1/sources/:id', (c) => {
    requireScope(c.get('key')!, 'sources:read');
    return c.json(sourceOut(load(c.req.param('id')), base));
  });

  app.patch('/v1/sources/:id', async (c) => {
    requireScope(c.get('key')!, 'sources:write');
    const row = load(c.req.param('id'));
    const ifMatch = c.req.header('if-match');
    if (!ifMatch) throw new ApiError(428, 'precondition-required', 'If-Match header required', 'Send the ETag from your last GET as If-Match so concurrent edits are not lost.');
    const current = etagFor(JSON.stringify(sourceOut(row, base)));
    if (!etagMatches(ifMatch, current, false)) {
      throw new ApiError(412, 'precondition-failed', 'Source changed since you read it', 'Re-fetch the source, re-apply your change, and retry with the new ETag.', { current_etag: current });
    }
    const body = await readJsonObject(c, ['application/merge-patch+json']);
    for (const f of ['url', 'status', 'id']) {
      if (f in body) throw Problems.validation([{ field: f, message: f === 'status' ? 'is read-only; use the approve, reject, pause and resume actions' : 'is read-only' }]);
    }
    const { value, errors } = validate(body, EDITABLE, true);
    if (errors.length) throw Problems.validation(errors);
    const cols = Object.keys(value);
    if (cols.length) {
      const now = ctx.clock.now();
      const sets = cols.map((k) => `${k} = ?`);
      const params = cols.map((k) => (Array.isArray(value[k]) ? JSON.stringify(value[k]) : (value[k] as string | number | null)));
      // Extraction settings changed: drop HTTP validators so the next check re-reads the page instead of getting a 304.
      // Only a real change to the extraction rules re-baselines; resending identical values must not
      // fold a genuine page edit into a silent baseline.
      const resetValidators = cols.some((k) => ['selector', 'ignore_selectors', 'ignore_patterns'].includes(k) && JSON.stringify(value[k]) !== JSON.stringify(k === 'selector' ? row[k] : JSON.parse(String(row[k]))));
      run(ctx.db, `UPDATE sources SET ${sets.join(', ')}, updated_at = ?, revision = revision + 1${resetValidators ? ', http_etag = NULL, http_last_modified = NULL, last_raw_hash = NULL, rebaseline_pending = 1' : ''} WHERE id = ?`,
        ...params, iso(now), String(row.id));
    }
    const out = sourceOut(load(String(row.id)), base);
    const json = JSON.stringify(out);
    c.header('ETag', etagFor(json));
    return c.body(json, 200, { 'Content-Type': 'application/json' });
  });

  app.delete('/v1/sources/:id', (c) => {
    requireScope(c.get('key')!, 'sources:write');
    const row = load(c.req.param('id'));
    const ifMatch = c.req.header('if-match');
    if (ifMatch && !etagMatches(ifMatch, etagFor(JSON.stringify(sourceOut(row, base))), false)) {
      throw new ApiError(412, 'precondition-failed', 'Source changed since you read it', 'Re-fetch the source and retry.');
    }
    run(ctx.db, 'DELETE FROM sources WHERE id = ?', String(row.id));
    return c.body(null, 204);
  });

  for (const [action, t] of Object.entries(TRANSITIONS)) {
    app.post(`/v1/sources/:id/${action}`, async (c) => {
      const key = c.get('key')!;
      requireScope(key, t.scope);
      const row = load(c.req.param('id'));
      // The body is optional for actions without a required note.
      const body = c.req.header('content-type') || Number(c.req.header('content-length') ?? 0) > 0 ? await readJsonObject(c) : {};
      const { value, errors } = validate(body, { note: { type: 'string', maxLength: 500, required: !!t.noteRequired } });
      if (errors.length) throw Problems.validation(errors);
      if (!t.from.includes(String(row.status))) {
        const allowed = Object.entries(TRANSITIONS).filter(([, x]) => x.from.includes(String(row.status))).map(([a]) => a);
        throw Problems.conflict('invalid-transition', 'Invalid state transition', `Cannot ${action} a source that is ${row.status}.`, { current_status: row.status, allowed_actions: allowed });
      }
      const now = ctx.clock.now();
      const review = action === 'approve' || action === 'reject';
      run(ctx.db, `UPDATE sources SET status = ?, updated_at = ?, revision = revision + 1,
                   reviewed_by = CASE WHEN ? THEN ? ELSE reviewed_by END, reviewed_at = CASE WHEN ? THEN ? ELSE reviewed_at END,
                   review_note = CASE WHEN ? THEN ? ELSE review_note END,
                   next_check_at = CASE WHEN ? = 'approved' THEN ? ELSE next_check_at END WHERE id = ?`,
        t.to, iso(now), review ? 1 : 0, key.name, review ? 1 : 0, iso(now), review ? 1 : 0, (value.note as string) ?? null, t.to, iso(now), String(row.id));
      return c.json(sourceOut(load(String(row.id)), base));
    });
  }

  app.get('/v1/sources/:id/snapshots', (c) => {
    requireScope(c.get('key')!, 'sources:read');
    const row = load(c.req.param('id'));
    const { limit, before } = pageParams(c);
    const rows = all<Row & { id: string }>(ctx.db, `SELECT * FROM snapshots WHERE source_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
      ...([String(row.id), ...(before ? [before] : []), limit + 1] as Array<string | number>));
    return c.json(page(c, base, rows, limit, (r) => snapshotOut(r, base, false)));
  });

  app.get('/v1/sources/:id/checks', (c) => {
    requireScope(c.get('key')!, 'sources:read');
    const row = load(c.req.param('id'));
    const { limit, before } = pageParams(c);
    const outcome = enumParam(c, 'outcome', ['baseline', 'changed', 'unchanged', 'noise', 'not_modified', 'blocked', 'error'] as const);
    const rows = all<Row & { id: string }>(ctx.db,
      `SELECT * FROM checks WHERE source_id = ? ${before ? 'AND id < ?' : ''} ${outcome ? 'AND outcome = ?' : ''} ORDER BY id DESC LIMIT ?`,
      ...([String(row.id), ...(before ? [before] : []), ...(outcome ? [outcome] : []), limit + 1] as Array<string | number>));
    return c.json(page(c, base, rows, limit, checkOut));
  });

  app.get('/v1/snapshots/:id', (c) => {
    requireScope(c.get('key')!, 'sources:read');
    const id = c.req.param('id');
    const row = isId(id, 'snp') ? one<Row>(ctx.db, 'SELECT * FROM snapshots WHERE id = ?', id) : undefined;
    if (!row) throw Problems.notFound('Snapshot', id);
    c.header('Vary', 'Accept');
    const accept = c.req.header('accept') ?? '';
    if (/text\/plain/.test(accept) && !/application\/json/.test(accept)) return c.text(String(row.text));
    return c.json(snapshotOut(row, base, true));
  });

}

/**
 * POST /v1/sources/{id}/ignore-preview: replay candidate ignore patterns over the stored snapshots
 * of a source's recent changes and report which changes they would have suppressed. Safe: it reads
 * stored text only, fetches nothing, and changes nothing, so the read-only demo key may use it.
 * CSS selector rules cannot be replayed this way because snapshots keep text, not HTML.
 */
export function registerIgnorePreview(app: Hono<Env>, ctx: Ctx, limiter: RateLimiter): void {
  const PREVIEW_CHANGES = 50;
  app.post('/v1/sources/:id/ignore-preview', async (c) => {
    const key = c.get('key')!;
    requireScope(key, 'sources:read');
    const id = c.req.param('id');
    const src = isId(id, 'src') ? one<Row>(ctx.db, 'SELECT id FROM sources WHERE id = ?', id) : undefined;
    if (!src) throw Problems.notFound('Source', id);
    const d = limiter.take(`preview:${key.id}:${c.get('clientIp')}`, 20, ctx.clock.now());
    if (!d.allowed) throw new ApiError(429, 'rate-limited', 'Too many previews', `Retry after ${d.retryAfterSec} seconds.`, {}, { 'Retry-After': String(d.retryAfterSec) });
    const body = await readJsonObject(c);
    const { value, errors } = validate(body, {
      ignore_patterns: { type: 'string[]', required: true, maxItems: 20, itemMaxLength: 200, check: (v: string[]) => (v.length && v.every((p) => p.replace(/\*/g, '').trim()) ? null : 'must list 1 to 20 patterns, each with some literal text') },
    });
    if (errors.length) throw Problems.validation(errors);
    const patterns = (value.ignore_patterns as string[]).map(compileIgnorePattern);
    const rows = all<{ id: string; detected_at: string; significance: number; meaningful: number; summary: string; from_text: string; to_text: string }>(ctx.db,
      `SELECT c.id, c.detected_at, c.significance, c.meaningful, c.summary, a.text AS from_text, b.text AS to_text
       FROM changes c JOIN snapshots a ON a.id = c.from_snapshot_id JOIN snapshots b ON b.id = c.to_snapshot_id
       WHERE c.source_id = ? ORDER BY c.id DESC LIMIT ?`, id, PREVIEW_CHANGES);
    const budget = { left: PREVIEW_BUDGET };
    const results: Array<{ change_id: string; detected_at: string; significance: number; meaningful: boolean; summary: string; suppressed: boolean }> = [];
    let exhausted = false;
    for (const r of rows) {
      const a = applyIgnorePatternsToText(r.from_text, patterns, budget);
      const b = a === null ? null : applyIgnorePatternsToText(r.to_text, patterns, budget);
      if (a === null || b === null) {
        exhausted = true;
        break;
      }
      results.push({ change_id: r.id, detected_at: r.detected_at, significance: r.significance, meaningful: r.meaningful === 1, summary: r.summary, suppressed: a === b });
    }
    const meaningful = results.filter((r) => r.meaningful);
    return c.json({
      object: 'ignore_preview',
      source_id: id,
      ignore_patterns: value.ignore_patterns,
      changes_examined: results.length,
      would_suppress: results.filter((r) => r.suppressed).length,
      meaningful_examined: meaningful.length,
      meaningful_suppressed: meaningful.filter((r) => r.suppressed).length,
      budget_exhausted: exhausted,
      note: 'Replays the patterns over stored snapshot text of the most recent changes, on top of the rules the source already has. CSS selector rules cannot be replayed because snapshots store text, not HTML.',
      changes: results,
    });
  });
}
