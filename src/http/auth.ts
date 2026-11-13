import { createHash, randomBytes } from 'node:crypto';
import { iso } from '../clock.ts';
import { one, run, type Db } from '../db.ts';
import { newId } from '../ids.ts';
import { Problems } from './problem.ts';

export const SCOPES = [
  'sources:read', 'sources:propose', 'sources:write', 'sources:approve', 'changes:read', 'changes:feedback', 'changes:export',
  'checks:run', 'digests:read', 'digests:write', 'webhooks:manage', 'stats:read',
] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKey {
  id: string;
  name: string;
  scopes: Scope[];
  rateLimitPerMin: number;
}

/** Published in the README so anyone can explore the live demo. Read-only plus proposing sources and running checks. */
export const DEMO_KEY = 'wct_demo_public_explorer_key';
// The demo data is fictional, so visitors may also label changes and export history.
export const DEMO_SCOPES: Scope[] = ['sources:read', 'sources:propose', 'changes:read', 'changes:feedback', 'changes:export', 'checks:run', 'digests:read', 'stats:read'];

const hash = (secret: string): string => createHash('sha256').update(secret).digest('hex');

export function generateKey(env: 'live' | 'test' = 'live'): string {
  return `wct_${env}_${randomBytes(24).toString('base64url')}`;
}

/** Keys are stored as SHA-256 hashes. A database leak does not leak usable credentials. */
export function upsertKey(db: Db, now: number, secret: string, name: string, scopes: Scope[], rateLimitPerMin: number): string {
  const existing = one<{ id: string }>(db, 'SELECT id FROM api_keys WHERE hash = ?', hash(secret));
  if (existing) {
    run(db, 'UPDATE api_keys SET name = ?, scopes = ?, rate_limit_per_min = ? WHERE id = ?', name, JSON.stringify(scopes), rateLimitPerMin, existing.id);
    return existing.id;
  }
  const id = newId('key', now);
  run(db, 'INSERT INTO api_keys (id, name, prefix, hash, scopes, rate_limit_per_min, created_at) VALUES (?,?,?,?,?,?,?)',
    id, name, secret.slice(0, 12), hash(secret), JSON.stringify(scopes), rateLimitPerMin, iso(now));
  return id;
}

const lastTouched = new Map<string, number>();

export function authenticate(db: Db, header: string | undefined, now: number): ApiKey {
  if (!header) throw Problems.unauthenticated('Send an API key as "Authorization: Bearer <key>". The public demo key is in the README.');
  // RFC 6750 b64token characters, so keys made with base64 (+, /, =) or base64url both work.
  const m = /^Bearer\s+([A-Za-z0-9_\-.~+/]{16,128}=*)$/.exec(header.trim());
  if (!m) throw Problems.unauthenticated('Malformed Authorization header. Expected "Bearer <key>".', 'invalid_request');
  const row = one<{ id: string; name: string; scopes: string; rate_limit_per_min: number }>(db, 'SELECT id, name, scopes, rate_limit_per_min FROM api_keys WHERE hash = ?', hash(m[1]!));
  if (!row) throw Problems.unauthenticated('The API key is not recognized.', 'invalid_token');
  // Throttle last_used_at writes to once a minute per key.
  if ((lastTouched.get(row.id) ?? 0) + 60_000 < now) {
    lastTouched.set(row.id, now);
    run(db, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', iso(now), row.id);
  }
  return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes) as Scope[], rateLimitPerMin: row.rate_limit_per_min };
}

export function requireScope(key: ApiKey, scope: Scope): void {
  if (!key.scopes.includes(scope)) throw Problems.forbidden(scope);
}
