import { CATEGORIES } from './core/significance.ts';
import { EVENT_TYPES } from './core/webhooks.ts';
import { SCOPES } from './http/auth.ts';

/**
 * OpenAPI 3.1 description of the API. It is hand-written rather than
 * generated, and the test suite holds it honest two ways: every route the
 * router serves must appear here (and vice versa), and real responses are
 * validated against these schemas with Ajv.
 */
type S = Record<string, unknown>;
const ref = (name: string): S => ({ $ref: `#/components/schemas/${name}` });
const str = (extra: S = {}): S => ({ type: 'string', ...extra });
const int = (extra: S = {}): S => ({ type: 'integer', ...extra });
const nullable = (schema: S): S => ({ anyOf: [schema, { type: 'null' }] });
const dt = str({ format: 'date-time' });
const obj = (properties: S, required: string[] = Object.keys(properties), extra: S = {}): S => ({ type: 'object', properties, required, ...extra });
const list = (item: string): S =>
  obj({
    data: { type: 'array', items: ref(item) },
    page: obj({ limit: int(), has_more: { type: 'boolean' }, next_cursor: nullable(str()) }),
    links: obj({ self: str({ format: 'uri' }), next: nullable(str({ format: 'uri' })) }),
  });

const problem = (description: string): S => ({ description, content: { 'application/problem+json': { schema: ref('Problem') } } });
const json = (schema: S, description = 'OK', headers: S = {}): S => ({ description, headers, content: { 'application/json': { schema } } });
const STD_ERRORS = { '401': { $ref: '#/components/responses/Unauthenticated' }, '403': { $ref: '#/components/responses/Forbidden' }, '429': { $ref: '#/components/responses/RateLimited' } };
const idParam = (name: string, prefix: string): S => ({ name, in: 'path', required: true, schema: str({ pattern: `^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$` }) });
const PAGE_PARAMS = [
  { name: 'limit', in: 'query', schema: int({ minimum: 1, maximum: 100, default: 25 }) },
  { name: 'cursor', in: 'query', schema: str(), description: 'Opaque cursor from `page.next_cursor`.' },
];
const RL_HEADERS = {
  'RateLimit-Limit': { schema: int(), description: 'Requests allowed per minute for this key and client.' },
  'RateLimit-Remaining': { schema: int() },
  'RateLimit-Reset': { schema: int(), description: 'Seconds until the bucket is full again.' },
  ETag: { schema: str() },
};
const sec = (scope: string): S[] => [{ bearer: [scope] }];

