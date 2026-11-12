// Driftline dashboard. Vanilla JS, no dependencies: every number on this page comes from the public REST API.
'use strict';

const KEY = 'wct_demo_public_explorer_key';
const CATS = ['pricing', 'legal', 'status', 'product', 'hiring', 'content'];
const OUTCOMES = [
  ['noise', 'Noise only (masked tokens)', '--c-noise'],
  ['unchanged', 'Unchanged', '--faint'],
  ['not_modified', '304 Not Modified', '--c-status'],
  ['changed', 'Changed', '--accent'],
  ['blocked', 'Blocked (robots / policy)', '--c-hiring'],
  ['error', 'Error', '--bad'],
  ['baseline', 'Baseline', '--c-content'],
];
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = new Intl.NumberFormat('en-US');
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function ago(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return rtf.format(Math.round(s), 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
const shortDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const state = { stats: null, changes: [], digests: [], cat: 'all', min: 0, hidden: new Set(), selected: null, traffic: [], tab: 'visual', change: null };

// ------------------------------------------------------------------ API client with ETag cache
const etags = new Map();
async function api(path, opts = {}) {
  const headers = { Authorization: `Bearer ${KEY}`, ...(opts.headers || {}) };
  if (opts.accept) headers.Accept = opts.accept;
  const method = opts.method || 'GET';
  const cacheKey = `${opts.accept || 'json'} ${path}`;
  const cached = method === 'GET' ? etags.get(cacheKey) : null;
  if (cached) headers['If-None-Match'] = cached.etag;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: 'no-store' });
  } catch (err) {
    logTraffic({ method, path, status: 0, ms: Math.round(performance.now() - t0) });
    throw err;
  }
  logTraffic({ method, path, status: res.status, ms: Math.round(performance.now() - t0), etag: res.headers.get('ETag'), rl: res.headers.get('RateLimit-Remaining'), rid: res.headers.get('X-Request-Id') });
  if (res.status === 304 && cached) return { status: 304, ok: true, data: cached.data, headers: res.headers, cached: true };
  const ct = res.headers.get('Content-Type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  const etag = res.headers.get('ETag');
  if (method === 'GET' && res.ok && etag) etags.set(cacheKey, { etag, data });
  return { status: res.status, ok: res.ok, data, headers: res.headers, cached: false };
}

// ------------------------------------------------------------------ traffic log
function logTraffic(t) {
  state.traffic.unshift({ at: new Date(), ...t });
  state.traffic.length = Math.min(state.traffic.length, 40);
  renderTraffic();
}
function renderTraffic() {
  const body = $('#traffic tbody');
  body.innerHTML = state.traffic.map((t) => `<tr><td>${t.at.toLocaleTimeString('en-US', { hour12: false })}</td><td>${esc(t.method)} ${esc(t.path.length > 70 ? t.path.slice(0, 69) + '…' : t.path)}</td><td class="s${String(t.status)[0]}">${t.status || 'network error'}</td><td>${t.ms}</td><td>${esc(t.etag || '')}</td><td>${esc(t.rl ?? '')}</td><td>${esc((t.rid || '').slice(0, 8))}</td></tr>`).join('');
  const n304 = state.traffic.filter((t) => t.status === 304).length;
  $('#traffic-sum').textContent = `${state.traffic.length} requests · ${n304} answered 304`;
}

// ------------------------------------------------------------------ tooltip
const tip = $('#tip');
function showTip(html, ev) {
  tip.innerHTML = html;
  tip.classList.add('on');
  const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => tip.classList.remove('on');
function bindTips(root) {
  root.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mousemove', (e) => showTip(el.getAttribute('data-tip'), e));
    el.addEventListener('mouseleave', hideTip);
  });
}

