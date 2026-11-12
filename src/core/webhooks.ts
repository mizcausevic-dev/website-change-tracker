import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { all, run, type Db } from '../db.ts';
import { iso } from '../clock.ts';
import { newId } from '../ids.ts';
import type { Transport } from './fetcher.ts';

/**
 * Webhook signing follows the Standard Webhooks scheme: headers `webhook-id`,
 * `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>` over
 * `${id}.${timestamp}.${body}`, with secrets of the form `whsec_<base64>`.
 * Receivers reject stale timestamps, which blocks replay of captured requests.
 */
export const EVENT_TYPES = ['change.detected', 'digest.ready', 'check_run.completed'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

function key(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
}

export function sign(secret: string, msgId: string, timestampSec: number, body: string): string {
  const mac = createHmac('sha256', key(secret)).update(`${msgId}.${timestampSec}.${body}`).digest('base64');
  return `v1,${mac}`;
}

export function verify(secret: string, headers: Record<string, string | undefined>, body: string, nowSec: number, toleranceSec = 300): boolean {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const sigHeader = headers['webhook-signature'];
  if (!id || !Number.isInteger(ts) || !sigHeader) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, id, ts, body));
  return sigHeader.split(' ').some((candidate) => {
    const got = Buffer.from(candidate);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

const RETRY_SECONDS = [60, 300, 1800, 7200, 21600];
export const MAX_ATTEMPTS = RETRY_SECONDS.length + 1;

/** Fan an event out to every active webhook subscribed to it. Rows are delivered by `deliverDue`. */
export function enqueueEvent(db: Db, now: number, type: EventType, data: unknown): number {
  const hooks = all<{ id: string; events: string }>(db, 'SELECT id, events FROM webhooks WHERE active = 1');
  let n = 0;
  for (const h of hooks) {
    const events = JSON.parse(h.events) as string[];
    if (!events.includes(type)) continue;
    const messageId = newId('msg', now);
    const payload = JSON.stringify({ type, timestamp: iso(now), data });
    run(db, `INSERT INTO deliveries (id, webhook_id, message_id, event_type, payload, status, attempts, created_at, next_attempt_at) VALUES (?,?,?,?,?, 'pending', 0, ?, ?)`, newId('dlv', now), h.id, messageId, type, payload, iso(now), iso(now));
    n++;
  }
  return n;
}

export async function deliverDue(db: Db, transport: Transport, now: number, limit = 20): Promise<number> {
  const due = all<{ id: string; message_id: string; payload: string; attempts: number; url: string; secret: string }>(
    db,
    `SELECT d.id, d.message_id, d.payload, d.attempts, w.url, w.secret FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status IN ('pending','retrying') AND d.next_attempt_at <= ? AND w.active = 1 ORDER BY d.next_attempt_at LIMIT ?`,
    iso(now),
    limit,
  );
  for (const d of due) {
    const ts = Math.floor(now / 1000);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await transport({
        url: d.url,
        method: 'POST',
        body: d.payload,
        headers: {
          'content-type': 'application/json',
          'webhook-id': d.message_id,
          'webhook-timestamp': String(ts),
          'webhook-signature': sign(d.secret, d.message_id, ts, d.payload),
        },
      });
      status = res.status;
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    const attempts = d.attempts + 1;
    if (!error) {
      run(db, `UPDATE deliveries SET status='succeeded', attempts=?, last_response_status=?, last_error=NULL, delivered_at=?, next_attempt_at=NULL WHERE id=?`, attempts, status, iso(now), d.id);
    } else if (attempts >= MAX_ATTEMPTS) {
      run(db, `UPDATE deliveries SET status='failed', attempts=?, last_response_status=?, last_error=?, next_attempt_at=NULL WHERE id=?`, attempts, status, error, d.id);
    } else {
      const next = now + (RETRY_SECONDS[attempts - 1] ?? 21600) * 1000;
      run(db, `UPDATE deliveries SET status='retrying', attempts=?, last_response_status=?, last_error=?, next_attempt_at=? WHERE id=?`, attempts, status, error, iso(next), d.id);
    }
  }
  return due.length;
}
