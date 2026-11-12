// Renders the endpoint reference from the live OpenAPI document, so the docs can't drift from the API.
'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function bindTheme() {
  const root = document.documentElement;
  const sel = $('#theme');
  sel.value = root.dataset.theme;
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  sel.addEventListener('change', () => { root.dataset.theme = sel.value; save('driftline.theme', sel.value); });
  $('#mode').addEventListener('click', () => { root.dataset.mode = root.dataset.mode === 'dark' ? 'light' : 'dark'; save('driftline.mode', root.dataset.mode); });
}

function schemaFields(schema, spec) {
  const resolve = (s) => (s && s.$ref ? spec.components.schemas[s.$ref.split('/').pop()] : s);
  const s = resolve(schema);
  if (!s || !s.properties) return '';
  const typeOf = (p) => {
    p = resolve(p);
    if (!p) return '';
    if (p.anyOf) return p.anyOf.map(typeOf).join(' | ');
    if (p.enum) return p.enum.map((e) => `"${e}"`).join(' | ');
    if (p.type === 'array') return `${typeOf(p.items)}[]`;
    return p.type || 'object';
  };
  const req = new Set(s.required || []);
  return `<table><thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead><tbody>${Object.entries(s.properties).map(([k, p]) => {
    const r = resolve(p) || {};
    const notes = [r.description, r.maxLength !== undefined ? `max ${r.maxLength} chars` : '', r.minimum !== undefined ? `${r.minimum}–${r.maximum}` : '', r.default !== undefined ? `default ${JSON.stringify(r.default)}` : ''].filter(Boolean).join('. ');
    return `<tr><td><code>${esc(k)}</code>${req.has(k) ? ' <b>*</b>' : ''}</td><td><code>${esc(typeOf(p))}</code></td><td>${esc(notes)}</td></tr>`;
  }).join('')}</tbody></table>`;
}

async function main() {
  bindTheme();
  const origin = location.origin;
  $('#base').textContent = origin;
  $('#qs').textContent = `KEY=wct_demo_public_explorer_key

# Discover the API
curl -s ${origin}/v1

# Meaningful pricing changes, newest first
curl -s "${origin}/v1/changes?category=pricing&limit=5" -H "Authorization: Bearer $KEY"

# Propose a page to track (pending until an admin approves it)
curl -s ${origin}/v1/sources -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"url":"https://www.example.com/pricing","name":"Example pricing"}'

# Check everything now: 202 Accepted, then poll the Location header
curl -si -X POST ${origin}/v1/check-runs -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" -d '{}'`;

  const spec = await (await fetch('/v1/openapi.json')).json();
  const byTag = new Map();
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const tag = (op.tags || ['Other'])[0];
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ path, method, op });
    }
  }
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const intro = [['quickstart', 'Quickstart'], ['auth', 'Authentication'], ['errors', 'Errors'], ['pagination', 'Pagination'], ['caching', 'Conditional requests'], ['idempotency', 'Idempotency'], ['async', 'Async check runs'], ['negotiation', 'Content negotiation'], ['limits', 'Rate limits'], ['webhooks', 'Webhooks'], ['fetching', 'How pages are fetched']];
  let toc = `<div class="group">Guide</div>${intro.map(([id, t]) => `<a href="#${id}">${t}</a>`).join('')}`;
  let html = '';
  for (const [tag, ops] of byTag) {
    toc += `<div class="group">${esc(tag)}</div>`;
    for (const { path, method, op } of ops) {
      const id = op.operationId || slug(method + path);
      toc += `<a href="#${esc(id)}">${esc(op.summary.split(/[.(]/)[0])}</a>`;
      const scopes = (op.security || []).flatMap((s) => Object.values(s).flat()).filter(Boolean);
      const params = (op.parameters || []).map((p) => (p.$ref ? spec.components.parameters[p.$ref.split('/').pop()] : p));
      const body = op.requestBody?.content ? Object.entries(op.requestBody.content)[0] : null;
      const codes = Object.keys(op.responses || {});
      html += `<div class="op" id="${esc(id)}"><h3><span class="verb ${method}">${method.toUpperCase()}</span><code>${esc(path)}</code></h3>
        <div class="summary">${esc(op.summary)}${scopes.length ? ` · scope <span class="scope">${esc([...new Set(scopes)].join(' or '))}</span>` : ' · no key required'}</div>
        ${params.length ? `<table><thead><tr><th>Parameter</th><th>In</th><th>Schema</th></tr></thead><tbody>${params.map((p) => `<tr><td><code>${esc(p.name)}</code>${p.required ? ' <b>*</b>' : ''}</td><td>${esc(p.in)}</td><td>${esc(p.description || (p.schema?.enum ? p.schema.enum.join(' | ') : p.schema?.type || ''))}</td></tr>`).join('')}</tbody></table>` : ''}
        ${body ? `<div style="font-size:13px;color:var(--muted)">Body: <code>${esc(body[0])}</code></div>${schemaFields(body[1].schema, spec)}` : ''}
        <div class="codes">${codes.map((c) => `<span class="code-pill c${c[0]}" title="${esc(op.responses[c].description || '')}">${esc(c)}</span>`).join('')}</div></div>`;
    }
  }
  $('#toc').innerHTML = toc;
  $('#ops').innerHTML = html;
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
main().catch((e) => { $('#ops').textContent = `Could not load the OpenAPI document: ${e.message}`; });
