import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import type { PageFetcher, Transport } from './core/fetcher.ts';
import type { ReceivedEvent } from './core/transport.ts';

export interface Config {
  port: number;
  publicBaseUrl: string;
  allowExternalFetch: boolean;
  adminApiKey: string | null;
  demoMode: boolean;
  schedulerEnabled: boolean;
  resendApiKey: string | null;
  digestFrom: string | null;
  digestTo: string | null;
  trustProxy: boolean;
}

export interface Ctx {
  db: Db;
  clock: Clock;
  config: Config;
  transport: Transport;
  fetcher: PageFetcher;
  /** Source IDs with a check in flight. Prevents the scheduler and a manual run from double-checking. */
  inFlight: Set<string>;
  /** Pending async check runs, so tests and shutdown can await them. */
  runPromises: Map<string, Promise<void>>;
  receiver: { secret: string | null; received: ReceivedEvent[] };
  bootedAt: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  return {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    allowExternalFetch: env.ALLOW_EXTERNAL_FETCH === 'true',
    adminApiKey: env.ADMIN_API_KEY && env.ADMIN_API_KEY.length >= 32 ? env.ADMIN_API_KEY : null,
    demoMode: env.DEMO_MODE !== 'false',
    schedulerEnabled: env.SCHEDULER !== 'off',
    resendApiKey: env.RESEND_API_KEY ?? null,
    digestFrom: env.DIGEST_FROM ?? null,
    digestTo: env.DIGEST_TO ?? null,
    trustProxy: env.TRUST_PROXY === 'true',
  };
}
