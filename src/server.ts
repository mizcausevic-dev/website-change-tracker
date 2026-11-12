import { serve } from '@hono/node-server';
import { buildApp } from './app.ts';
import { systemClock } from './clock.ts';
import { loadConfig, type Ctx } from './context.ts';
import { openDb } from './db.ts';
import { netTransport, PageFetcher } from './core/fetcher.ts';
import { startScheduler, tick } from './core/scheduler.ts';
import { routingTransport } from './core/transport.ts';
import { seedDemo } from './fixtures/seed.ts';
import { DEMO_KEY, DEMO_SCOPES, SCOPES, upsertKey } from './http/auth.ts';

const config = loadConfig();
const db = openDb(process.env.DATABASE_PATH ?? ':memory:');
const receiver: Ctx['receiver'] = { secret: null, received: [] };
const ctxRef: { ctx?: Ctx } = {};
const now = (): number => ctxRef.ctx!.clock.now();
const transport = routingTransport({ now, net: netTransport(), allowExternal: config.allowExternalFetch, receiverSecret: () => receiver.secret, received: receiver.received });

const ctx: Ctx = {
  db,
  clock: systemClock,
  config,
  transport,
  fetcher: new PageFetcher(transport, now),
  inFlight: new Set(),
  runPromises: new Map(),
  receiver,
  bootedAt: Date.now(),
};
ctxRef.ctx = ctx;

const log = (msg: string, extra: Record<string, unknown> = {}): void => console.log(JSON.stringify({ severity: 'INFO', msg, ...extra }));

if (config.demoMode) {
  upsertKey(db, Date.now(), DEMO_KEY, 'Demo public key', DEMO_SCOPES, 120);
  const r = await seedDemo(ctx, Date.now());
  log('demo history seeded', r);
}
if (config.adminApiKey) upsertKey(db, Date.now(), config.adminApiKey, 'Operations admin', [...SCOPES], 600);
else log('ADMIN_API_KEY not set (or shorter than 32 chars): admin-only endpoints are unreachable');

const app = buildApp(ctx);
const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => log('listening', { port: info.port, base: config.publicBaseUrl }));

let stop: (() => void) | null = null;
if (config.schedulerEnabled) {
  stop = startScheduler(ctx);
  void tick(ctx);
}

const shutdown = (signal: string): void => {
  log('shutting down', { signal });
  stop?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
