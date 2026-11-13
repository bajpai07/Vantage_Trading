// IP addresses and CIDR ranges, and the one rule for finding the real client address behind a proxy (D-69).
// Pure: no IO, no globals. IPv4 and IPv6 are both parsed to exact BigInt values.

export interface Cidr {
  readonly version: 4 | 6;
  /** The network address as an integer. */
  readonly base: bigint;
  /** Prefix length in bits. */
  readonly bits: number;
}

interface ParsedIp {
  readonly version: 4 | 6;
  readonly value: bigint;
}

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function parseV4(text: string): bigint | null {
  if (!V4.test(text)) return null;
  return text.split('.').reduce((acc, part) => acc * 256n + BigInt(part), 0n);
}

function parseV6(text: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || text.includes(':::')) return null;
  let head = text;
  let tail4: bigint | null = null;
  // an IPv4 address may end the text (::ffff:1.2.3.4): it fills the last two groups
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.')) {
    tail4 = parseV4(text.slice(lastColon + 1));
    if (tail4 === null) return null;
    head = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string): string[] => (s === '' ? [] : s.split(':'));
  const left = groups(halves[0] ?? '');
  const right = groups(halves[1] ?? '');
  const total = left.length + right.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const all = [...left, ...Array<string>(8 - total).fill('0'), ...right];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  let value = all.reduce((acc, g) => (acc << 16n) + BigInt(`0x${g}`), 0n);
  if (tail4 !== null) value = ((value >> 32n) << 32n) + tail4;
  return value;
}

const MAPPED_PREFIX = 0xffffn << 32n;

/** Parses an IPv4 or IPv6 address. An IPv4-mapped IPv6 address (::ffff:1.2.3.4) is treated as the IPv4 address. */
export function parseIp(text: string): ParsedIp | null {
  const v4 = parseV4(text);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseV6(text);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { version: 4, value: v6 - MAPPED_PREFIX };
  return { version: 6, value: v6 };
}

/** A stable text form for an address: dotted IPv4, or eight unpadded lowercase hex groups for IPv6. */
export function canonicalIp(ip: ParsedIp): string {
  if (ip.version === 4) {
    return [24n, 16n, 8n, 0n].map((s) => String((ip.value >> s) & 255n)).join('.');
  }
  return Array.from({ length: 8 }, (_, i) =>
    ((ip.value >> BigInt((7 - i) * 16)) & 0xffffn).toString(16),
  ).join(':');
}

/** "10.0.0.0/8", "::1/128" or a bare address (a single host). Null when it is not one. */
export function parseCidr(text: string): Cidr | null {
  const [addr, len, extra] = text.trim().split('/');
  if (addr === undefined || addr === '' || extra !== undefined) return null;
  const ip = parseIp(addr);
  if (ip === null) return null;
  const width = ip.version === 4 ? 32 : 128;
  let bits = width;
  if (len !== undefined) {
    if (!/^\d{1,3}$/.test(len)) return null;
    bits = parseInt(len, 10);
    if (bits > width) return null;
  }
  const shift = BigInt(width - bits);
  return { version: ip.version, base: (ip.value >> shift) << shift, bits };
}

/**
 * A comma-separated list of CIDRs or addresses; "none" or an empty list means no proxy is trusted. Returns null if
 * any entry is invalid (the caller reports the variable name, never the value).
 */
export function parseCidrList(text: string): Cidr[] | null {
  const items = text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (items.length === 0 || (items.length === 1 && items[0]?.toLowerCase() === 'none')) return [];
  const out: Cidr[] = [];
  for (const item of items) {
    const c = parseCidr(item);
    if (c === null) return null;
    out.push(c);
  }
  return out;
}

export function inCidrs(ip: ParsedIp, cidrs: readonly Cidr[]): boolean {
  return cidrs.some((c) => {
    if (c.version !== ip.version) return false;
    const shift = BigInt((c.version === 4 ? 32 : 128) - c.bits);
    return ip.value >> shift === c.base >> shift;
  });
}

/**
 * D-69. The address of the client of THIS request:
 * - If the socket peer is not a trusted proxy (or no proxy is trusted, the default), `X-Forwarded-For` is ignored
 *   completely and the socket address is the answer: anyone can send that header, so it is trusted only from a proxy
 *   we name.
 * - If the peer is a trusted proxy, walk the header from the RIGHT (the entries our own proxies appended) and answer
 *   with the first address that is not itself a trusted proxy. An entry that is not an address stops the walk and the
 *   answer falls back to the peer, so a malformed header can never choose the identity.
 * - If every entry is a trusted proxy, the leftmost one is the answer.
 */
export function resolveClientIp(input: {
  readonly socketAddress: string | undefined;
  readonly forwardedFor: string | undefined;
  readonly trusted: readonly Cidr[];
}): string | undefined {
  const { socketAddress, forwardedFor, trusted } = input;
  if (socketAddress === undefined) return undefined;
  const peer = parseIp(socketAddress);
  if (peer === null || trusted.length === 0 || !inCidrs(peer, trusted)) return socketAddress;
  if (forwardedFor === undefined) return socketAddress;
  const entries = forwardedFor
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (entries.length === 0) return socketAddress;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const ip = parseIp(entries[i] ?? '');
    if (ip === null) return socketAddress;
    if (!inCidrs(ip, trusted)) return canonicalIp(ip);
  }
  const leftmost = parseIp(entries[0] ?? '');
  return leftmost === null ? socketAddress : canonicalIp(leftmost);
}
