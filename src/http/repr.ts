import { parseJson, type Row } from '../db.ts';

/**
 * Wire representations. Database rows never leave the process directly: each
 * resource has one mapping function, so internal columns (key hashes, webhook
 * secrets, raw-hash bookkeeping) can't leak by accident when a column is added.
 */
type R = Row & Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function sourceOut(r: R, base: string) {
  return {
    id: r.id,
    object: 'source',
    url: r.url,
    name: r.name,
    status: r.status,
    tags: parseJson<string[]>(r.tags, []),
    selector: s(r.selector),
    ignore_selectors: parseJson<string[]>(r.ignore_selectors, []),
    ignore_patterns: parseJson<string[]>(r.ignore_patterns, []),
    check_interval_minutes: n(r.check_interval_minutes),
    min_significance: n(r.min_significance),
    notes: s(r.notes),
    review: { reviewed_by: s(r.reviewed_by), reviewed_at: s(r.reviewed_at), note: s(r.review_note) },
    last_checked_at: s(r.last_checked_at),
    last_outcome: s(r.last_outcome),
    next_check_at: r.status === 'approved' ? s(r.next_check_at) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    revision: n(r.revision),
    links: {
      self: `${base}/v1/sources/${r.id}`,
      snapshots: `${base}/v1/sources/${r.id}/snapshots`,
      changes: `${base}/v1/changes?source_id=${r.id}`,
      checks: `${base}/v1/sources/${r.id}/checks`,
    },
  };
}

export function snapshotOut(r: R, base: string, withText: boolean) {
  return {
    id: r.id,
    object: 'snapshot',
    source_id: r.source_id,
    captured_at: r.captured_at,
    content_hash: `sha256:${r.content_hash}`,
    word_count: n(r.word_count),
    byte_size: n(r.byte_size),
    http_status: n(r.http_status),
    facts: parseJson<unknown[]>(r.facts, []),
    ...(withText ? { text: r.text } : {}),
    links: { self: `${base}/v1/snapshots/${r.id}`, source: `${base}/v1/sources/${r.source_id}` },
  };
}

export function checkOut(r: R) {
  return {
    id: r.id,
    object: 'check',
    source_id: r.source_id,
    run_id: s(r.run_id),
    started_at: r.started_at,
    duration_ms: n(r.duration_ms),
    outcome: r.outcome,
    http_status: n(r.http_status),
    bytes: n(r.bytes),
    snapshot_id: s(r.snapshot_id),
    change_id: s(r.change_id),
    error: s(r.error),
  };
}

export function changeOut(r: R, base: string, withHunks: boolean) {
  return {
    id: r.id,
    object: 'change',
    source_id: r.source_id,
    source_name: s(r.source_name),
    detected_at: r.detected_at,
    significance: n(r.significance),
    meaningful: r.meaningful === 1,
    category: r.category,
    summary: r.summary,
    words_added: n(r.words_added),
    words_removed: n(r.words_removed),
    fact_changes: parseJson<unknown[]>(r.fact_changes, []),
    signals: parseJson<string[]>(r.signals, []),
    from_snapshot_id: r.from_snapshot_id,
    to_snapshot_id: r.to_snapshot_id,
    ...(withHunks ? { hunks: parseJson<unknown[]>(r.hunks, []) } : {}),
    links: {
      self: `${base}/v1/changes/${r.id}`,
      source: `${base}/v1/sources/${r.source_id}`,
      from_snapshot: `${base}/v1/snapshots/${r.from_snapshot_id}`,
      to_snapshot: `${base}/v1/snapshots/${r.to_snapshot_id}`,
    },
  };
}

export function runOut(r: R, base: string) {
  return {
    id: r.id,
    object: 'check_run',
    status: r.status,
    source_ids: parseJson<string[]>(r.source_ids, []),
    created_at: r.created_at,
    started_at: s(r.started_at),
    finished_at: s(r.finished_at),
    results: parseJson<unknown[]>(r.results, []),
    links: { self: `${base}/v1/check-runs/${r.id}` },
  };
}

export function digestOut(r: R, base: string, withPayload: boolean) {
  return {
    id: r.id,
    object: 'digest',
    period_start: r.period_start,
    period_end: r.period_end,
    created_at: r.created_at,
    change_count: n(r.change_count),
    email_status: r.email_status,
    ...(withPayload ? { payload: parseJson<unknown>(r.payload, {}) } : {}),
    links: { self: `${base}/v1/digests/${r.id}` },
  };
}

export function webhookOut(r: R, base: string) {
  const secret = String(r.secret);
  return {
    id: r.id,
    object: 'webhook',
    url: r.url,
    description: s(r.description),
    events: parseJson<string[]>(r.events, []),
    active: r.active === 1,
    secret_hint: `${secret.slice(0, 10)}…`,
    created_at: r.created_at,
    links: { self: `${base}/v1/webhooks/${r.id}`, deliveries: `${base}/v1/webhooks/${r.id}/deliveries` },
  };
}

export function deliveryOut(r: R) {
  return {
    id: r.id,
    object: 'delivery',
    webhook_id: r.webhook_id,
    message_id: r.message_id,
    event_type: r.event_type,
    status: r.status,
    attempts: n(r.attempts),
    last_response_status: n(r.last_response_status),
    last_error: s(r.last_error),
    created_at: r.created_at,
    next_attempt_at: s(r.next_attempt_at),
    delivered_at: s(r.delivered_at),
  };
}