// ------------------------------------------------------------------ KPIs
function spark(values, color) {
  const w = 200, h = 30, max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,${h} ${pts} ${w},${h}" fill="${color}" fill-opacity=".12" stroke="none"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}
function renderKpis(s) {
  const t = s.totals;
  const perDay = s.daily.map((d) => CATS.reduce((a, c) => a + (d.meaningful[c] || 0), 0));
  const checksPerDay = s.daily.map((d) => d.checks);
  const noisePerDay = s.daily.map((d) => d.noise);
  const verified = s.receiver.verified;
  const tiles = [
    ['Meaningful changes', fmt.format(t.meaningful_changes), `${t.changes - t.meaningful_changes} more below threshold`, spark(perDay, css('--accent'))],
    ['Sources tracked', fmt.format(t.sources.approved), `${t.sources.pending} pending review · ${t.sources.rejected} rejected`, ''],
    ['Checks run', fmt.format(t.checks), `${s.window.days} days · p50 ${t.latency_ms.p50} ms in-process`, spark(checksPerDay, css('--muted'))],
    ['Noise suppressed', `${Math.round(t.noise_rate * 100)}%`, `${fmt.format(t.noise_suppressed)} fetches changed only volatile tokens`, spark(noisePerDay, css('--c-noise'))],
    ['304 Not Modified', fmt.format(t.conditional_hits), 'Conditional GETs with ETag / Last-Modified', ''],
    ['Webhooks verified', fmt.format(verified), `HMAC-SHA256, checked by the demo receiver since boot`, ''],
  ];
  $('#kpis').innerHTML = tiles.map(([label, value, foot, sp]) => `<div class="card kpi"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="foot">${esc(foot)}</div>${sp}</div>`).join('');
}

// ------------------------------------------------------------------ stacked bars
function renderActivity(s) {
  const el = $('#activity');
  const W = Math.max(320, el.clientWidth || 640), H = 230, m = { t: 8, r: 8, b: 26, l: 34 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const cats = CATS.filter((c) => !state.hidden.has(c));
  const totals = s.daily.map((d) => cats.reduce((a, c) => a + (d.meaningful[c] || 0), 0));
  const max = Math.max(4, ...totals);
  const step = Math.ceil(max / 4);
  const ymax = step * 4;
  const bw = iw / s.daily.length;
  const y = (v) => m.t + ih - (v / ymax) * ih;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = i * step;
    g += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  s.daily.forEach((d, i) => {
    let acc = 0;
    const x = m.l + i * bw + bw * 0.14;
    const w = Math.max(2, bw * 0.72);
    for (const c of cats) {
      const v = d.meaningful[c] || 0;
      if (!v) continue;
      g += `<rect x="${x}" y="${y(acc + v)}" width="${w}" height="${y(acc) - y(acc + v)}" fill="var(--c-${c})" rx="1.5"/>`;
      acc += v;
    }
    const every = Math.ceil(s.daily.length / 8);
    if (i % every === 0 && s.daily.length - 1 - i >= every / 2 || i === s.daily.length - 1) g += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${shortDate(d.date)}</text>`;
    const rows = cats.filter((c) => d.meaningful[c]).map((c) => `<span class="swatch" style="background:var(--c-${c})"></span> ${c}: <b>${d.meaningful[c]}</b>`).join('<br>');
    const tipHtml = `<b>${shortDate(d.date)}</b><br>${rows || 'No meaningful changes'}<br>${d.minor} minor · ${fmt.format(d.checks)} checks · ${fmt.format(d.noise)} noise`;
    g += `<rect x="${m.l + i * bw}" y="${m.t}" width="${bw}" height="${ih}" fill="transparent" data-tip="${esc(tipHtml)}"/>`;
  });
  g += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Stacked bar chart of meaningful changes per day by category">${g}</svg>`;
  bindTips(el);
  $('#activity-legend').innerHTML = CATS.map((c) => `<button type="button" data-cat="${c}" aria-pressed="${!state.hidden.has(c)}"><span class="swatch" style="background:var(--c-${c})"></span>${c} ${s.by_category[c] ?? 0}</button>`).join('');
  $('#activity-legend').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const c = b.dataset.cat;
    state.hidden.has(c) ? state.hidden.delete(c) : state.hidden.add(c);
    renderActivity(state.stats);
  }));
}

// ------------------------------------------------------------------ donut
function renderDonut(s) {
  const o = s.totals.outcomes;
  const total = OUTCOMES.reduce((a, [k]) => a + (o[k] || 0), 0) || 1;
  const R = 70, r = 46, cx = 84, cy = 84;
  let a0 = -Math.PI / 2;
  let paths = '';
  for (const [k, label, color] of OUTCOMES) {
    const v = o[k] || 0;
    if (!v) continue;
    const a1 = a0 + (v / total) * Math.PI * 2 - 0.0001;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, ang) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
    paths += `<path d="M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)}Z" fill="var(${color})" stroke="var(--panel-2)" stroke-width="1.5" data-tip="${esc(`<b>${label}</b><br>${fmt.format(v)} checks (${((v / total) * 100).toFixed(1)}%)`)}"/>`;
    a0 = a1 + 0.0001;
  }
  $('#donut').innerHTML = `<svg viewBox="0 0 168 168" role="img" aria-label="Check outcomes">${paths}<text x="84" y="80" text-anchor="middle" style="font:600 22px var(--font);fill:var(--text)">${Math.round(s.totals.noise_rate * 100)}%</text><text x="84" y="98" text-anchor="middle" style="font:12px var(--font);fill:var(--muted)">noise filtered</text></svg>`;
  bindTips($('#donut'));
  $('#outcomes').innerHTML = OUTCOMES.filter(([k]) => o[k]).map(([k, label, color]) => `<div><span class="swatch" style="background:var(${color})"></span>${label}<span class="n">${fmt.format(o[k])}</span></div>`).join('');
}

