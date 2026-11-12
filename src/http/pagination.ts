import type { Context } from 'hono';
import { Problems } from './problem.ts';
import { intParam } from './validate.ts';

/**
 * Opaque cursor pagination. IDs are ULIDs (time-ordered), so "the page after X"
 * is `WHERE id < X ORDER BY id DESC`: stable under concurrent inserts, unlike
 * OFFSET, which skips or repeats rows when new data arrives between requests.
 */
export interface PageParams {
  limit: number;
  before: string | null;
}

export function pageParams(c: Context): PageParams {
  const limit = intParam(c, 'limit', 25, 1, 100);
  const cursor = c.req.query('cursor');
  if (!cursor) return { limit, before: null };
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw Problems.badParam('cursor', 'is not a valid cursor');
  }
  const before = (decoded as { b?: unknown }).b;
  if (typeof before !== 'string' || !/^[a-z]{3}_[0-9A-Z]{26}$/.test(before)) throw Problems.badParam('cursor', 'is not a valid cursor');
  return { limit, before };
}

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ b: id })).toString('base64url');
}

/** Builds the list envelope and sets an RFC 8288 `Link: rel="next"` header. Expects `limit + 1` rows. */
export function page<T extends { id: string }>(c: Context, baseUrl: string, rows: T[], limit: number, map: (r: T) => unknown) {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const self = new URL(c.req.url);
  const selfUrl = `${baseUrl}${self.pathname}${self.search}`;
  let next: string | null = null;
  if (hasMore && last) {
    const params = new URLSearchParams(self.search);
    params.set('cursor', encodeCursor(last.id));
    params.set('limit', String(limit));
    next = `${baseUrl}${self.pathname}?${params.toString()}`;
    c.header('Link', `<${next}>; rel="next"`);
  }
  return {
    data: items.map(map),
    page: { limit, has_more: hasMore, next_cursor: hasMore && last ? encodeCursor(last.id) : null },
    links: { self: selfUrl, next },
  };
}
