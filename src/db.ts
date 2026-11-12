import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

// One file, applied idempotently at boot. STRICT tables make SQLite reject
// type-confused writes instead of silently coercing them.
const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  rate_limit_per_min INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','paused','rejected')),
  tags TEXT NOT NULL DEFAULT '[]',
  selector TEXT,
  ignore_selectors TEXT NOT NULL DEFAULT '[]',
  ignore_patterns TEXT NOT NULL DEFAULT '[]',
  check_interval_minutes INTEGER NOT NULL,
  min_significance INTEGER NOT NULL,
  notes TEXT,
  review_note TEXT,
  proposed_by TEXT NOT NULL,
  proposer_fp TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_outcome TEXT,
  next_check_at TEXT,
  http_etag TEXT,
  http_last_modified TEXT,
  last_raw_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX IF NOT EXISTS sources_due ON sources (status, next_check_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  http_status INTEGER NOT NULL,
  facts TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX IF NOT EXISTS snapshots_source ON snapshots (source_id, id);

CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  run_id TEXT,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('baseline','changed','unchanged','noise','not_modified','blocked','error')),
  http_status INTEGER,
  bytes INTEGER,
  snapshot_id TEXT,
  change_id TEXT,
  error TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS checks_source ON checks (source_id, id);
CREATE INDEX IF NOT EXISTS checks_time ON checks (started_at);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  from_snapshot_id TEXT NOT NULL,
  to_snapshot_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  significance INTEGER NOT NULL,
  category TEXT NOT NULL,
  meaningful INTEGER NOT NULL,
  summary TEXT NOT NULL,
  words_added INTEGER NOT NULL,
  words_removed INTEGER NOT NULL,
  hunks TEXT NOT NULL,
  fact_changes TEXT NOT NULL DEFAULT '[]',
  signals TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE INDEX IF NOT EXISTS changes_source ON changes (source_id, id);
CREATE INDEX IF NOT EXISTS changes_time ON changes (detected_at);

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  requested_by TEXT NOT NULL,
  source_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  results TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  change_count INTEGER NOT NULL,
  payload TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  email_status TEXT NOT NULL,
  UNIQUE (period_start, period_end)
) STRICT;

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  description TEXT,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','retrying','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_response_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  next_attempt_at TEXT,
  delivered_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress','complete')),
  status INTEGER,
  headers TEXT,
  body TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS runs_created ON check_runs (created_at);
CREATE INDEX IF NOT EXISTS deliveries_created ON deliveries (created_at);
`;

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside BEGIN/COMMIT, rolling back on any throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export type Row = Record<string, string | number | null>;

export function all<T = Row>(db: Db, sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function one<T = Row>(db: Db, sql: string, ...params: Array<string | number | null>): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Db, sql: string, ...params: Array<string | number | null>): void {
  db.prepare(sql).run(...params);
}

export const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
