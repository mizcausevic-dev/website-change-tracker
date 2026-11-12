import { iso } from '../clock.ts';
import { all, one, run } from '../db.ts';
import { newId } from '../ids.ts';
import type { Ctx } from '../context.ts';
import { enqueueEvent } from './webhooks.ts';

interface DigestChange {
  id: string;
  source_id: string;
  source_name: string;
  url: string;
  detected_at: string;
  significance: number;
  category: string;
  summary: string;
}
export interface DigestPayload {
  period: { start: string; end: string };
  totals: { checks: number; noise_suppressed: number; changes: number; meaningful: number; sources_changed: number };
  by_category: Record<string, number>;
  sources: Array<{ source_id: string; source_name: string; url: string; changes: DigestChange[] }>;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CAT_COLOR: Record<string, string> = { pricing: '#b45309', legal: '#b42318', status: '#1f6f43', product: '#1f4fd1', hiring: '#7a4b12', content: '#475467' };

export function buildDigestPayload(ctx: Ctx, start: number, end: number): DigestPayload {
  const rows = all<DigestChange>(ctx.db,
    `SELECT c.id, c.source_id, s.name AS source_name, s.url, c.detected_at, c.significance, c.category, c.summary
     FROM changes c JOIN sources s ON s.id = c.source_id
     WHERE c.meaningful = 1 AND c.detected_at >= ? AND c.detected_at < ? ORDER BY c.significance DESC, c.id`, iso(start), iso(end));
  const t = one<{ checks: number; noise: number; changes: number }>(ctx.db,
    `SELECT COUNT(*) AS checks, SUM(outcome = 'noise') AS noise, SUM(outcome = 'changed') AS changes FROM checks WHERE started_at >= ? AND started_at < ?`, iso(start), iso(end))!;
  const bySource = new Map<string, DigestPayload['sources'][number]>();
  const byCategory: Record<string, number> = {};
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    const entry = bySource.get(r.source_id) ?? { source_id: r.source_id, source_name: r.source_name, url: r.url, changes: [] };
    entry.changes.push(r);
    bySource.set(r.source_id, entry);
  }
  return {
    period: { start: iso(start), end: iso(end) },
    totals: { checks: t.checks ?? 0, noise_suppressed: t.noise ?? 0, changes: t.changes ?? 0, meaningful: rows.length, sources_changed: bySource.size },
    by_category: byCategory,
    sources: [...bySource.values()],
  };
}

/** Email-client-safe HTML: tables and inline styles only, no external assets, 600px wide. */
export function renderDigestHtml(p: DigestPayload, baseUrl: string): string {
  const day = new Date(p.period.start).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const stat = (label: string, value: number): string =>
    `<td style="padding:12px;border:1px solid #e4e7ec;text-align:center;font-family:Arial,sans-serif"><div style="font-size:22px;font-weight:bold;color:#101828">${value}</div><div style="font-size:12px;color:#667085">${label}</div></td>`;
  const sections = p.sources.map((s) => `
    <tr><td style="padding:18px 0 6px;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;color:#101828">${esc(s.source_name)}
      <span style="font-weight:normal;font-size:12px;color:#667085">&nbsp;${esc(new URL(s.url).host)}</span></td></tr>
    ${s.changes.map((c) => `<tr><td style="padding:8px 12px;border-left:3px solid ${CAT_COLOR[c.category] ?? '#475467'};background:#f9fafb;font-family:Arial,sans-serif;font-size:14px;color:#344054">
      <span style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:${CAT_COLOR[c.category] ?? '#475467'}">${esc(c.category)} · significance ${c.significance}</span><br>
      ${esc(c.summary)} <a href="${esc(baseUrl)}/#change=${c.id}" style="color:#1f4fd1">View diff</a></td></tr><tr><td style="height:6px"></td></tr>`).join('')}`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Driftline digest</title></head>
<body style="margin:0;padding:0;background:#f2f4f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:24px">
<tr><td style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#1f4fd1">Driftline daily digest</td></tr>
<tr><td style="font-family:Arial,sans-serif;font-size:22px;font-weight:bold;color:#101828;padding:4px 0 16px">${esc(day)}</td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${stat('meaningful changes', p.totals.meaningful)}${stat('sources changed', p.totals.sources_changed)}${stat('checks run', p.totals.checks)}${stat('noise suppressed', p.totals.noise_suppressed)}</tr></table></td></tr>
${p.sources.length ? sections : '<tr><td style="padding:18px 0;font-family:Arial,sans-serif;color:#667085">No meaningful changes in this period.</td></tr>'}
<tr><td style="padding-top:20px;font-family:Arial,sans-serif;font-size:12px;color:#98a2b3">Only changes at or above each source's significance threshold are listed. Demo data: the tracked sites are fictional.</td></tr>
</table></td></tr></table></body></html>`;
}

export function renderDigestText(p: DigestPayload): string {
  const lines = [`Driftline digest ${p.period.start.slice(0, 10)}`, `${p.totals.meaningful} meaningful changes across ${p.totals.sources_changed} sources (${p.totals.checks} checks, ${p.totals.noise_suppressed} noise-only)`, ''];
  for (const s of p.sources) {
    lines.push(`${s.source_name} (${s.url})`);
    for (const c of s.changes) lines.push(`  [${c.category} ${c.significance}] ${c.summary}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function sendEmail(ctx: Ctx, subject: string, html: string, text: string): Promise<string> {
  const { resendApiKey, digestFrom, digestTo } = ctx.config;
  if (!resendApiKey || !digestFrom || !digestTo) return 'not_configured';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: digestFrom, to: digestTo.split(',').map((s) => s.trim()), subject, html, text }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? 'sent' : `failed:${res.status}`;
  } catch {
    return 'failed:network';
  }
}

export interface DigestRow {
  id: string;
  period_start: string;
  period_end: string;
  created_at: string;
  change_count: number;
  email_status: string;
}

/** Build, persist and announce a digest. Caller guarantees the (start, end) period is unique. */
export async function createDigest(ctx: Ctx, start: number, end: number, opts: { send?: boolean; createdAt?: number } = {}): Promise<DigestRow> {
  const createdAt = opts.createdAt ?? ctx.clock.now();
  const payload = buildDigestPayload(ctx, start, end);
  const html = renderDigestHtml(payload, ctx.config.publicBaseUrl);
  const text = renderDigestText(payload);
  const emailStatus = opts.send === false ? 'skipped' : await sendEmail(ctx, `Driftline: ${payload.totals.meaningful} meaningful changes`, html, text);
  const id = newId('dig', createdAt);
  run(ctx.db, `INSERT INTO digests (id, period_start, period_end, created_at, change_count, payload, html, text, email_status) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, iso(start), iso(end), iso(createdAt), payload.totals.meaningful, JSON.stringify(payload), html, text, emailStatus);
  if (opts.send !== false) {
    enqueueEvent(ctx.db, createdAt, 'digest.ready', {
      digest_id: id, period: payload.period, meaningful_changes: payload.totals.meaningful,
      links: { self: `${ctx.config.publicBaseUrl}/v1/digests/${id}` },
    });
  }
  return { id, period_start: iso(start), period_end: iso(end), created_at: iso(createdAt), change_count: payload.totals.meaningful, email_status: emailStatus };
}
