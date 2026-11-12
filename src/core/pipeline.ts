import { iso } from '../clock.ts';
import { one, parseJson, run, tx } from '../db.ts';
import { newId } from '../ids.ts';
import type { Ctx } from '../context.ts';
import { diffText } from './diff.ts';
import { extract, type Fact } from './extract.ts';
import { compareFacts, score } from './significance.ts';
import { enqueueEvent } from './webhooks.ts';

export interface SourceRow {
  id: string;
  url: string;
  name: string;
  status: string;
  selector: string | null;
  ignore_selectors: string;
  ignore_patterns: string;
  check_interval_minutes: number;
  min_significance: number;
  http_etag: string | null;
  http_last_modified: string | null;
  last_raw_hash: string | null;
  last_checked_at: string | null;
  /** Set when extraction settings change; the next successful fetch becomes a silent new baseline. */
  rebaseline_pending: number;
  revision: number;
}

export type Outcome = 'baseline' | 'changed' | 'unchanged' | 'noise' | 'not_modified' | 'blocked' | 'error';

export interface CheckResult {
  check_id: string;
  source_id: string;
  outcome: Outcome;
  change_id: string | null;
  significance: number | null;
  meaningful: boolean | null;
  error: string | null;
}

/** ±10% jitter so sources added together don't stay synchronized forever. */
function nextCheck(now: number, minutes: number, salt: string): number {
  const h = [...salt].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, now >>> 0);
  const jitter = ((h % 2001) / 1000 - 1) * 0.1;
  return now + Math.round(minutes * 60_000 * (1 + jitter));
}

export async function checkSource(ctx: Ctx, source: SourceRow, runId: string | null = null): Promise<CheckResult> {
  const { db, clock } = ctx;
  const startedAt = clock.now();
  const page = await ctx.fetcher.fetchPage(source.url, { etag: source.http_etag, lastModified: source.http_last_modified });
  const now = clock.now();

  return tx(db, () => {
    // The fetch awaited outside this transaction, so the source may have been edited or deleted meanwhile.
    const current = one<{ revision: number }>(db, 'SELECT revision FROM sources WHERE id = ?', source.id);
    if (!current) {
      return { check_id: '', source_id: source.id, outcome: 'error' as Outcome, change_id: null, significance: null, meaningful: null, error: 'source deleted during check' };
    }
    // Edited mid-check: this result used the old rules, so it must not consume the re-baseline flag
    // or restore the HTTP validators and raw hash that the edit cleared.
    const sameRevision = current.revision === source.revision;
    const warnings: string[] = [];
    const checkId = newId('chk', startedAt);
    let outcome: Outcome;
    let snapshotId: string | null = null;
    let changeId: string | null = null;
    let significance: number | null = null;
    let meaningful: boolean | null = null;
    let rawHash = source.last_raw_hash;

    if (page.kind === 'not_modified') outcome = 'not_modified';
    else if (page.kind === 'blocked') outcome = 'blocked';
    else if (page.kind === 'error') outcome = 'error';
    else {
      const ex = extract(page.body, {
        selector: source.selector,
        ignoreSelectors: parseJson<string[]>(source.ignore_selectors, []),
        ignorePatterns: parseJson<string[]>(source.ignore_patterns, []),
      });
      rawHash = ex.rawHash;
      if (ex.maskedTokens['ignore_pattern_budget_exceeded']) warnings.push('ignore_patterns_budget_exceeded');
      if (!ex.selectorMatched) warnings.push('selector_not_found');
      const last = one<{ id: string; content_hash: string; text: string; word_count: number; facts: string }>(
        db,
        'SELECT id, content_hash, text, word_count, facts FROM snapshots WHERE source_id = ? ORDER BY id DESC LIMIT 1',
        source.id,
      );
      if (last && last.content_hash === ex.hash) {
        outcome = ex.rawHash !== source.last_raw_hash && source.last_raw_hash !== null ? 'noise' : 'unchanged';
      } else {
        snapshotId = newId('snp', now);
        run(db, `INSERT INTO snapshots (id, source_id, captured_at, content_hash, text, word_count, byte_size, http_status, facts) VALUES (?,?,?,?,?,?,?,?,?)`,
          snapshotId, source.id, iso(now), ex.hash, ex.text, ex.wordCount, page.bytes, page.status ?? 200, JSON.stringify(ex.facts));
        // After an edit to the extraction settings, old and new snapshots were produced by different
        // rules, so their difference says nothing about the page. Record a new baseline instead of a
        // change. Trade-off: a real edit landing in the same check is folded into the baseline.
        if (!last || source.rebaseline_pending) outcome = 'baseline';
        else {
          outcome = 'changed';
          const d = diffText(last.text, ex.text);
          const factChanges = compareFacts(parseJson<Fact[]>(last.facts, []), ex.facts);
          const sc = score(d, last.word_count, factChanges);
          significance = sc.significance;
          meaningful = sc.significance >= source.min_significance;
          changeId = newId('chg', now);
          run(db, `INSERT INTO changes (id, source_id, from_snapshot_id, to_snapshot_id, detected_at, significance, category, meaningful, summary, words_added, words_removed, hunks, fact_changes, signals)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            changeId, source.id, last.id, snapshotId, iso(now), sc.significance, sc.category, meaningful ? 1 : 0, sc.summary,
            d.wordsAdded, d.wordsRemoved, JSON.stringify(d.hunks), JSON.stringify(sc.factChanges), JSON.stringify(sc.signals));
          if (meaningful) {
            enqueueEvent(db, now, 'change.detected', {
              change_id: changeId, source_id: source.id, source_name: source.name, url: source.url,
              significance: sc.significance, category: sc.category, summary: sc.summary,
              links: { self: `${ctx.config.publicBaseUrl}/v1/changes/${changeId}` },
            });
          }
        }
      }
    }

    run(db, `INSERT INTO checks (id, source_id, run_id, started_at, duration_ms, outcome, http_status, bytes, snapshot_id, change_id, error, warnings) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      checkId, source.id, runId, iso(startedAt), page.durationMs, outcome, page.status, page.bytes, snapshotId, changeId, page.error, JSON.stringify(warnings));
    run(db, `UPDATE sources SET last_checked_at = ?, last_outcome = ?, next_check_at = ? WHERE id = ?`,
      iso(now), outcome, iso(nextCheck(now, source.check_interval_minutes, source.id)), source.id);
    if (sameRevision) {
      run(db, `UPDATE sources SET http_etag = COALESCE(?, http_etag), http_last_modified = COALESCE(?, http_last_modified), last_raw_hash = ?,
               rebaseline_pending = CASE WHEN ? THEN 0 ELSE rebaseline_pending END WHERE id = ?`,
        page.etag, page.lastModified, rawHash, page.kind === 'ok' ? 1 : 0, source.id);
    }

    return { check_id: checkId, source_id: source.id, outcome, change_id: changeId, significance, meaningful, error: page.error };
  });
}

export function getSourceRow(ctx: Ctx, id: string): SourceRow | undefined {
  return one<SourceRow>(ctx.db, 'SELECT * FROM sources WHERE id = ?', id);
}
