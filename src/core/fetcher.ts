import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import zlib from 'node:zlib';
import { isPublicAddress, SsrfError } from './ssrf.ts';
import { isAllowed, parseRobots } from './robots.ts';

export const USER_AGENT = 'DriftlineBot/1.0 (+https://github.com/mizcausevic-dev/website-change-tracker)';
export const UA_TOKEN = 'DriftlineBot';

export interface FetchRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}
export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  finalUrl: string;
}
export type Transport = (req: FetchRequest) => Promise<FetchResponse>;

export class FetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface NetOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedPorts?: number[];
}

/** DNS lookup that refuses non-public addresses. Handles both `all: true` (happy eyeballs) and single-address callers. */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '');
    if (!addresses.length) return callback(new SsrfError(`no addresses for ${hostname}`), '');
    const bad = addresses.find((a) => !isPublicAddress(a.address));
    if (bad) return callback(new SsrfError(`${hostname} resolves to non-public address ${bad.address}`), '');
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
}

const sameSite = (a: string, b: string): boolean => a.replace(/^www\./, '') === b.replace(/^www\./, '');

function assertFetchableUrl(raw: string, allowedPorts: number[]): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError('invalid_url', `not a URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('invalid_url', 'only http and https are fetched');
  if (u.username || u.password) throw new FetchError('invalid_url', 'credentials in URLs are not allowed');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!allowedPorts.includes(port)) throw new FetchError('port_not_allowed', `port ${port} is not allowed`);
  // Node never calls the custom `lookup` for IP-literal hosts, so literals must be checked here.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw new FetchError('ssrf_blocked', `${host} is not a public address`);
  return u;
}

/** Real network transport: SSRF-guarded, size- and time-bounded, decompressing, manual redirects. */
export function netTransport(opts: NetOptions = {}): Transport {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;
  const allowedPorts = opts.allowedPorts ?? [80, 443];

  const once = (u: URL, req: FetchRequest): Promise<FetchResponse> =>
    new Promise((resolve, reject) => {
      const mod = u.protocol === 'https:' ? https : http;
      const r = mod.request(
        u,
        {
          method: req.method ?? 'GET',
          headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'gzip, deflate, br', ...req.headers },
          lookup: guardedLookup as never,
          timeout: timeoutMs,
          signal: AbortSignal.timeout(timeoutMs + 5_000),
        },
        (res) => {
          const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
          let stream: NodeJS.ReadableStream = res;
          if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
          else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
          else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (c: Buffer) => {
            size += c.length;
            // Checked after decompression, so a compression bomb is cut off too.
            if (size > maxBytes) {
              r.destroy(new FetchError('too_large', `response exceeds ${maxBytes} bytes`));
              return;
            }
            chunks.push(c);
          });
          stream.on('error', reject);
          stream.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8'), bytes: size, finalUrl: u.toString() });
          });
        },
      );
      r.on('timeout', () => r.destroy(new FetchError('timeout', `timed out after ${timeoutMs} ms`)));
      r.on('error', (e) => reject(e instanceof SsrfError ? new FetchError('ssrf_blocked', e.message) : e));
      if (req.body) r.write(req.body);
      r.end();
    });

  return async (req) => {
    let u = assertFetchableUrl(req.url, allowedPorts);
    const origin = u.hostname;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await once(u, req);
      if (![301, 302, 303, 307, 308].includes(res.status) || req.method === 'POST') return res;
      const loc = res.headers['location'];
      if (!loc) return res;
      const next = assertFetchableUrl(new URL(loc, u).toString(), allowedPorts);
      if (!sameSite(next.hostname, origin)) throw new FetchError('redirect_off_site', `redirect to ${next.hostname} leaves the approved site`);
      u = next;
    }
    throw new FetchError('too_many_redirects', `more than ${maxRedirects} redirects`);
  };
}

export interface PageResult {
  kind: 'ok' | 'not_modified' | 'blocked' | 'error';
  status: number | null;
  body: string;
  bytes: number;
  etag: string | null;
  lastModified: string | null;
  error: string | null;
  durationMs: number;
}

interface RobotsEntry {
  groups: ReturnType<typeof parseRobots>;
  fetchedAt: number;
  disallowAll: boolean;
}

/** Polite page fetcher: robots.txt, conditional GET, content-type gate. */
export class PageFetcher {
  private robots = new Map<string, RobotsEntry>();
  private transport: Transport;
  private now: () => number;
  private robotsTtlMs: number;
  constructor(transport: Transport, now: () => number, robotsTtlMs = 6 * 3600_000) {
    this.transport = transport;
    this.now = now;
    this.robotsTtlMs = robotsTtlMs;
  }

  private async robotsAllow(u: URL): Promise<boolean> {
    const key = u.origin;
    let entry = this.robots.get(key);
    if (!entry || this.now() - entry.fetchedAt > this.robotsTtlMs) {
      try {
        const res = await this.transport({ url: `${u.origin}/robots.txt` });
        if (res.status >= 200 && res.status < 300) entry = { groups: parseRobots(res.body), fetchedAt: this.now(), disallowAll: false };
        else if (res.status >= 400 && res.status < 500) entry = { groups: [], fetchedAt: this.now(), disallowAll: false };
        else entry = { groups: [], fetchedAt: this.now(), disallowAll: true }; // RFC 9309 §2.3.1.4: 5xx => assume disallowed
      } catch (err) {
        if (err instanceof FetchError && (err.code === 'ssrf_blocked' || err.code === 'external_fetch_disabled')) throw err;
        entry = { groups: [], fetchedAt: this.now(), disallowAll: true };
      }
      this.robots.set(key, entry);
    }
    return !entry.disallowAll && isAllowed(entry.groups, UA_TOKEN, u.pathname + u.search);
  }

  async fetchPage(url: string, validators: { etag?: string | null; lastModified?: string | null } = {}): Promise<PageResult> {
    const started = performance.now();
    const done = (r: Omit<PageResult, 'durationMs'>): PageResult => ({ ...r, durationMs: Math.max(1, Math.round(performance.now() - started)) });
    const base = { status: null, body: '', bytes: 0, etag: null, lastModified: null };
    try {
      const u = new URL(url);
      if (!(await this.robotsAllow(u))) return done({ ...base, kind: 'blocked', error: 'disallowed by robots.txt' });
      const headers: Record<string, string> = { accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5' };
      if (validators.etag) headers['if-none-match'] = validators.etag;
      if (validators.lastModified) headers['if-modified-since'] = validators.lastModified;
      const res = await this.transport({ url, headers });
      const etag = res.headers['etag'] ?? null;
      const lastModified = res.headers['last-modified'] ?? null;
      if (res.status === 304) return done({ ...base, kind: 'not_modified', status: 304, etag: etag ?? validators.etag ?? null, lastModified: lastModified ?? validators.lastModified ?? null, error: null });
      if (res.status < 200 || res.status >= 300) return done({ ...base, kind: 'error', status: res.status, bytes: res.bytes, error: `HTTP ${res.status}` });
      const ctype = (res.headers['content-type'] ?? '').toLowerCase();
      if (ctype && !/text\/html|application\/xhtml\+xml|text\/plain/.test(ctype)) {
        return done({ ...base, kind: 'error', status: res.status, bytes: res.bytes, error: `unsupported content-type ${ctype.split(';')[0]}` });
      }
      return done({ kind: 'ok', status: res.status, body: res.body, bytes: res.bytes, etag, lastModified, error: null });
    } catch (err) {
      const code = err instanceof FetchError ? err.code : 'network_error';
      const kind = code === 'ssrf_blocked' || code === 'external_fetch_disabled' ? 'blocked' : 'error';
      return done({ ...base, kind, error: `${code}: ${(err as Error).message}` });
    }
  }
}
