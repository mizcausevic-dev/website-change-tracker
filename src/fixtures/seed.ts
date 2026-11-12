import { ManualClock, iso } from '../clock.ts';
import type { Ctx } from '../context.ts';
import { all, one, run, tx } from '../db.ts';
import { newId } from '../ids.ts';
import { createDigest } from '../core/digest.ts';
import { checkSource, type SourceRow } from '../core/pipeline.ts';
import { generateSecret } from '../core/webhooks.ts';

const DAY = 86_400_000;

interface SeedSource {
  url: string;
  name: string;
  tags: string[];
  selector: string | null;
  ignore_selectors: string[];
  ignore_patterns?: string[];
  interval: number;
  min: number;
  status: 'approved' | 'pending' | 'rejected';
  notes?: string;
  review_note?: string;
}

export const DEMO_SOURCES: SeedSource[] = [
  { url: 'https://larkspur.example/pricing', name: 'Larkspur Cloud · Pricing', tags: ['pricing', 'competitor'], selector: 'main', ignore_selectors: ['.testimonial'], interval: 60, min: 20, status: 'approved', notes: 'Track list prices and plan features.' },
  { url: 'https://fennel.example/changelog', name: 'Fennel Analytics · Changelog', tags: ['product', 'competitor'], selector: 'main', ignore_selectors: [], interval: 120, min: 15, status: 'approved' },
  { url: 'https://quarry.example/legal/terms', name: 'Quarry Bank · Terms of Service', tags: ['legal', 'vendor'], selector: 'main', ignore_selectors: [], interval: 360, min: 10, status: 'approved', notes: 'Vendor contract dependency. Legal wants every edit.' },
  { url: 'https://halyard.example/status', name: 'Halyard · System status', tags: ['status', 'vendor'], selector: 'main', ignore_selectors: [], interval: 30, min: 45, status: 'approved' },
  { url: 'https://orrery.example/careers', name: 'Orrery Labs · Careers', tags: ['hiring', 'competitor'], selector: 'main', ignore_selectors: [], interval: 180, min: 20, status: 'approved' },
  { url: 'https://tessellate.example/docs/rate-limits', name: 'Tessellate API · Rate limits', tags: ['product', 'vendor'], selector: 'main', ignore_selectors: ['.feedback'], interval: 360, min: 15, status: 'approved' },
  { url: 'https://bramble.example/journal', name: 'Bramble & Co. · Journal', tags: ['content'], selector: null, ignore_selectors: ['.ad-slot', '.trending'], interval: 60, min: 30, status: 'approved', notes: 'Noisy page: ads, view counters, session tokens.' },
  { url: 'https://kestrel.example/packs/trail-38', name: 'Kestrel Outfitters · Trail Pack 38L', tags: ['pricing', 'retail'], selector: 'main', ignore_selectors: [], interval: 60, min: 20, status: 'approved' },
  { url: 'https://vireo.example/privacy', name: 'Vireo Insurance · Privacy Notice', tags: ['legal'], selector: 'main', ignore_selectors: [], interval: 720, min: 10, status: 'pending', notes: 'Proposed by procurement; awaiting review.' },
  { url: 'https://listings.example/directory/insurers', name: 'Insurer directory (aggregator)', tags: ['legal'], selector: null, ignore_selectors: [], interval: 1440, min: 20, status: 'rejected', review_note: 'Rejected: aggregator and directory sites are deny-by-default under the source-rights policy.' },
];

/**
 * Backfill `days` of history by replaying checks with a simulated clock. The
 * fixture sites are pure functions of time, so this produces the same history
 * the live scheduler would have recorded, and it is identical on every boot.
 */
export async function seedDemo(ctx: Ctx, now: number, days = 30): Promise<{ checks: number; changes: number; ms: number }> {
  if (one(ctx.db, 'SELECT 1 AS x FROM sources LIMIT 1')) return { checks: 0, changes: 0, ms: 0 };
  const started = performance.now();
  const realClock = ctx.clock;
  const sim = new ManualClock(now - days * DAY - DAY);
  ctx.clock = sim;
  try {
    const t0 = sim.now();
    tx(ctx.db, () => {
      for (const s of DEMO_SOURCES) {
        const id = newId('src', t0);
        const reviewed = s.status !== 'pending';
        run(ctx.db, `INSERT INTO sources (id, url, name, status, tags, selector, ignore_selectors, ignore_patterns, check_interval_minutes, min_significance, notes, review_note, proposed_by, reviewed_by, reviewed_at, created_at, updated_at, next_check_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, s.url, s.name, s.status, JSON.stringify(s.tags), s.selector, JSON.stringify(s.ignore_selectors), JSON.stringify(s.ignore_patterns ?? []),
          s.interval, s.min, s.notes ?? null, s.review_note ?? null, s.status === 'pending' ? 'Demo public key' : 'Operations admin',
          reviewed ? 'Operations admin' : null, reviewed ? iso(t0 + 3600_000) : null, iso(t0), iso(t0), s.status === 'approved' ? iso(t0 + DAY) : null);
      }
    });

    // Replay: one global timeline, always advancing to whichever source is due next.
    const approved = all<SourceRow & { next_check_at: string }>(ctx.db, "SELECT * FROM sources WHERE status = 'approved'");
    const due = new Map(approved.map((s, i) => [s.id, Date.parse(s.next_check_at) + i * 97_000]));
    let checks = 0;
    for (;;) {
      let nextId: string | null = null;
      let nextAt = Infinity;
      for (const [id, at] of due) if (at < nextAt) (nextAt = at, nextId = id);
      if (!nextId || nextAt > now) break;
      sim.set(nextAt);
      const src = one<SourceRow & { next_check_at: string }>(ctx.db, 'SELECT * FROM sources WHERE id = ?', nextId)!;
      await checkSource(ctx, src, null);
      checks++;
      const after = one<{ next_check_at: string }>(ctx.db, 'SELECT next_check_at FROM sources WHERE id = ?', nextId)!;
      due.set(nextId, Date.parse(after.next_check_at));
    }

    // Daily digests for the backfilled days. Not delivered: they predate this process.
    const today = Math.floor(now / DAY) * DAY;
    for (let d = today - days * DAY; d < today; d += DAY) {
      sim.set(d + DAY + 5 * 60_000);
      await createDigest(ctx, d, d + DAY, { send: false, createdAt: d + DAY + 5 * 60_000 });
    }

    // Webhook pointed at the in-process demo receiver, which verifies every signature.
    sim.set(now - 2 * DAY);
    const secret = generateSecret();
    run(ctx.db, 'INSERT INTO webhooks (id, url, description, secret, events, active, created_at) VALUES (?,?,?,?,?,1,?)',
      newId('whk', sim.now()), 'https://receiver.example/hooks/driftline', 'Demo receiver: verifies Standard Webhooks signatures in-process', secret,
      JSON.stringify(['change.detected', 'digest.ready', 'check_run.completed']), iso(sim.now()));
    ctx.receiver.secret = secret;

    // Live checks start shortly after boot rather than all at once.
    for (const [i, s] of approved.entries()) run(ctx.db, 'UPDATE sources SET next_check_at = ? WHERE id = ?', iso(now + (i + 1) * 20_000), s.id);

    const changes = one<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM changes')!.n;
    return { checks, changes, ms: Math.round(performance.now() - started) };
  } finally {
    ctx.clock = realClock;
  }
}
