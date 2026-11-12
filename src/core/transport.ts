import { FetchError, type FetchRequest, type FetchResponse, type Transport } from './fetcher.ts';
import { isFixtureHost, renderFixture } from '../fixtures/sites.ts';
import { verify } from './webhooks.ts';

export interface ReceivedEvent {
  received_at: string;
  message_id: string;
  event_type: string;
  verified: boolean;
  duplicate: boolean;
}

/**
 * Routes requests by host:
 *  - `receiver.example`  -> the in-process demo webhook receiver (verifies signatures)
 *  - other `*.example`   -> fictional fixture sites rendered at the current clock time
 *  - anything else       -> the SSRF-guarded network transport, only when external fetching is enabled
 */
export function routingTransport(opts: {
  now: () => number;
  net: Transport;
  allowExternal: boolean;
  receiverSecret: () => string | null;
  received: ReceivedEvent[];
}): Transport {
  return async (req: FetchRequest): Promise<FetchResponse> => {
    const u = new URL(req.url);
    const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (u.hostname === 'receiver.example') {
      const secret = opts.receiverSecret();
      const ok = !!secret && req.method === 'POST' && verify(secret, headers, req.body ?? '', Math.floor(opts.now() / 1000));
      let type = 'unknown';
      try {
        type = (JSON.parse(req.body ?? '{}') as { type?: string }).type ?? 'unknown';
      } catch {
        /* keep 'unknown' */
      }
      // A receiver must be idempotent: retries reuse the message id, and a captured request could be
      // replayed inside the timestamp window. Acknowledge duplicates without processing them again.
      const messageId = headers['webhook-id'] ?? '';
      const duplicate = ok && opts.received.some((e) => e.verified && e.message_id === messageId);
      opts.received.unshift({ received_at: new Date(opts.now()).toISOString(), message_id: messageId, event_type: type, verified: ok, duplicate });
      opts.received.length = Math.min(opts.received.length, 100);
      return { status: ok ? 204 : 401, headers: {}, body: '', bytes: 0, finalUrl: req.url };
    }
    if (isFixtureHost(u.hostname)) {
      const r = renderFixture(u.hostname, u.pathname, opts.now(), headers);
      return { status: r.status, headers: r.headers, body: r.body, bytes: Buffer.byteLength(r.body), finalUrl: req.url };
    }
    if (!opts.allowExternal) throw new FetchError('external_fetch_disabled', 'external fetching is disabled on this deployment');
    return opts.net(req);
  };
}
