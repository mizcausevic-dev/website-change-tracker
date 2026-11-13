import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildOpenApi } from '../src/openapi.ts';
import { harness, type Harness } from './helpers.ts';

/**
 * Contract tests: the OpenAPI document is the source of truth for clients, so
 * (1) every route the router serves is documented and every documented path is
 * served, and (2) real responses validate against the documented schemas.
 */
let h: Harness;
const spec = buildOpenApi('http://test.local') as { paths: Record<string, Record<string, unknown>> };
const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
ajv.addSchema({ ...spec, $id: 'spec' });
const check = (schema: string, data: unknown): void => {
  const validate = ajv.getSchema(`spec#/components/schemas/${schema}`)!;
  assert.ok(validate(data), `${schema}: ${ajv.errorsText(validate.errors)}`);
};

before(async () => {
  h = await harness({ days: 5 });
});

describe('route coverage', () => {
  it('documents exactly the /v1 routes the app serves', () => {
    const served = new Set(
      h.app.routes
        .filter((r) => r.path.startsWith('/v1') && r.method !== 'ALL')
        .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`),
    );
    const documented = new Set(Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`)));
    assert.deepEqual([...served].filter((r) => !documented.has(r)), [], 'served but undocumented');
    assert.deepEqual([...documented].filter((r) => !served.has(r)), [], 'documented but not served');
  });
});

describe('responses match schemas', () => {
  it('lists and single resources', async () => {
    const sources = (await (await h.req('GET', '/v1/sources?limit=100')).json()) as { data: unknown[] };
    for (const s of sources.data) check('Source', s);
    const changes = (await (await h.req('GET', '/v1/changes?meaningful=any&limit=100')).json()) as { data: Array<{ id: string }> };
    assert.ok(changes.data.length > 5);
    for (const c of changes.data) check('Change', c);
    check('ChangeWithDiff', await (await h.req('GET', `/v1/changes/${changes.data[0]!.id}`)).json());
    const src = sources.data[0] as { id: string };
    const snaps = (await (await h.req('GET', `/v1/sources/${src.id}/snapshots`)).json()) as { data: Array<{ id: string }> };
    for (const s of snaps.data) check('Snapshot', s);
    if (snaps.data[0]) check('Snapshot', await (await h.req('GET', `/v1/snapshots/${snaps.data[0].id}`)).json());
    const checks = (await (await h.req('GET', `/v1/sources/${src.id}/checks?limit=50`)).json()) as { data: unknown[] };
    for (const c of checks.data) check('Check', c);
  });

  it('digests, webhooks, deliveries, stats, runs, root and problems', async () => {
    const digests = (await (await h.req('GET', '/v1/digests')).json()) as { data: Array<{ id: string }> };
    for (const d of digests.data) check('Digest', d);
    check('DigestWithPayload', await (await h.req('GET', `/v1/digests/${digests.data[0]!.id}`)).json());
    const hooks = (await (await h.req('GET', '/v1/webhooks')).json()) as { data: Array<{ id: string }> };
    for (const w of hooks.data) check('Webhook', w);
    const created = await h.req('POST', '/v1/webhooks', { body: { url: 'https://hooks.example.net/c', events: ['digest.ready'] } });
    check('WebhookCreated', await created.json());
    check('StatsOverview', await (await h.req('GET', '/v1/stats/overview')).json());
    const run = await h.req('POST', '/v1/check-runs', { body: {} });
    const runBody = (await run.json()) as { id: string };
    check('CheckRun', runBody);
    await h.ctx.runPromises.get(runBody.id);
    check('CheckRun', await (await h.req('GET', `/v1/check-runs/${runBody.id}`)).json());
    const deliveries = (await (await h.req('GET', `/v1/webhooks/${hooks.data[0]!.id}/deliveries`)).json()) as { data: unknown[] };
    for (const d of deliveries.data) check('Delivery', d);
    check('ApiRoot', await (await h.req('GET', '/v1', { key: null })).json());
    for (const r of [await h.req('GET', '/v1/sources', { key: null }), await h.req('GET', '/v1/changes/chg_nope'), await h.req('POST', '/v1/sources', { body: { url: 1 } })]) {
      check('Problem', await r.json());
    }
  });
});

describe('new 1.1 responses match schemas', () => {
  it('ignore preview, feedback, webhook filter, test delivery', async () => {
    const src = ((await (await h.req('GET', '/v1/sources?q=kestrel')).json()) as { data: Array<{ id: string }> }).data[0]!;
    check('IgnorePreview', await (await h.req('POST', `/v1/sources/${src.id}/ignore-preview`, { body: { ignore_patterns: ['Rated*reviews'] } })).json());
    const chg = ((await (await h.req('GET', '/v1/changes?limit=1')).json()) as { data: Array<{ id: string }> }).data[0]!;
    check('Feedback', await (await h.req('PUT', `/v1/changes/${chg.id}/feedback`, { body: { verdict: 'meaningful', note: 'price moved' } })).json());
    const w = await (await h.req('POST', '/v1/webhooks', { body: { url: 'https://hooks.example.net/f', events: ['change.detected'], filter: { min_significance: 0, tags: ['legal'] } } })).json() as { id: string };
    check('WebhookCreated', w);
    check('Delivery', await (await h.req('POST', `/v1/webhooks/${w.id}/test`)).json());
  });
});
