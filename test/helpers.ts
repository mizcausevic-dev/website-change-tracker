import { buildApp } from '../src/app.ts';
import { ManualClock } from '../src/clock.ts';
import { loadConfig, type Ctx } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { PageFetcher, type Transport } from '../src/core/fetcher.ts';
import { routingTransport } from '../src/core/transport.ts';
import { seedDemo } from '../src/fixtures/seed.ts';
import { DEMO_KEY, DEMO_SCOPES, SCOPES, upsertKey, type Scope } from '../src/http/auth.ts';

process.env.LOG_REQUESTS = 'off';

export const ADMIN_KEY ='wct_test_admin_key_for_the_test_suite_only';
export const NOW = Date.UTC(2026, 10, 12, 15, 30, 0); // fixed "now" for deterministic tests

export interface Harness {
  ctx: Ctx;
  clock: ManualClock;
  app: ReturnType<typeof buildApp>;
  req: (method: string, path: string, opts?: { key?: string | null; body?: unknown; headers?: Record<string, string>; raw?: string }) => Promise<Response>;
  keyWith: (scopes: Scope[], name?: string, rate?: number) => string;
}

export async function harness(opts: { seed?: boolean; days?: number; net?: Transport; allowExternal?: boolean } = {}): Promise<Harness> {
  const clock = new ManualClock(NOW);
  const config = { ...loadConfig({}), publicBaseUrl: 'http://test.local', allowExternalFetch: !!opts.allowExternal };
  const receiver: Ctx['receiver'] = { secret: null, received: [] };
  const ctxRef: { ctx?: Ctx } = {};
  const now = (): number => ctxRef.ctx!.clock.now();
  const transport = routingTransport({
    now,
    net: opts.net ?? (async () => { throw new Error('network disabled in tests'); }),
    allowExternal: !!opts.allowExternal,
    receiverSecret: () => receiver.secret,
    received: receiver.received,
  });
  const ctx: Ctx = {
    db: openDb(':memory:'), clock, config, transport, fetcher: new PageFetcher(transport, now),
    inFlight: new Set(), runPromises: new Map(), receiver, bootedAt: NOW,
  };
  ctxRef.ctx = ctx;
  upsertKey(ctx.db, NOW, DEMO_KEY, 'Demo public key', DEMO_SCOPES, 1000);
  upsertKey(ctx.db, NOW, ADMIN_KEY, 'Test admin', [...SCOPES], 10_000);
  if (opts.seed !== false) await seedDemo(ctx, NOW, opts.days ?? 30);
  const app = buildApp(ctx);
  let n = 0;
  return {
    ctx,
    clock,
    app,
    keyWith: (scopes, name = `key-${++n}`, rate = 1000) => {
      const secret = `wct_test_${name.replace(/[^a-z0-9]/gi, '')}_${'x'.repeat(16)}`;
      upsertKey(ctx.db, NOW, secret, name, scopes, rate);
      return secret;
    },
    req: (method, path, o = {}) => {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      const key = o.key === undefined ? ADMIN_KEY : o.key;
      if (key) headers['authorization'] = `Bearer ${key}`;
      let body: string | undefined = o.raw;
      if (o.body !== undefined) {
        body = JSON.stringify(o.body);
        headers['content-type'] ??= 'application/json';
      }
      return Promise.resolve(app.request(`http://test.local${path}`, { method, headers, body }));
    },
  };
}
