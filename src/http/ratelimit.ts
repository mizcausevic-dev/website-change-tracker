/**
 * Token bucket per (key, client) pair. Capacity = limit per minute, refilled
 * continuously. Responses carry RateLimit-Limit / -Remaining / -Reset
 * (IETF httpapi rate-limit header fields, draft) and 429s carry Retry-After.
 *
 * In-memory is deliberate: the deployment runs a single instance. A
 * multi-instance deployment would move this to Redis or the database.
 */
interface Bucket {
  tokens: number;
  updated: number;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSec: number;
  retryAfterSec: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  take(id: string, limitPerMin: number, now: number, cost = 1): RateDecision {
    const rate = limitPerMin / 60_000; // tokens per ms
    let b = this.buckets.get(id);
    if (!b) {
      b = { tokens: limitPerMin, updated: now };
      this.buckets.set(id, b);
    }
    b.tokens = Math.min(limitPerMin, b.tokens + (now - b.updated) * rate);
    b.updated = now;
    const allowed = b.tokens >= cost;
    if (allowed) b.tokens -= cost;
    this.sweep(now);
    return {
      allowed,
      limit: limitPerMin,
      remaining: Math.max(0, Math.floor(b.tokens)),
      resetSec: Math.ceil((limitPerMin - b.tokens) / rate / 1000),
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((cost - b.tokens) / rate / 1000)),
    };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (now - b.updated > 10 * 60_000) this.buckets.delete(k);
  }
}