export function buildOpenApi(baseUrl: string): S {
  const sourceEditable = {
    name: str({ maxLength: 120 }),
    tags: { type: 'array', maxItems: 10, items: str({ pattern: '^[a-z0-9][a-z0-9-]{0,31}$' }) },
    selector: nullable(str({ maxLength: 200, description: 'CSS selector for the content root. Defaults to <body>.' })),
    ignore_selectors: { type: 'array', maxItems: 20, items: str({ maxLength: 200 }), description: 'Elements removed before extraction (ads, carousels, widgets).' },
    ignore_patterns: { type: 'array', maxItems: 20, items: str({ maxLength: 200 }), description: 'Literal text with `*` wildcards (not regex, to rule out ReDoS) removed from each line.' },
    check_interval_minutes: int({ minimum: 15, maximum: 10080, default: 60 }),
    min_significance: int({ minimum: 0, maximum: 100, default: 20, description: 'Changes scoring below this are recorded but not "meaningful": excluded from digests and webhooks.' }),
    notes: nullable(str({ maxLength: 500 })),
  };
  const transition = (action: string, scope: string, summary: string, noteRequired = false): S => ({
    post: {
      tags: ['Sources'], operationId: `${action}Source`, summary, security: sec(scope),
      parameters: [idParam('id', 'src')],
      requestBody: { required: noteRequired, content: { 'application/json': { schema: obj({ note: str({ maxLength: 500 }) }, noteRequired ? ['note'] : [], { additionalProperties: false }) } } },
      responses: { '200': json(ref('Source')), '404': problem('Unknown source'), '409': problem('Transition not allowed from the current status'), '422': problem('Validation failed'), ...STD_ERRORS },
    },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Driftline: website change tracker API',
      version: '1.0.0',
      description:
        'Track an approved list of web pages, store normalized snapshots, detect meaningful changes, and deliver digests and signed webhooks.\n\n' +
        'Conventions: RFC 9457 problem details for every error; opaque cursor pagination with RFC 8288 `Link` headers; strong ETags on every GET (send `If-None-Match` for 304s); ' +
        '`If-Match` required on PATCH; `Idempotency-Key` honoured on every POST; long-running work returns `202 Accepted` with a `Location` to poll.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: baseUrl }],
    tags: [
      { name: 'Discovery' }, { name: 'Sources', description: 'Approved URLs and their review lifecycle: pending → approved ⇄ paused, pending → rejected → approved.' },
      { name: 'Snapshots' }, { name: 'Changes' }, { name: 'Check runs' }, { name: 'Digests' }, { name: 'Webhooks' }, { name: 'Stats' },
    ],
    security: [{ bearer: [] }],
    paths: {
      '/v1': { get: { tags: ['Discovery'], operationId: 'getApiRoot', summary: 'API root with links to every collection', security: [{}, { bearer: [] }], responses: { '200': json(ref('ApiRoot')) } } },
      '/v1/openapi.json': { get: { tags: ['Discovery'], operationId: 'getOpenApi', summary: 'This document', security: [{}, { bearer: [] }], responses: { '200': json({ type: 'object' }) } } },
      '/v1/sources': {
        get: {
          tags: ['Sources'], operationId: 'listSources', summary: 'List sources', security: sec('sources:read'),
          parameters: [...PAGE_PARAMS, { name: 'status', in: 'query', schema: str({ enum: ['pending', 'approved', 'paused', 'rejected'] }) }, { name: 'tag', in: 'query', schema: str() }, { name: 'q', in: 'query', schema: str({ maxLength: 100 }), description: 'Substring match on name or URL.' }],
          responses: { '200': json(list('Source'), 'OK', RL_HEADERS), '400': problem('Invalid query parameter'), ...STD_ERRORS },
        },
        post: {
          tags: ['Sources'], operationId: 'proposeSource', summary: 'Propose a URL to track (created as pending)', security: [{ bearer: ['sources:propose'] }, { bearer: ['sources:write'] }],
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: { 'application/json': { schema: { ...obj({ url: str({ format: 'uri', maxLength: 2048 }), ...sourceEditable }, ['url', 'name']), additionalProperties: false } } } },
          responses: {
            '201': json(ref('Source'), 'Created', { Location: { schema: str({ format: 'uri' }) }, ETag: { schema: str() } }),
            '409': problem('Duplicate URL, or the review queue is full'), '413': problem('Body too large'), '415': problem('Wrong content type'), '422': problem('Validation failed'), ...STD_ERRORS,
          },
        },
      },
      '/v1/sources/{id}': {
        get: { tags: ['Sources'], operationId: 'getSource', summary: 'Get a source', security: sec('sources:read'), parameters: [idParam('id', 'src')], responses: { '200': json(ref('Source'), 'OK', RL_HEADERS), '304': { description: 'Not modified' }, '404': problem('Unknown source'), ...STD_ERRORS } },
        patch: {
          tags: ['Sources'], operationId: 'updateSource', summary: 'Update a source (JSON Merge Patch, optimistic concurrency)', security: sec('sources:write'),
          parameters: [idParam('id', 'src'), { name: 'If-Match', in: 'header', required: true, schema: str(), description: 'ETag from the last GET.' }],
          requestBody: { required: true, content: { 'application/merge-patch+json': { schema: { ...obj(sourceEditable, []), additionalProperties: false } } } },
          responses: { '200': json(ref('Source')), '404': problem('Unknown source'), '412': problem('ETag does not match: the source changed since it was read'), '415': problem('Use application/merge-patch+json'), '422': problem('Validation failed'), '428': problem('If-Match header missing'), ...STD_ERRORS },
        },
        delete: { tags: ['Sources'], operationId: 'deleteSource', summary: 'Delete a source and its history', security: sec('sources:write'), parameters: [idParam('id', 'src'), { name: 'If-Match', in: 'header', schema: str() }], responses: { '204': { description: 'Deleted' }, '404': problem('Unknown source'), '412': problem('ETag mismatch'), ...STD_ERRORS } },
      },
      '/v1/sources/{id}/approve': transition('approve', 'sources:approve', 'Approve a pending or rejected source; checks start immediately'),
      '/v1/sources/{id}/reject': transition('reject', 'sources:approve', 'Reject a pending source (note required)', true),
      '/v1/sources/{id}/pause': transition('pause', 'sources:write', 'Pause checks for an approved source'),
      '/v1/sources/{id}/resume': transition('resume', 'sources:write', 'Resume a paused source'),
      '/v1/sources/{id}/snapshots': { get: { tags: ['Snapshots'], operationId: 'listSnapshots', summary: 'List stored snapshots (text omitted)', security: sec('sources:read'), parameters: [idParam('id', 'src'), ...PAGE_PARAMS], responses: { '200': json(list('Snapshot')), '404': problem('Unknown source'), ...STD_ERRORS } } },
      '/v1/sources/{id}/checks': {
        get: {
          tags: ['Sources'], operationId: 'listChecks', summary: 'List checks, including no-change and noise outcomes', security: sec('sources:read'),
          parameters: [idParam('id', 'src'), ...PAGE_PARAMS, { name: 'outcome', in: 'query', schema: str({ enum: ['baseline', 'changed', 'unchanged', 'noise', 'not_modified', 'blocked', 'error'] }) }],
          responses: { '200': json(list('Check')), '404': problem('Unknown source'), ...STD_ERRORS },
        },
      },
      '/v1/snapshots/{id}': {
        get: {
          tags: ['Snapshots'], operationId: 'getSnapshot', summary: 'Get a snapshot with its normalized text', security: sec('sources:read'), parameters: [idParam('id', 'snp')],
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('Snapshot') }, 'text/plain': { schema: str() } } }, '404': problem('Unknown snapshot'), ...STD_ERRORS },
        },
      },
      '/v1/changes': {
        get: {
          tags: ['Changes'], operationId: 'listChanges', summary: 'List detected changes (meaningful only, by default)', security: sec('changes:read'),
          parameters: [
            ...PAGE_PARAMS,
            { name: 'source_id', in: 'query', schema: str() },
            { name: 'category', in: 'query', schema: str({ enum: CATEGORIES }) },
            { name: 'meaningful', in: 'query', schema: str({ enum: ['true', 'false', 'any'], default: 'true' }) },
            { name: 'min_significance', in: 'query', schema: int({ minimum: 0, maximum: 100 }) },
            { name: 'since', in: 'query', schema: dt }, { name: 'until', in: 'query', schema: dt },
          ],
          responses: { '200': json(list('Change'), 'OK', RL_HEADERS), '400': problem('Invalid query parameter'), ...STD_ERRORS },
        },
      },
      '/v1/changes/{id}': {
        get: {
          tags: ['Changes'], operationId: 'getChange', summary: 'Get a change with its diff. `Accept: text/x-diff` returns a unified diff.', security: sec('changes:read'), parameters: [idParam('id', 'chg')],
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('ChangeWithDiff') }, 'text/x-diff': { schema: str() }, 'text/plain': { schema: str() } } }, '404': problem('Unknown change'), '406': problem('No acceptable representation'), ...STD_ERRORS },
        },
      },
      '/v1/check-runs': {
        post: {
          tags: ['Check runs'], operationId: 'createCheckRun', summary: 'Check sources now (asynchronous)', security: sec('checks:run'),
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { content: { 'application/json': { schema: { ...obj({ source_ids: { type: 'array', maxItems: 20, items: str() } }, []), additionalProperties: false } } } },
          responses: { '202': json(ref('CheckRun'), 'Accepted: poll the Location', { Location: { schema: str({ format: 'uri' }) }, 'Retry-After': { schema: int() } }), '422': problem('Validation failed'), ...STD_ERRORS },
        },
      },
      '/v1/check-runs/{id}': { get: { tags: ['Check runs'], operationId: 'getCheckRun', summary: 'Poll a check run', security: sec('checks:run'), parameters: [idParam('id', 'run')], responses: { '200': json(ref('CheckRun'), 'OK', { 'Retry-After': { schema: int(), description: 'Present while queued or running.' } }), '404': problem('Unknown run'), ...STD_ERRORS } } },
      '/v1/digests': {
        get: { tags: ['Digests'], operationId: 'listDigests', summary: 'List digests', security: sec('digests:read'), parameters: PAGE_PARAMS, responses: { '200': json(list('Digest')), ...STD_ERRORS } },
        post: {
          tags: ['Digests'], operationId: 'createDigest', summary: 'Build a digest for a period and deliver it (email if configured, plus `digest.ready` webhooks)', security: sec('digests:write'),
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: { 'application/json': { schema: { ...obj({ period_start: dt, period_end: dt, send: { type: 'boolean', default: true } }, ['period_start', 'period_end']), additionalProperties: false } } } },
          responses: { '201': json(ref('DigestWithPayload'), 'Created'), '409': problem('A digest for this period exists'), '422': problem('Validation failed'), ...STD_ERRORS },
        },
      },
      '/v1/digests/{id}': {
        get: {
          tags: ['Digests'], operationId: 'getDigest', summary: 'Get a digest. `Accept: text/html` returns the email body; `text/plain` the text part.', security: sec('digests:read'), parameters: [idParam('id', 'dig')],
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: ref('DigestWithPayload') }, 'text/html': { schema: str() }, 'text/plain': { schema: str() } } }, '404': problem('Unknown digest'), '406': problem('No acceptable representation'), ...STD_ERRORS },
        },
      },
      '/v1/webhooks': {
        get: { tags: ['Webhooks'], operationId: 'listWebhooks', summary: 'List webhook endpoints', security: sec('webhooks:manage'), parameters: PAGE_PARAMS, responses: { '200': json(list('Webhook')), ...STD_ERRORS } },
        post: {
          tags: ['Webhooks'], operationId: 'createWebhook', summary: 'Register an endpoint. The signing secret is returned once.', security: sec('webhooks:manage'),
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: { 'application/json': { schema: { ...obj({ url: str({ format: 'uri' }), events: { type: 'array', minItems: 1, items: str({ enum: EVENT_TYPES }) }, description: nullable(str({ maxLength: 200 })) }, ['url', 'events']), additionalProperties: false } } } },
          responses: { '201': json(ref('WebhookCreated'), 'Created'), '422': problem('Validation failed'), ...STD_ERRORS },
        },
      },
      '/v1/webhooks/{id}': {
        get: { tags: ['Webhooks'], operationId: 'getWebhook', summary: 'Get a webhook endpoint', security: sec('webhooks:manage'), parameters: [idParam('id', 'whk')], responses: { '200': json(ref('Webhook')), '404': problem('Unknown webhook'), ...STD_ERRORS } },
        delete: { tags: ['Webhooks'], operationId: 'deleteWebhook', summary: 'Delete a webhook endpoint', security: sec('webhooks:manage'), parameters: [idParam('id', 'whk')], responses: { '204': { description: 'Deleted' }, '404': problem('Unknown webhook'), ...STD_ERRORS } },
      },
      '/v1/webhooks/{id}/deliveries': { get: { tags: ['Webhooks'], operationId: 'listDeliveries', summary: 'Delivery attempts, with retry state', security: sec('webhooks:manage'), parameters: [idParam('id', 'whk'), ...PAGE_PARAMS], responses: { '200': json(list('Delivery')), '404': problem('Unknown webhook'), ...STD_ERRORS } } },
      '/v1/stats/overview': { get: { tags: ['Stats'], operationId: 'getStatsOverview', summary: 'Aggregates behind the dashboard', security: sec('stats:read'), parameters: [{ name: 'days', in: 'query', schema: int({ minimum: 1, maximum: 90, default: 30 }) }], responses: { '200': json(ref('StatsOverview'), 'OK', RL_HEADERS), ...STD_ERRORS } } },
    },
    webhooks: {
      changeDetected: {
        post: {
          summary: 'A meaningful change was detected',
          description: 'Signed per Standard Webhooks: verify `webhook-signature` (v1, HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${body}`) and reject timestamps older than 5 minutes. Failed deliveries retry after 1m, 5m, 30m, 2h and 6h.',
          requestBody: { content: { 'application/json': { schema: obj({ type: str({ enum: EVENT_TYPES }), timestamp: dt, data: { type: 'object' } }) } } },
          responses: { '2XX': { description: 'Acknowledged' } },
        },
      },
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: `API key. Scopes: ${SCOPES.join(', ')}.` } },
      parameters: {
        IdempotencyKey: { name: 'Idempotency-Key', in: 'header', schema: str({ minLength: 1, maxLength: 255 }), description: 'Retries with the same key and body replay the first response (`Idempotent-Replayed: true`) for 24 hours.' },
      },
      responses: {
        Unauthenticated: problem('Missing or invalid API key'),
        Forbidden: problem('API key lacks the required scope'),
        RateLimited: { description: 'Rate limited', headers: { 'Retry-After': { schema: int() } }, content: { 'application/problem+json': { schema: ref('Problem') } } },
      },
      schemas: {
        Problem: obj({ type: str({ format: 'uri' }), title: str(), status: int(), detail: str(), instance: str(), request_id: str(), errors: { type: 'array', items: obj({ field: str(), message: str() }) } }, ['type', 'title', 'status', 'instance', 'request_id']),
        ApiRoot: obj({ object: str({ const: 'api_root' }), name: str(), version: str(), documentation: str(), openapi: str(), authentication: { type: 'object' }, links: { type: 'object', additionalProperties: str({ format: 'uri' }) } }),
        Source: obj({
          id: str({ pattern: '^src_' }), object: str({ const: 'source' }), url: str({ format: 'uri' }), name: str(),
          status: str({ enum: ['pending', 'approved', 'paused', 'rejected'] }), tags: { type: 'array', items: str() }, selector: nullable(str()),
          ignore_selectors: { type: 'array', items: str() }, ignore_patterns: { type: 'array', items: str() },
          check_interval_minutes: int(), min_significance: int(), notes: nullable(str()),
          review: obj({ reviewed_by: nullable(str()), reviewed_at: nullable(dt), note: nullable(str()) }),
          last_checked_at: nullable(dt), last_outcome: nullable(str()), next_check_at: nullable(dt), created_at: dt, updated_at: dt, revision: int(),
          links: obj({ self: str(), snapshots: str(), changes: str(), checks: str() }),
        }),
        Snapshot: obj({
          id: str({ pattern: '^snp_' }), object: str({ const: 'snapshot' }), source_id: str(), captured_at: dt, content_hash: str({ pattern: '^sha256:[0-9a-f]{64}$' }),
          word_count: int(), byte_size: int(), http_status: int(), facts: { type: 'array', items: ref('Fact') }, text: str(), links: obj({ self: str(), source: str() }),
        }, ['id', 'object', 'source_id', 'captured_at', 'content_hash', 'word_count', 'byte_size', 'http_status', 'facts', 'links']),
        Fact: obj({ key: str(), value: { type: 'number' }, currency: str({ enum: ['USD', 'EUR', 'GBP'] }), raw: str() }),
        Check: obj({
          id: str({ pattern: '^chk_' }), object: str({ const: 'check' }), source_id: str(), run_id: nullable(str()), started_at: dt, duration_ms: int(),
          outcome: str({ enum: ['baseline', 'changed', 'unchanged', 'noise', 'not_modified', 'blocked', 'error'] }), http_status: nullable(int()), bytes: nullable(int()),
          snapshot_id: nullable(str()), change_id: nullable(str()), error: nullable(str()),
        }),
        Change: obj({
          id: str({ pattern: '^chg_' }), object: str({ const: 'change' }), source_id: str(), source_name: nullable(str()), detected_at: dt,
          significance: int({ minimum: 0, maximum: 100 }), meaningful: { type: 'boolean' }, category: str({ enum: CATEGORIES }), summary: str(),
          words_added: int(), words_removed: int(), fact_changes: { type: 'array', items: obj({ key: str(), from: nullable({ type: 'number' }), to: nullable({ type: 'number' }), currency: str(), pct: nullable({ type: 'number' }) }) },
          signals: { type: 'array', items: str(), description: 'Why the change scored what it did.' }, from_snapshot_id: str(), to_snapshot_id: str(),
          links: obj({ self: str(), source: str(), from_snapshot: str(), to_snapshot: str() }),
        }),
        ChangeWithDiff: { allOf: [ref('Change'), obj({ hunks: { type: 'array', items: ref('Hunk') } })] },
        Hunk: obj({
          old_start: int(), old_lines: int(), new_start: int(), new_lines: int(),
          lines: { type: 'array', items: obj({ op: str({ enum: ['ctx', 'add', 'del'] }), text: str(), old: int(), new: int(), segments: { type: 'array', items: obj({ op: str({ enum: ['eq', 'add', 'del'] }), text: str() }) } }, ['op', 'text']) },
        }),
        CheckRun: obj({
          id: str({ pattern: '^run_' }), object: str({ const: 'check_run' }), status: str({ enum: ['queued', 'running', 'succeeded', 'failed'] }), source_ids: { type: 'array', items: str() },
          created_at: dt, started_at: nullable(dt), finished_at: nullable(dt), results: { type: 'array', items: { type: 'object' } }, links: obj({ self: str() }),
        }),
        Digest: obj({ id: str({ pattern: '^dig_' }), object: str({ const: 'digest' }), period_start: dt, period_end: dt, created_at: dt, change_count: int(), email_status: str(), links: obj({ self: str() }) }),
        DigestWithPayload: { allOf: [ref('Digest'), obj({ payload: { type: 'object' } })] },
        Webhook: obj({ id: str({ pattern: '^whk_' }), object: str({ const: 'webhook' }), url: str({ format: 'uri' }), description: nullable(str()), events: { type: 'array', items: str({ enum: EVENT_TYPES }) }, active: { type: 'boolean' }, secret_hint: str(), created_at: dt, links: obj({ self: str(), deliveries: str() }) }),
        WebhookCreated: { allOf: [ref('Webhook'), obj({ secret: str({ pattern: '^whsec_' }) })] },
        Delivery: obj({
          id: str({ pattern: '^dlv_' }), object: str({ const: 'delivery' }), webhook_id: str(), message_id: str(), event_type: str(), status: str({ enum: ['pending', 'succeeded', 'retrying', 'failed'] }),
          attempts: int(), last_response_status: nullable(int()), last_error: nullable(str()), created_at: dt, next_attempt_at: nullable(dt), delivered_at: nullable(dt),
        }),
        StatsOverview: obj({ object: str({ const: 'stats_overview' }), generated_at: dt, window: { type: 'object' }, totals: { type: 'object' }, by_category: { type: 'object' }, daily: { type: 'array' }, sources: { type: 'array' }, price_series: { type: 'array' }, recent_deliveries: { type: 'array', items: ref('Delivery') }, receiver: { type: 'object' } }),
      },
    },
  };
}