// ------------------------------------------------------------------ change feed
function ring(sig, color) {
  const C = 2 * Math.PI * 18;
  return `<svg class="ring" viewBox="0 0 44 44" aria-label="Significance ${sig}"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--grid)" stroke-width="4"/><circle cx="22" cy="22" r="18" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-dasharray="${(sig / 100) * C} ${C}" transform="rotate(-90 22 22)"/><text x="22" y="26.5" text-anchor="middle">${sig}</text></svg>`;
}
function renderFilters() {
  const chips = ['all', ...CATS].map((c) => `<button type="button" class="chip" data-cat="${c}" aria-pressed="${state.cat === c}">${c === 'all' ? 'All' : `<span class="swatch" style="background:var(--c-${c})"></span>${c}`}</button>`).join('');
  $('#filters').innerHTML = `${chips}<label class="range">min significance <input type="range" id="min-sig" min="0" max="90" step="10" value="${state.min}"><b id="min-val">${state.min}</b></label>`;
  $('#filters').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { state.cat = b.dataset.cat; renderFilters(); loadChanges(); }));
  const r = $('#min-sig');
  r.addEventListener('input', () => { $('#min-val').textContent = r.value; });
  r.addEventListener('change', () => { state.min = Number(r.value); loadChanges(); });
}
async function loadChanges() {
  const q = new URLSearchParams({ limit: '60' });
  if (state.cat !== 'all') q.set('category', state.cat);
  if (state.min) q.set('min_significance', String(state.min));
  const r = await api(`/v1/changes?${q}`);
  if (!r.ok) return;
  state.changes = r.data.data;
  $('#feed-sub').innerHTML = `<code>GET /v1/changes?${esc(q.toString())}</code>`;
  renderFeed();
}
function renderFeed() {
  const feed = $('#feed');
  if (!state.changes.length) { feed.innerHTML = '<li class="empty">No meaningful changes match these filters.</li>'; return; }
  feed.innerHTML = state.changes.map((c) => `<li><button type="button" data-id="${c.id}" aria-current="${state.selected === c.id}">
    ${ring(c.significance, `var(--c-${c.category})`)}
    <div><div class="meta"><span class="pill" style="--pc:var(--c-${c.category})">${esc(c.category)}</span><span>${esc(c.source_name)}</span>${c.fact_changes.length ? `<span class="mono">${c.fact_changes.length} price point${c.fact_changes.length > 1 ? 's' : ''}</span>` : ''}</div>
    <div class="summary">${esc(c.summary)}</div></div>
    <time class="when" datetime="${c.detected_at}" title="${esc(new Date(c.detected_at).toUTCString())}">${ago(c.detected_at)}</time></button></li>`).join('');
  feed.querySelectorAll('button[data-id]').forEach((b) => b.addEventListener('click', () => openChange(b.dataset.id, b)));
}

