import { iso } from '../clock.ts';
import { all, parseJson, type Db } from '../db.ts';
import type { Fact } from './extract.ts';
import { CATEGORIES } from './significance.ts';

const DAY = 86_400_000;

/** Aggregates behind the dashboard. One endpoint, so the dashboard makes one conditional request per refresh. */
export function overview(db: Db, now: number, days: number) {
  const end = Math.floor(now / DAY) * DAY + DAY; // end of today (UTC)
  const start = end - days * DAY;
  const dayKeys = Array.from({ length: days }, (_, i) => iso(start + i * DAY).slice(0, 10));
  const idx = new Map(dayKeys.map((d, i) => [d, i]));

  const sources = all<{ id: string; name: string; url: string; status: string; last_outcome: string | null; last_checked_at: string | null; tags: string }>(
    db, 'SELECT id, name, url, status, last_outcome, last_checked_at, tags FROM sources ORDER BY name');
  const byStatus: Record<string, number> = { pending: 0, approved: 0, paused: 0, rejected: 0 };
  for (const s of sources) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;

  const checks = all<{ day: string; outcome: string; n: number; ms: number; bytes: number }>(db,
    `SELECT substr(started_at, 1, 10) AS day, outcome, COUNT(*) AS n, SUM(duration_ms) AS ms, SUM(COALESCE(bytes, 0)) AS bytes
     FROM checks WHERE started_at >= ? GROUP BY day, outcome`, iso(start));
  const outcomes: Record<string, number> = { baseline: 0, changed: 0, unchanged: 0, noise: 0, not_modified: 0, blocked: 0, error: 0 };
  const daily = dayKeys.map((date) => ({ date, checks: 0, noise: 0, not_modified: 0, changed: 0, meaningful: Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<string, number>, minor: 0 }));
  let bytes = 0;
  for (const r of checks) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + r.n;
    bytes += r.bytes;
    const d = daily[idx.get(r.day) ?? -1];
    if (!d) continue;
    d.checks += r.n;
    if (r.outcome === 'noise') d.noise += r.n;
    if (r.outcome === 'not_modified') d.not_modified += r.n;
    if (r.outcome === 'changed') d.changed += r.n;
  }
  const durations = all<{ duration_ms: number }>(db, 'SELECT duration_ms FROM checks WHERE started_at >= ? ORDER BY duration_ms', iso(now - 7 * DAY));
  const p = (q: number): number => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(q * durations.length))]!.duration_ms : 0);

  const changes = all<{ source_id: string; day: string; category: string; meaningful: number; significance: number }>(db,
    `SELECT source_id, substr(detected_at, 1, 10) AS day, category, meaningful, significance FROM changes WHERE detected_at >= ?`, iso(start));
  const heat = new Map<string, number[]>(sources.map((s) => [s.id, Array<number>(days).fill(0)]));
  const spark = new Map<string, number[]>(sources.map((s) => [s.id, Array<number>(days).fill(0)]));
  let meaningful = 0;
  const byCategory: Record<string, number> = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const ch of changes) {
    const i = idx.get(ch.day);
    if (i === undefined) continue;
    const d = daily[i]!;
    if (ch.meaningful) {
      meaningful++;
      byCategory[ch.category] = (byCategory[ch.category] ?? 0) + 1;
      d.meaningful[ch.category] = (d.meaningful[ch.category] ?? 0) + 1;
      const sp = spark.get(ch.source_id);
      if (sp) sp[i] = (sp[i] ?? 0) + 1;
    } else d.minor++;
    const h = heat.get(ch.source_id);
    if (h) h[i] = Math.max(h[i] ?? 0, ch.significance);
  }

  // Price series: every snapshot's extracted price facts, per source and key.
  const snaps = all<{ source_id: string; captured_at: string; facts: string }>(db,
    `SELECT source_id, captured_at, facts FROM snapshots WHERE facts != '[]' ORDER BY id`);
  const series = new Map<string, { source_id: string; key: string; currency: string; points: Array<{ t: string; v: number }> }>();
  for (const sn of snaps) {
    for (const f of parseJson<Fact[]>(sn.facts, [])) {
      const k = `${sn.source_id}|${f.key}`;
      const s = series.get(k) ?? { source_id: sn.source_id, key: f.key, currency: f.currency, points: [] };
      const last = s.points[s.points.length - 1];
      if (!last || last.v !== f.value) s.points.push({ t: sn.captured_at, v: f.value });
      series.set(k, s);
    }
  }
  // Only series that actually moved are worth charting.
  const priceSeries = [...series.values()].filter((s) => s.points.length > 1);

  const counts = all<{ source_id: string; checks: number; changes: number }>(db,
    `SELECT s.id AS source_id,
       (SELECT COUNT(*) FROM checks c WHERE c.source_id = s.id AND c.started_at >= ?) AS checks,
       (SELECT COUNT(*) FROM changes g WHERE g.source_id = s.id AND g.meaningful = 1 AND g.detected_at >= ?) AS changes
     FROM sources s`, iso(now - 7 * DAY), iso(now - 7 * DAY));
  const countMap = new Map(counts.map((c) => [c.source_id, c]));

  const totalChecks = Object.values(outcomes).reduce((a, b) => a + b, 0);
  const contentChecks = outcomes.changed! + outcomes.unchanged! + outcomes.noise! + outcomes.not_modified!;
  return {
    object: 'stats_overview',
    // Timestamp of the newest data, not the request time: the body (and so its ETag) only changes when data does.
    as_of: asOf(db, now),
    window: { days, start: iso(start), end: iso(end) },
    totals: {
      sources: byStatus,
      checks: totalChecks,
      outcomes,
      changes: outcomes.changed,
      meaningful_changes: meaningful,
      noise_suppressed: outcomes.noise,
      noise_rate: contentChecks ? Math.round((outcomes.noise! / contentChecks) * 1000) / 1000 : 0,
      conditional_hits: outcomes.not_modified,
      bytes_fetched: bytes,
      latency_ms: { p50: p(0.5), p95: p(0.95) },
    },
    by_category: byCategory,
    daily,
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      host: new URL(s.url).host,
      status: s.status,
      tags: parseJson<string[]>(s.tags, []),
      last_outcome: s.last_outcome,
      last_checked_at: s.last_checked_at,
      checks_7d: countMap.get(s.id)?.checks ?? 0,
      meaningful_changes_7d: countMap.get(s.id)?.changes ?? 0,
      daily_meaningful: spark.get(s.id) ?? [],
      daily_max_significance: heat.get(s.id) ?? [],
    })),
    price_series: priceSeries,
  };
}

function asOf(db: Db, now: number): string {
  const r = all<{ t: string | null }>(db,
    `SELECT MAX(t) AS t FROM (SELECT MAX(started_at) AS t FROM checks UNION ALL SELECT MAX(detected_at) FROM changes
       UNION ALL SELECT MAX(created_at) FROM deliveries UNION ALL SELECT MAX(updated_at) FROM sources)`)[0];
  return r?.t ?? iso(now);
}
