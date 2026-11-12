import { createHash } from 'node:crypto';

/**
 * Fictional demo websites.
 *
 * Every host ends in `.example`, a TLD reserved by RFC 2606 that never resolves
 * on the public internet. The tracker routes `*.example` URLs to these
 * renderers in-process, so the live demo exercises the full pipeline (robots,
 * conditional GET, extraction, diffing, scoring) without fetching anyone's real
 * site. Content is a pure function of time: the same instant always renders
 * the same page, so history backfilled at boot is reproducible.
 *
 * Each page also carries realistic noise (clocks, counters, rotating ads,
 * session tokens) that the tracker is expected to suppress.
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function seedOf(...parts: Array<string | number>): number {
  return createHash('sha1').update(parts.join('|')).digest().readUInt32LE(0);
}
/** mulberry32: tiny deterministic PRNG. */
function rng(...parts: Array<string | number>): () => number {
  let a = seedOf(...parts);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hhmmss = (t: number): string => new Date(t).toISOString().slice(11, 19);
const longDate = (t: number): string =>
  new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const sessionToken = (t: number): string => createHash('sha256').update(`sess${t}`).digest('hex').slice(0, 32);

function page(opts: { title: string; brand: string; nav: string[]; body: string; footer?: string; accent: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(opts.title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font:16px/1.55 system-ui,sans-serif;margin:0;color:#1d232b;background:#fafaf7}
header,footer{padding:14px 32px;background:${opts.accent};color:#fff}
header nav a{color:#fff;margin-right:18px;text-decoration:none;opacity:.9}
main{max-width:920px;margin:0 auto;padding:28px 32px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}
.card{border:1px solid #ddd;border-radius:10px;padding:16px;margin:12px 0;background:#fff}
.muted{color:#68707a;font-size:14px}.banner{background:#fff4d6;padding:10px 32px;font-size:14px}
</style>
<script>window.__analytics={id:"${sessionToken(opts.title.length)}"};</script></head>
<body>
<header><strong>${esc(opts.brand)}</strong> <nav>${opts.nav.map((n) => `<a href="#">${esc(n)}</a>`).join('')}</nav></header>
<div class="banner">This is a fictional demo site for the Driftline change tracker. It is not a real company.</div>
<main>${opts.body}</main>
<footer><p>© 2026 ${esc(opts.brand)}. All rights reserved.</p>${opts.footer ?? ''}</footer>
</body></html>`;
}

export interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface FixtureSite {
  host: string;
  name: string;
  robots: string;
  /** Sites that emit ETag/Last-Modified honour conditional GETs with 304. */
  conditional: boolean;
  routes: Record<string, (t: number) => { html: string; lastModified?: number }>;
}

// ---------------------------------------------------------------- Larkspur Cloud (pricing)
const LARKSPUR_STATES: Array<{ p: [number, number, number]; sso: boolean; sla: string; annual: number }> = [
  { p: [19, 49, 149], sso: false, sla: '99.9%', annual: 15 },
  { p: [19, 49, 149], sso: false, sla: '99.9%', annual: 15 },
  { p: [19, 59, 149], sso: false, sla: '99.9%', annual: 15 },
  { p: [19, 59, 149], sso: true, sla: '99.9%', annual: 15 },
  { p: [24, 59, 149], sso: true, sla: '99.9%', annual: 15 },
  { p: [24, 59, 179], sso: true, sla: '99.95%', annual: 20 },
  { p: [24, 59, 179], sso: true, sla: '99.95%', annual: 20 },
  { p: [19, 59, 179], sso: true, sla: '99.95%', annual: 20 },
  { p: [24, 59, 179], sso: true, sla: '99.95%', annual: 20 },
  { p: [24, 69, 199], sso: true, sla: '99.99%', annual: 20 },
  { p: [24, 69, 199], sso: true, sla: '99.99%', annual: 15 },
  { p: [24, 69, 199], sso: true, sla: '99.99%', annual: 15 },
];
const TESTIMONIALS = [
  '“Larkspur cut our deploy times in half.” — Platform lead, a logistics company',
  '“We moved 40 services in a weekend.” — CTO, a fintech startup',
  '“Support answered in four minutes.” — SRE, a media group',
  '“Billing finally makes sense.” — Finance ops, a retail brand',
];
function larkspurPricing(t: number): { html: string } {
  const s = LARKSPUR_STATES[Math.floor(t / (3 * DAY)) % LARKSPUR_STATES.length]!;
  const [starter, team, scale] = s.p;
  const quote = TESTIMONIALS[Math.floor(t / (10 * 60_000)) % TESTIMONIALS.length]!;
  const hoursLeft = 23 - new Date(t).getUTCHours();
  const body = `
<h1>Pricing that scales with your team</h1>
<p>Every plan includes unlimited projects, preview environments, and audit logs.</p>
<p class="muted">Offer ends in ${hoursLeft + 1} hours. Prices refreshed ${hhmmss(t)} UTC.</p>
<h2>Plans</h2>
<div class="card"><h3>Starter</h3><p>Starter — $${starter}/mo per seat</p><ul><li>Up to 5 seats</li><li>Community support</li><li>${s.sla} uptime target</li></ul></div>
<div class="card"><h3>Team</h3><p>Team — $${team}/mo per seat</p><ul><li>Up to 50 seats</li><li>Email support, 1 business day</li>${s.sso ? '<li>SAML single sign-on</li>' : ''}<li>${s.sla} uptime SLA</li></ul></div>
<div class="card"><h3>Scale</h3><p>Scale — $${scale}/mo per seat</p><ul><li>Unlimited seats</li><li>24/7 support with 1-hour response</li><li>SAML single sign-on and SCIM</li><li>${s.sla === '99.99%' ? '99.99%' : '99.95%'} uptime SLA with service credits</li></ul></div>
<h2>Billing</h2>
<p>Save ${s.annual}% with annual billing. Prices exclude applicable taxes.</p>
<div class="testimonial card"><p>${esc(quote)}</p></div>
<h2>FAQ</h2>
<dl><dt>Can I change plans later?</dt><dd>Yes. Upgrades apply immediately; downgrades apply at the next renewal.</dd>
<dt>Do you offer discounts for nonprofits?</dt><dd>Yes, contact sales for nonprofit and education pricing.</dd></dl>`;
  return { html: page({ title: 'Pricing · Larkspur Cloud', brand: 'Larkspur Cloud', nav: ['Product', 'Pricing', 'Docs', 'Sign in'], body, accent: '#1f4fd1', footer: `<p class="muted">Session ref ${sessionToken(t)}</p>` }) };
}

// ---------------------------------------------------------------- Fennel Analytics (changelog)
const FENNEL_TITLES = ['Funnel comparisons', 'Faster cohort queries', 'Warehouse sync for BigQuery', 'Saved views', 'Alerting on metric drift', 'Session replay sampling', 'CSV export limits raised', 'SQL editor autocomplete', 'Retention heatmaps', 'Role-based dashboards', 'Event schema validation', 'Deprecating the v1 ingest API'];
const FENNEL_ITEMS = {
  Added: ['Compare two funnels side by side', 'Webhook alerts when a metric moves more than 3σ', 'Dashboard folders with per-folder permissions', 'BigQuery and Snowflake warehouse sync', 'Keyboard shortcuts in the query builder', 'Annotations on time-series charts'],
  Improved: ['Cohort queries run up to 4x faster on large projects', 'CSV export limit raised from 50k to 250k rows', 'Chart tooltips now show week-over-week deltas', 'SQL editor suggests columns from the event schema'],
  Fixed: ['Timezone offset in daily rollups for UTC+13', 'Dashboard filters reset after saving a view', 'Duplicate events from the iOS SDK retry path', 'Funnel step ordering with identical timestamps'],
  Deprecated: ['The v1 ingest endpoint stops accepting events on 2027-03-01', 'Legacy embed tokens are replaced by signed embed URLs'],
} as const;
function fennelReleases(t: number): Array<{ day: number; version: string; title: string; items: string[] }> {
  const today = Math.floor(t / DAY);
  const out: Array<{ day: number; version: string; title: string; items: string[] }> = [];
  for (let d = today; d > today - 90 && out.length < 8; d--) {
    const r = rng('fennel', d);
    if (r() >= 0.5) continue;
    const publishHour = Math.floor(r() * 20) + 2;
    if (d === today && t < d * DAY + publishHour * HOUR) continue;
    const kinds = Object.keys(FENNEL_ITEMS) as Array<keyof typeof FENNEL_ITEMS>;
    const items: string[] = [];
    const n = 2 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const kind = r() < 0.12 ? 'Deprecated' : pick(r, kinds.filter((k) => k !== 'Deprecated'));
      const item = `${kind}: ${pick(r, FENNEL_ITEMS[kind])}`;
      if (!items.includes(item)) items.push(item);
    }
    const iso = new Date(d * DAY).toISOString().slice(0, 10);
    out.push({ day: d, version: iso.replace(/-/g, '.'), title: pick(r, FENNEL_TITLES), items });
  }
  return out;
}
function fennelChangelog(t: number): { html: string } {
  const releases = fennelReleases(t);
  const body = `<h1>Changelog</h1><p>New features, fixes, and deprecations in Fennel Analytics. Releases use calendar versioning.</p>
<p class="muted">Last deploy ${Math.floor((t / 60_000) % 50) + 2} minutes ago · ${1200 + Math.floor((t / 60_000) % 400)} readers online</p>
${releases.map((r) => `<article class="card"><h2>${r.version} — ${esc(r.title)}</h2><ul>${r.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></article>`).join('\n')}`;
  return { html: page({ title: 'Changelog · Fennel Analytics', brand: 'Fennel Analytics', nav: ['Product', 'Changelog', 'Docs', 'Status'], body, accent: '#2d6a3e' }) };
}

// ---------------------------------------------------------------- Quarry Bank (terms of service)
function quarryTerms(t: number): { html: string; lastModified: number } {
  const period = 9 * DAY;
  const bucket = Math.floor(t / period);
  const state = bucket % 6;
  const effective = bucket * period;
  const retention = state >= 2 ? 90 : 30;
  const law = state >= 4 ? 'the State of New York' : 'the State of Delaware';
  const arbitration =
    state >= 3
      ? `<h2>11. Dispute resolution</h2><p>Any dispute arising from these Terms shall be resolved by binding individual arbitration administered under the Consumer Arbitration Rules. You waive any right to participate in a class action.</p>${state >= 5 ? '<p>You may opt out of arbitration by notifying us in writing within 30 days of first accepting these Terms.</p>' : ''}`
      : `<h2>11. Dispute resolution</h2><p>Any dispute arising from these Terms may be brought in the courts located in ${law}.</p>`;
  const body = `<h1>Terms of Service</h1><p><strong>Effective ${longDate(effective)}</strong></p>
<h2>1. Accounts</h2><p>You must provide accurate information when opening an account and keep your credentials confidential.</p>
<h2>2. Fees</h2><p>Monthly maintenance fees are listed in the Fee Schedule. We will give you at least 30 days notice before increasing any fee.</p>
<h2>3. Personal data</h2><p>We process personal data as described in our Privacy Notice. We retain account data for ${retention} days after account closure, unless law requires longer retention.</p>
<h2>7. Limitation of liability</h2><p>To the fullest extent permitted by law, our total liability shall not exceed the fees you paid in the twelve months before the claim.</p>
${arbitration}
<h2>12. Governing law</h2><p>These Terms are governed by the laws of ${law}, without regard to conflict-of-law rules.</p>`;
  return { html: page({ title: 'Terms of Service · Quarry Bank', brand: 'Quarry Bank', nav: ['Accounts', 'Loans', 'Help'], body, accent: '#5a4632' }), lastModified: effective };
}

// ---------------------------------------------------------------- Halyard (status page)
const HALYARD_COMPONENTS = ['API', 'Dashboard', 'Webhooks', 'Edge network', 'Background jobs'];
const SLOT = 45 * 60_000;
function halyardIncidentStart(slot: number): { component: string; severity: string } | null {
  const r = rng('halyard', slot);
  if (r() >= 0.012) return null;
  return { component: pick(r, HALYARD_COMPONENTS), severity: r() < 0.7 ? 'Degraded performance' : 'Partial outage' };
}
const STAGES = ['Investigating', 'Identified', 'Monitoring'] as const;
function halyardStatus(t: number): { html: string } {
  const slot = Math.floor(t / SLOT);
  let active: { component: string; severity: string; stage: string; started: number } | null = null;
  for (let back = 0; back < 3 && !active; back++) {
    const inc = halyardIncidentStart(slot - back);
    if (inc) active = { ...inc, stage: STAGES[back]!, started: (slot - back) * SLOT };
  }
  const past: string[] = [];
  for (let s = slot - 3; s > slot - 3 - 7 * 32 && past.length < 5; s--) {
    const inc = halyardIncidentStart(s);
    if (inc) past.push(`<li>${longDate(s * SLOT)}: ${esc(inc.component)} ${inc.severity.toLowerCase()}. Resolved.</li>`);
  }
  const rows = HALYARD_COMPONENTS.map((c) => {
    const status = active && active.component === c ? active.severity : 'Operational';
    return `<tr><td>${c}</td><td>${status}</td></tr>`;
  }).join('');
  const banner = active
    ? `<div class="card"><h2>${active.stage}: ${esc(active.component)} ${active.severity.toLowerCase()}</h2><p>${active.stage === 'Investigating' ? 'We are investigating elevated error rates.' : active.stage === 'Identified' ? 'The cause has been identified and a fix is rolling out.' : 'A fix has been deployed. We are monitoring results.'}</p></div>`
    : '<div class="card"><h2>All systems operational</h2></div>';
  const body = `<h1>Halyard system status</h1><p class="muted">Refreshed ${hhmmss(t)} UTC</p>${banner}
<table><thead><tr><th>Component</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Past incidents</h2><ul>${past.join('') || '<li>No incidents in the last 7 days.</li>'}</ul>`;
  return { html: page({ title: 'Status · Halyard', brand: 'Halyard', nav: ['Status', 'Subscribe'], body, accent: '#334155' }) };
}

// ---------------------------------------------------------------- Orrery Labs (careers)
const ROLES = [
  ['Senior Backend Engineer, Payments', 'Engineering', 'Remote (US)'], ['Staff Site Reliability Engineer', 'Engineering', 'Boston, MA'],
  ['Product Designer, Growth', 'Design', 'Remote (US/EU)'], ['Data Analyst, Revenue', 'Data', 'New York, NY'],
  ['Engineering Manager, Platform', 'Engineering', 'Boston, MA'], ['Technical Writer, API docs', 'Product', 'Remote (US)'],
  ['Security Engineer, AppSec', 'Security', 'Remote (US)'], ['Customer Success Manager', 'Customer', 'Chicago, IL'],
  ['Frontend Engineer, Dashboard', 'Engineering', 'Remote (EU)'], ['Machine Learning Engineer, Ranking', 'Engineering', 'San Francisco, CA'],
  ['Recruiting Coordinator', 'People', 'Boston, MA'], ['Solutions Architect', 'Sales', 'Remote (US)'],
] as const;
function orreryCareers(t: number): { html: string } {
  const bucket = Math.floor(t / (2 * DAY));
  const open = ROLES.filter((_, i) => rng('orrery', i, Math.floor(bucket / (2 + (i % 3))))() < 0.5);
  const body = `<h1>Careers at Orrery Labs</h1><p>We build scheduling infrastructure for hospitals. ${open.length} open roles.</p>
<table><thead><tr><th>Role</th><th>Team</th><th>Location</th></tr></thead><tbody>
${open.map(([title, team, loc]) => `<tr><td>${title}</td><td>${team}</td><td>${loc}</td></tr>`).join('\n')}
</tbody></table><p class="muted">Page generated ${new Date(t).toISOString()}</p>`;
  return { html: page({ title: 'Careers · Orrery Labs', brand: 'Orrery Labs', nav: ['About', 'Careers', 'Blog'], body, accent: '#7a3e1d' }) };
}

// ---------------------------------------------------------------- Tessellate API (docs)
const TESS_STATES = [
  { free: 60, pro: 600, ent: 6000, burst: 2, retry: false },
  { free: 60, pro: 1000, ent: 6000, burst: 2, retry: false },
  { free: 30, pro: 1000, ent: 6000, burst: 2, retry: true },
  { free: 30, pro: 1000, ent: 10000, burst: 3, retry: true },
];
function tessellateDocs(t: number): { html: string; lastModified: number } {
  const period = 8 * DAY;
  const bucket = Math.floor(t / period);
  const s = TESS_STATES[bucket % TESS_STATES.length]!;
  const body = `<h1>Rate limits</h1><p>Limits apply per API key and are enforced over a sliding one-minute window.</p>
<table><thead><tr><th>Plan</th><th>Requests per minute</th><th>Burst multiplier</th></tr></thead><tbody>
<tr><td>Free</td><td>${s.free.toLocaleString('en-US')}</td><td>${s.burst}x</td></tr>
<tr><td>Pro</td><td>${s.pro.toLocaleString('en-US')}</td><td>${s.burst}x</td></tr>
<tr><td>Enterprise</td><td>${s.ent.toLocaleString('en-US')}</td><td>${s.burst}x</td></tr></tbody></table>
<h2>When you hit a limit</h2><p>Requests over the limit receive HTTP 429.${s.retry ? ' The response includes a Retry-After header with the number of seconds to wait.' : ' Back off exponentially before retrying.'}</p>
<div class="feedback card"><p>Was this page helpful? ${1100 + Math.floor(t / 600_000) % 900} votes</p></div>`;
  return { html: page({ title: 'Rate limits · Tessellate API docs', brand: 'Tessellate API', nav: ['Guides', 'Reference', 'Changelog'], body, accent: '#0f3d5e' }), lastModified: bucket * period };
}

// ---------------------------------------------------------------- Bramble & Co. (noisy journal)
const POSTS = ['Field notes from a Vermont sugarhouse', 'How we source linen', 'A week on the Maine coast', 'Repairing a 1960s field jacket', 'The case for wool socks', 'Notes on natural dyes', 'Packing light for shoulder season', 'Inside our Portland workshop', 'Ten years of the canvas tote', 'Winter care for leather boots'];
const SPONSORS = ['Sponsored: Try Hearthstone Coffee, 20% off', 'Sponsored: Northline Bikes spring sale', 'Sponsored: Fieldwork Supply, free shipping', 'Sponsored: Juniper Tea subscription'];
function brambleJournal(t: number): { html: string } {
  const week = Math.floor(t / (7 * DAY));
  const posts = Array.from({ length: 6 }, (_, i) => POSTS[(week - i + POSTS.length * 100) % POSTS.length]!);
  const r = rng('bramble-noise', Math.floor(t / 1000));
  const body = `<h1>The Bramble Journal</h1>
<div class="ad-slot card"><p>${pick(r, SPONSORS)}</p></div>
<div class="trending card"><h3>Trending now</h3><p>${pick(r, POSTS)}</p></div>
${posts.map((p, i) => `<article class="card"><h2>${p}</h2><p class="muted">${(i + 1) * 3 + Math.floor(r() * 3)} days ago · ${Math.floor(800 + r() * 9000).toLocaleString('en-US')} views</p></article>`).join('\n')}`;
  return { html: page({ title: 'Journal · Bramble & Co.', brand: 'Bramble & Co.', nav: ['Shop', 'Journal', 'Stores'], body, accent: '#4b5d3a', footer: `<p class="muted">Session ref ${sessionToken(t)}</p>` }) };
}

// ---------------------------------------------------------------- Kestrel Outfitters (product page)
function kestrelProduct(t: number): { html: string } {
  const priceBucket = Math.floor(t / (2 * DAY));
  const pr = rng('kestrel-price', priceBucket);
  const onSale = pr() < 0.3;
  const price = onSale ? 149 : priceBucket % 10 < 6 ? 189 : 199;
  const sr = rng('kestrel-stock', Math.floor(t / (12 * HOUR)))();
  const stock = sr < 0.15 ? 'Sold out. Expected back in 2 weeks.' : sr < 0.4 ? `Low stock: only ${2 + Math.floor(sr * 10)} left.` : 'In stock. Ships in 1 business day.';
  const reviews = 1100 + Math.floor(t / DAY) % 400;
  const body = `<h1>Trail Pack 38L</h1><p>A 38-liter pack for multi-day hikes. Recycled ripstop shell, aluminum frame, rain cover included.</p>
<div class="card"><p>Price: $${price}</p>${onSale ? '<p>Sale ends Sunday. Regular price $189</p>' : ''}<p>${stock}</p><p>Rated 4.7 out of 5 from ${reviews.toLocaleString('en-US')} reviews</p></div>
<h2>Specifications</h2><table><tbody><tr><td>Volume</td><td>38 L</td></tr><tr><td>Weight</td><td>1.2 kg</td></tr><tr><td>Torso fit</td><td>40–52 cm</td></tr></tbody></table>
<h2>Shipping and returns</h2><p>Free shipping on orders over $75. Returns accepted within 60 days.</p>`;
  return { html: page({ title: 'Trail Pack 38L · Kestrel Outfitters', brand: 'Kestrel Outfitters', nav: ['Packs', 'Tents', 'Apparel', 'Sale'], body, accent: '#8a3324' }) };
}

// ---------------------------------------------------------------- Vireo Insurance (pending approval)
function vireoPrivacy(): { html: string } {
  const body = `<h1>Privacy Notice</h1><p>This notice explains what personal data Vireo Insurance collects and why.</p><h2>Data we collect</h2><ul><li>Contact details</li><li>Policy and claims history</li></ul>`;
  return { html: page({ title: 'Privacy · Vireo Insurance', brand: 'Vireo Insurance', nav: ['Policies', 'Claims'], body, accent: '#3c4a5c' }) };
}

const ALLOW_ALL = 'User-agent: *\nAllow: /\n';
export const SITES: FixtureSite[] = [
  { host: 'larkspur.example', name: 'Larkspur Cloud', robots: ALLOW_ALL, conditional: false, routes: { '/pricing': larkspurPricing } },
  { host: 'fennel.example', name: 'Fennel Analytics', robots: ALLOW_ALL, conditional: false, routes: { '/changelog': fennelChangelog } },
  { host: 'quarry.example', name: 'Quarry Bank', robots: ALLOW_ALL, conditional: true, routes: { '/legal/terms': quarryTerms } },
  { host: 'halyard.example', name: 'Halyard', robots: ALLOW_ALL, conditional: false, routes: { '/status': halyardStatus } },
  { host: 'orrery.example', name: 'Orrery Labs', robots: 'User-agent: *\nDisallow: /careers/internal\n\nUser-agent: DriftlineBot\nDisallow: /careers/internal\nDisallow: /admin\n', conditional: false, routes: { '/careers': orreryCareers, '/careers/internal': orreryCareers } },
  { host: 'tessellate.example', name: 'Tessellate API', robots: ALLOW_ALL, conditional: true, routes: { '/docs/rate-limits': tessellateDocs } },
  { host: 'bramble.example', name: 'Bramble & Co.', robots: ALLOW_ALL, conditional: false, routes: { '/journal': brambleJournal } },
  { host: 'kestrel.example', name: 'Kestrel Outfitters', robots: ALLOW_ALL, conditional: false, routes: { '/packs/trail-38': kestrelProduct } },
  { host: 'vireo.example', name: 'Vireo Insurance', robots: ALLOW_ALL, conditional: false, routes: { '/privacy': () => vireoPrivacy() } },
];
const BY_HOST = new Map(SITES.map((s) => [s.host, s]));

export const isFixtureHost = (host: string): boolean => host.endsWith('.example');

/** Render a fixture URL at time `t`, honouring conditional request headers. */
export function renderFixture(host: string, path: string, t: number, reqHeaders: Record<string, string> = {}): FixtureResponse {
  const site = BY_HOST.get(host);
  const notFound = { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<h1>Not found</h1>' };
  if (!site) return notFound;
  if (path === '/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: site.robots };
  const route = site.routes[path];
  if (!route) return notFound;
  const { html, lastModified } = route(t) as { html: string; lastModified?: number };
  const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' };
  if (site.conditional) {
    const etag = `"${createHash('sha1').update(html).digest('hex').slice(0, 16)}"`;
    headers['etag'] = etag;
    if (lastModified !== undefined) headers['last-modified'] = new Date(lastModified).toUTCString();
    if (reqHeaders['if-none-match'] === etag) return { status: 304, headers, body: '' };
  }
  return { status: 200, headers, body: html };
}