// ------------------------------------------------------------------ diff drawer
let lastFocus = null;
async function openChange(id, trigger) {
  lastFocus = trigger || document.activeElement;
  state.selected = id;
  state.tab = 'visual';
  renderFeed();
  const r = await api(`/v1/changes/${encodeURIComponent(id)}`);
  if (!r.ok) { toast(r.data.title || 'Could not load change'); return; }
  const c = r.data;
  state.change = c;
  const src = state.stats?.sources.find((s) => s.id === c.source_id);
  $('#d-cat').innerHTML = `<span class="pill" style="--pc:var(--c-${c.category})">${esc(c.category)} · ${c.significance}</span>`;
  $('#d-when').textContent = `${new Date(c.detected_at).toUTCString()}`;
  $('#d-title').textContent = c.summary;
  $('#d-source').innerHTML = `${esc(c.source_name)} ${src ? `· <a href="/demo-sites/${esc(src.host)}${esc(sourcePath(src))}" target="_blank" rel="noopener">${esc(src.host)}</a>` : ''} · <span class="mono">${esc(c.id)}</span>`;
  renderDrawerBody();
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('on');
  $('#d-close').focus();
  history.replaceState(null, '', `#change=${id}`);
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('on');
  state.selected = null;
  history.replaceState(null, '', location.pathname);
  renderFeed();
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
function segHtml(line) {
  if (!line.segments) return esc(line.text);
  return line.segments.map((s) => (s.op === 'eq' ? esc(s.text) : s.op === 'add' ? `<ins>${esc(s.text)}</ins>` : `<del>${esc(s.text)}</del>`)).join('');
}
async function renderDrawerBody() {
  const c = state.change;
  document.querySelectorAll('#drawer [data-tab]').forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.tab === state.tab)));
  const body = $('#d-body');
  const facts = c.fact_changes.length ? `<table class="facts"><thead><tr><th>Price point</th><th>Before</th><th>After</th><th>Δ</th></tr></thead><tbody>${c.fact_changes.map((f) => `<tr><td>${esc(f.key)}</td><td class="mono">${f.from ?? '—'}</td><td class="mono">${f.to ?? '—'}</td><td class="mono">${f.pct === null ? '' : (f.pct > 0 ? '+' : '') + f.pct + '%'}</td></tr>`).join('')}</tbody></table>` : '';
  const why = `<div><b style="font-size:13px">Why it scored ${c.significance}</b><ul class="signals">${c.signals.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
  if (state.tab === 'visual') {
    const hunks = c.hunks.map((h) => `<div class="hunk">@@ −${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@</div>${h.lines.map((l) => `<div class="ln ${l.op}"><span class="no">${l.old ?? ''}</span><span class="no">${l.new ?? ''}</span><span>${l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}</span><span>${segHtml(l)}</span></div>`).join('')}`).join('');
    body.innerHTML = `${why}${facts}<div class="diff" aria-label="Word-level diff">${hunks}</div><p style="color:var(--muted);font-size:12.5px;margin:0">${c.words_added} words added, ${c.words_removed} removed. Snapshots <span class="mono">${esc(c.from_snapshot_id)}</span> → <span class="mono">${esc(c.to_snapshot_id)}</span>.</p>`;
  } else if (state.tab === 'unified') {
    body.innerHTML = '<pre class="code">Loading…</pre>';
    const r = await api(`/v1/changes/${c.id}`, { accept: 'text/x-diff' });
    body.innerHTML = `<p style="margin:0;color:var(--muted);font-size:13px">Same resource, negotiated with <code>Accept: text/x-diff</code>. Pipe it to <code>git apply --check</code> or any diff viewer.</p><pre class="code">${esc(r.data)}</pre>`;
  } else {
    const origin = location.origin;
    body.innerHTML = `<pre class="code">${esc(`# JSON with word-level hunks
curl -s ${origin}/v1/changes/${c.id} \\
  -H "Authorization: Bearer ${KEY}"

# Unified diff (content negotiation)
curl -s ${origin}/v1/changes/${c.id} \\
  -H "Authorization: Bearer ${KEY}" -H "Accept: text/x-diff"

# Revalidate: 304 with an empty body if unchanged
curl -si ${origin}/v1/changes/${c.id} \\
  -H "Authorization: Bearer ${KEY}" -H 'If-None-Match: <etag from the last response>'

# Both snapshots, as normalized text
curl -s ${origin}/v1/snapshots/${c.to_snapshot_id} -H "Authorization: Bearer ${KEY}" -H "Accept: text/plain"`)}</pre>`;
  }
}

// ------------------------------------------------------------------ price chart
function renderPriceSelect(s) {
  const sel = $('#price-series');
  const prev = sel.value;
  const names = new Map(s.sources.map((x) => [x.id, x.name.split(' · ')[0]]));
  sel.innerHTML = s.price_series.map((p, i) => `<option value="${i}">${esc(names.get(p.source_id) || '')}: ${esc(p.key)}</option>`).join('');
  if (prev && Number(prev) < s.price_series.length) sel.value = prev;
}
function renderPrices(s) {
  const el = $('#prices');
  if (!s.price_series.length) { el.innerHTML = '<p class="empty">No price changes extracted yet.</p>'; return; }
  const idx = Number($('#price-series').value || 0);
  const p = s.price_series[idx] || s.price_series[0];
  // One series per chart: tiers on the same page can differ 10x, which would flatten the selected line.
  const related = [p];
  const W = Math.max(300, el.clientWidth || 480), H = 240, m = { t: 14, r: 14, b: 26, l: 46 };
  const t0 = Date.parse(s.window.start), t1 = Date.parse(s.as_of);
  const vals = related.flatMap((q) => q.points.map((x) => x.v));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  // "Nice" axis: steps of 1, 2 or 5 x 10^k, so ticks land on round prices.
  const rough = Math.max(1, (hi - lo) / 4);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((k) => k >= rough);
  lo = Math.max(0, Math.floor((lo - step / 2) / step) * step);
  hi = Math.ceil((hi + step / 2) / step) * step;
  const ticks = Math.round((hi - lo) / step);
  const x = (t) => m.l + ((Math.max(t0, Math.min(t1, t)) - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const sym = p.currency === 'EUR' ? '€' : p.currency === 'GBP' ? '£' : '$';
  let g = '';
  for (let i = 0; i <= ticks; i++) {
    const v = lo + i * step;
    g += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${sym}${Number.isInteger(v) ? v : v.toFixed(2)}</text>`;
  }
  for (let d = 0; d <= 4; d++) {
    const t = t0 + ((t1 - t0) * d) / 4;
    g += `<text x="${x(t)}" y="${H - 8}" text-anchor="${d === 0 ? 'start' : d === 4 ? 'end' : 'middle'}">${shortDate(t)}</text>`;
  }
  const palette = ['--accent', '--c-pricing', '--c-status', '--c-legal'];
  related.forEach((q, qi) => {
    const color = `var(${q === p ? '--accent' : palette[(qi % 3) + 1]})`;
    let d = '';
    let prev = null;
    for (const pt of q.points) {
      const tx = x(Date.parse(pt.t)), ty = y(pt.v);
      d += prev === null ? `M${x(t0)},${ty} L${tx},${ty}` : ` L${tx},${prev} L${tx},${ty}`;
      prev = ty;
    }
    d += ` L${x(t1)},${prev}`;
    const strong = q === p;
    g += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${strong ? 2.4 : 1.4}" stroke-opacity="${strong ? 1 : 0.55}"/>`;
    if (strong) {
      q.points.forEach((pt, i) => {
        if (Date.parse(pt.t) < t0) return;
        const prevV = q.points[i - 1]?.v;
        const delta = prevV === undefined ? '' : ` (${pt.v > prevV ? '+' : ''}${(((pt.v - prevV) / prevV) * 100).toFixed(1)}%)`;
        g += `<circle cx="${x(Date.parse(pt.t))}" cy="${y(pt.v)}" r="4.5" fill="var(--panel-2)" stroke="${color}" stroke-width="2" data-tip="${esc(`<b>${sym}${pt.v}</b>${delta}<br>${new Date(pt.t).toUTCString()}`)}"/>`;
      });
    }
  });
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Step chart of ${esc(p.key)}">${g}</svg>`;
  bindTips(el);
  const moves = p.points.length - 1;
  $('#price-note').textContent = `${moves} price change${moves === 1 ? '' : 's'} detected for ${p.key}. Hover a point for the date and the percentage move.`;
  const rows = p.points.slice(1).map((pt, i) => {
    const prev = p.points[i].v;
    const pct = ((pt.v - prev) / prev) * 100;
    return `<tr><td>${esc(new Date(pt.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }))} UTC</td><td class="mono">${sym}${prev} → ${sym}${pt.v}</td><td class="mono" style="color:var(${pct > 0 ? '--bad' : '--ok'})">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</td></tr>`;
  }).reverse();
  $('#price-history').innerHTML = rows.length ? `<thead><tr><th>Detected</th><th>Move</th><th>Change</th></tr></thead><tbody>${rows.join('')}</tbody>` : '';
}

