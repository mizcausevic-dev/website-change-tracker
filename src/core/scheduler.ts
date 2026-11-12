import { iso } from '../clock.ts';
import { all, one, run } from '../db.ts';
import { newId } from '../ids.ts';
import type { Ctx } from '../context.ts';
import { checkSource, getSourceRow, type CheckResult, type SourceRow } from './pipeline.ts';
import { createDigest } from './digest.ts';
import { deliverDue, enqueueEvent } from './webhooks.ts';

const DAY = 86_400_000;
const RECHECK_FLOOR_MS = 60_000;
let lastPrune = 0;

/**
 * Retention, run at most every 10 minutes. Keeps the in-memory database bounded: operational rows
 * expire, history older than the 30-day window goes, and on the public demo, visitor proposals
 * expire after 30 minutes so the shared review queue can't be filled for long.
 */
export function prune(ctx: Ctx, now: number): void {
  if (now - lastPrune < 10 * 60_000) return;
  lastPrune = now;
  run(ctx.db, 'DELETE FROM idempotency_keys WHERE created_at < ?', now - DAY);
  run(ctx.db, "DELETE FROM check_runs WHERE created_at < ? AND status IN ('succeeded','failed')", iso(now - DAY));
  run(ctx.db, "DELETE FROM deliveries WHERE created_at < ? AND status IN ('succeeded','failed')", iso(now - 7 * DAY));
  run(ctx.db, 'DELETE FROM checks WHERE started_at < ?', iso(now - 35 * DAY));
  if (ctx.config.demoMode) {
    run(ctx.db, "DELETE FROM sources WHERE status = 'pending' AND proposer_fp IS NOT NULL AND created_at < ?", iso(now - 30 * 60_000));
  }
}

/** Check one source unless a check for it is already running. */
export async function guardedCheck(ctx: Ctx, source: SourceRow, runId: string | null): Promise<CheckResult | null> {
  if (ctx.inFlight.has(source.id)) return null;
  ctx.inFlight.add(source.id);
  try {
    return await checkSource(ctx, source, runId);
  } finally {
    ctx.inFlight.delete(source.id);
  }
}

/** Bounded-concurrency map. */
async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function tick(ctx: Ctx): Promise<{ checked: number; delivered: number; digest: string | null }> {
  const now = ctx.clock.now();
  const due = all<SourceRow>(ctx.db, `SELECT * FROM sources WHERE status = 'approved' AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at LIMIT 10`, iso(now));
  const results = await pool(due, 3, (s) => guardedCheck(ctx, s, null));

  // Daily digest for the previous UTC day, once.
  const dayStart = Math.floor(now / DAY) * DAY;
  let digest: string | null = null;
  const exists = one(ctx.db, 'SELECT id FROM digests WHERE period_start = ? AND period_end = ?', iso(dayStart - DAY), iso(dayStart));
  if (!exists) digest = (await createDigest(ctx, dayStart - DAY, dayStart)).id;

  const delivered = await deliverDue(ctx.db, ctx.transport, ctx.clock.now());
  prune(ctx, ctx.clock.now());
  return { checked: results.filter(Boolean).length, delivered, digest };
}

export function startScheduler(ctx: Ctx, everyMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick(ctx)
      .catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'scheduler tick failed', err: String(err) })))
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface RunResult {
  source_id: string;
  outcome: string;
  check_id: string | null;
  change_id: string | null;
  significance: number | null;
  error: string | null;
}

/** Create an async check run. Returns immediately; work happens off the request path. */
export function createRun(ctx: Ctx, sourceIds: string[], requestedBy: string): string {
  const now = ctx.clock.now();
  const id = newId('run', now);
  run(ctx.db, `INSERT INTO check_runs (id, status, requested_by, source_ids, created_at) VALUES (?, 'queued', ?, ?, ?)`, id, requestedBy, JSON.stringify(sourceIds), iso(now));
  const p = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
    run(ctx.db, `UPDATE check_runs SET status = 'running', started_at = ? WHERE id = ?`, iso(ctx.clock.now()), id);
    try {
      const results: RunResult[] = [];
      for (const sid of sourceIds) {
        const src = getSourceRow(ctx, sid);
        if (!src || src.status !== 'approved') {
          results.push({ source_id: sid, outcome: 'skipped', check_id: null, change_id: null, significance: null, error: 'source is not approved' });
          continue;
        }
        // Politeness and storage bound: a source checked in the last minute is not fetched again.
        const last = src.last_checked_at ? Date.parse(src.last_checked_at) : 0;
        if (ctx.clock.now() - last < RECHECK_FLOOR_MS) {
          results.push({ source_id: sid, outcome: 'skipped', check_id: null, change_id: null, significance: null, error: 'checked less than 60 seconds ago' });
          continue;
        }
        const r = await guardedCheck(ctx, src, id);
        results.push(r
          ? { source_id: sid, outcome: r.outcome, check_id: r.check_id, change_id: r.change_id, significance: r.significance, error: r.error }
          : { source_id: sid, outcome: 'skipped', check_id: null, change_id: null, significance: null, error: 'a check for this source is already in progress' });
      }
      const fin = ctx.clock.now();
      run(ctx.db, `UPDATE check_runs SET status = 'succeeded', finished_at = ?, results = ? WHERE id = ?`, iso(fin), JSON.stringify(results), id);
      enqueueEvent(ctx.db, fin, 'check_run.completed', { run_id: id, results: results.length, changes: results.filter((r) => r.change_id).length });
      await deliverDue(ctx.db, ctx.transport, fin);
    } catch (err) {
      run(ctx.db, `UPDATE check_runs SET status = 'failed', finished_at = ?, results = ? WHERE id = ?`, iso(ctx.clock.now()), JSON.stringify([{ error: String(err) }]), id);
    } finally {
      ctx.runPromises.delete(id);
    }
  });
  ctx.runPromises.set(id, p);
  return id;
}
