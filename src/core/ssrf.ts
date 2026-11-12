import { BlockList, isIP } from 'node:net';

/**
 * Server-side request forgery guard.
 *
 * A change tracker fetches URLs that API callers supply, which is exactly the
 * SSRF threat model: "track http://169.254.169.254/computeMetadata/v1/" would
 * read cloud credentials. Hostname checks are not enough because DNS can point
 * a public name at a private address (and re-point it between check and use).
 * The fetcher therefore calls `isPublicAddress` inside the socket's DNS lookup,
 * so the address that is validated is the address that is connected to.
 */
const blocked = new BlockList();

const V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6: Array<[string, number]> = [
  // ::/96 is IPv4-compatible (deprecated) and also covers :: and ::1; ::ffff:0:0:0/96 is IPv4-translated.
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6');

/** Extract the IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d / ::ffff:xxxx:xxxx) IPv6 address. */
function mappedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1] ?? null;
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1] ?? '0', 16);
    const lo = parseInt(hex[2] ?? '0', 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = mappedV4(ip);
    if (v4) return isIP(v4) === 4 && !blocked.check(v4, 'ipv4');
    return !blocked.check(ip, 'ipv6');
  }
  return false;
}

export class SsrfError extends Error {
  readonly code = 'ssrf_blocked';
}