// ------------------------------------------------------------------ sources table
const STATUS_COLOR = { approved: '--ok', pending: '--warn', paused: '--faint', rejected: '--bad' };
function renderSources(s) {
  const head = `<thead><tr><th>Source</th><th>Status</th><th>Last check</th><th style="text-align:right">Checks 7d</th><th style="text-align:right">Changes 7d</th><th>Max significance, 30 days</th><th></th></tr></thead>`;
  const rows = [...s.sources].sort((a, b) => ['approved', 'pending', 'paused', 'rejected'].indexOf(a.status) - ['approved', 'pending', 'paused', 'rejected'].indexOf(b.status) || a.name.localeCompare(b.name)).map((x) => {
    const heat = x.daily_max_significance.map((v, i) => `<i style="background:${v ? `color-mix(in srgb, var(--accent) ${Math.round(18 + (v / 100) * 82)}%, var(--grid))` : 'var(--grid)'}" data-tip="${esc(`<b>${shortDate(s.daily[i].date)}</b><br>${v ? `max significance ${v}` : 'no changes'}`)}"></i>`).join('');
    const path = x.status === 'rejected' ? '' : `<a href="/demo-sites/${esc(x.host)}${esc(sourcePath(x))}" target="_blank" rel="noopener">view live page</a>`;
    return `<tr><td><div>${esc(x.name)}</div><div class="host">${esc(x.host)} ${path ? '· ' + path : ''}</div></td>
      <td><span class="pill" style="--pc:var(${STATUS_COLOR[x.status]})">${x.status}</span></td>
      <td>${x.last_checked_at ? `${esc((x.last_outcome || '').replace('_', ' '))} <span class="host">${ago(x.last_checked_at)}</span>` : '<span class="host">never</span>'}</td>
      <td class="num">${x.checks_7d}</td><td class="num">${x.meaningful_changes_7d}</td>
      <td><div class="heat">${heat}</div></td>
      <td>${x.status === 'approved' ? `<button class="btn ghost" type="button" data-check="${x.id}">Check</button>` : ''}</td></tr>`;
  }).join('');
  $('#sources').innerHTML = head + `<tbody>${rows}</tbody>`;
  bindTips($('#sources'));
  $('#sources').querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', () => runChecks([b.dataset.check], b)));
}
const sourcePaths = new Map();
function sourcePath(x) { return sourcePaths.get(x.id) || '/'; }
async function loadSourcePaths() {
  const r = await api('/v1/sources?limit=100');
  if (r.ok) for (const s of r.data.data) sourcePaths.set(s.id, new URL(s.url).pathname);
}

// ------------------------------------------------------------------ check runs (202 + poll)
async function runChecks(sourceIds, button) {
  const btn = button || $('#run-now');
  btn.disabled = true;
  try {
    const r = await api('/v1/check-runs', { method: 'POST', body: sourceIds ? { source_ids: sourceIds } : {}, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    if (r.status !== 202) { toast(r.data.detail || r.data.title || `HTTP ${r.status}`); return; }
    const loc = new URL(r.headers.get('Location')).pathname;
    let run = r.data;
    for (let i = 0; i < 30 && (run.status === 'queued' || run.status === 'running'); i++) {
      await new Promise((res) => setTimeout(res, 1000 * Number(r.headers.get('Retry-After') || 1)));
      run = (await api(loc)).data;
    }
    const counts = {};
    for (const x of run.results) counts[x.outcome] = (counts[x.outcome] || 0) + 1;
    toast(`Check run ${run.status}: ${Object.entries(counts).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}`);
    await refresh();
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ propose form (201 / 409 / 422 problem details)
function bindPropose() {
  $('#propose').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const out = $('#propose-result');
    const body = { url: f.url.value.trim(), name: f.name.value.trim() };
    if (f.min_significance.value !== '') body.min_significance = Number(f.min_significance.value);
    const r = await api('/v1/sources', { method: 'POST', body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    out.className = `result show ${r.ok ? 'ok' : 'err'}`;
    if (r.ok) {
      out.innerHTML = `<b>201 Created</b> · <span class="mono">${esc(r.data.id)}</span> is <b>${esc(r.data.status)}</b>. It will not be fetched until an admin approves it.<br><span class="host">Location: ${esc(r.headers.get('Location'))}</span>`;
      f.reset();
      refresh();
    } else {
      const p = r.data;
      out.innerHTML = `<b>${p.status} ${esc(p.title)}</b><br>${esc(p.detail || '')}${p.errors ? `<ul class="signals">${p.errors.map((x) => `<li><code>${esc(x.field)}</code> ${esc(x.message)}</li>`).join('')}</ul>` : ''}<span class="host">type: ${esc(p.type)}</span>`;
    }
  });
}

// ------------------------------------------------------------------ digests & deliveries
function renderDigests() {
  $('#digests').innerHTML = state.digests.slice(0, 7).map((d) => `<li><div class="grow"><div>${shortDate(d.period_start)}</div><div class="small">${d.change_count} meaningful change${d.change_count === 1 ? '' : 's'} · email ${esc(d.email_status.replace('_', ' '))}</div></div><button class="link" type="button" data-digest="${d.id}">Preview</button></li>`).join('') || '<li>No digests yet.</li>';
  $('#digests').querySelectorAll('[data-digest]').forEach((b) => b.addEventListener('click', () => openDigest(b.dataset.digest)));
}
async function openDigest(id) {
  const r = await api(`/v1/digests/${id}`, { accept: 'text/html' });
  if (!r.ok) return;
  const d = state.digests.find((x) => x.id === id);
  $('#dm-title').textContent = `Digest for ${d ? shortDate(d.period_start) : id} · GET /v1/digests/${id} (Accept: text/html)`;
  $('#dm-frame').srcdoc = r.data;
  $('#digest-modal').showModal();
}
function renderDeliveries(s) {
  $('#receiver-sub').textContent = `${s.receiver.verified} verified, ${s.receiver.rejected} rejected by the receiver since boot`;
  $('#deliveries').innerHTML = s.recent_deliveries.map((d) => `<li><span class="status-dot" style="background:var(${d.status === 'succeeded' ? '--ok' : d.status === 'failed' ? '--bad' : '--warn'})"></span><div class="grow"><div class="mono" style="font-size:12.5px">${esc(d.event_type)}</div><div class="small">${esc(d.status)} · attempt ${d.attempts} · HTTP ${d.last_response_status ?? '—'} · ${ago(d.created_at)}</div></div></li>`).join('') || '<li><div class="grow small">No deliveries yet. They appear when a meaningful change, digest, or check run completes after boot. Try “Run checks now”.</div></li>';
}

// ------------------------------------------------------------------ toast, theme, boot
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 4200);
}
function bindTheme() {
  const root = document.documentElement;
  const sel = $('#theme');
  sel.value = root.dataset.theme;
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  sel.addEventListener('change', () => { root.dataset.theme = sel.value; save('driftline.theme', sel.value); redraw(); });
  $('#mode').addEventListener('click', () => { root.dataset.mode = root.dataset.mode === 'dark' ? 'light' : 'dark'; save('driftline.mode', root.dataset.mode); redraw(); });
}
function redraw() {
  if (!state.stats) return;
  renderKpis(state.stats);
  renderActivity(state.stats);
  renderDonut(state.stats);
  renderPrices(state.stats);
}

async function refresh() {
  const [st, dg] = await Promise.all([api('/v1/stats/overview?days=30'), api('/v1/digests?limit=7')]);
  if (st.ok && !st.cached) {
    state.stats = st.data;
    renderKpis(st.data);
    renderActivity(st.data);
    renderDonut(st.data);
    renderPriceSelect(st.data);
    renderPrices(st.data);
    renderSources(st.data);
    renderDeliveries(st.data);
  }
  if (dg.ok && !dg.cached) { state.digests = dg.data.data; renderDigests(); }
  await loadChanges();
}

async function boot() {
  bindTheme();
  bindPropose();
  renderFilters();
  $('#run-now').addEventListener('click', () => runChecks(null));
  $('#price-series').addEventListener('change', () => renderPrices(state.stats));
  $('#d-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  $('#dm-close').addEventListener('click', () => $('#digest-modal').close());
  document.querySelectorAll('#drawer [data-tab]').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; renderDrawerBody(); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) closeDrawer(); });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redraw, 150); });
  await loadSourcePaths();
  await refresh();
  const m = /change=(chg_[0-9A-Z]{26})/.exec(location.hash);
  if (m) openChange(m[1]);
  setInterval(() => { if (!document.hidden) refresh(); }, 30_000);
}
boot().catch((err) => toast(`Failed to load: ${err.message}`));
