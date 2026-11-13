import { describe, expect, it } from 'vitest';
import {
  canonicalIp,
  inCidrs,
  parseCidr,
  parseCidrList,
  parseIp,
  resolveClientIp,
} from './cidr.js';
import { loadConfig } from './index.js';
import { buildTestEnv } from './testing.js';

const cidrs = (text: string) => parseCidrList(text) ?? [];

describe('parseIp', () => {
  it.each([
    ['1.2.3.4', '1.2.3.4'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['::1', '0:0:0:0:0:0:0:1'],
    ['::', '0:0:0:0:0:0:0:0'],
    ['2001:db8::8a2e:370:7334', '2001:db8:0:0:0:8a2e:370:7334'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8:0:0:0:0:0:1'],
    ['::ffff:127.0.0.1', '127.0.0.1'], // IPv4-mapped is the IPv4 address
    ['::ffff:7f00:1', '127.0.0.1'],
    ['::FFFF:10.1.2.3', '10.1.2.3'],
  ])('%s', (text, canon) => {
    const ip = parseIp(text);
    expect(ip).not.toBeNull();
    expect(canonicalIp(ip as NonNullable<typeof ip>)).toBe(canon);
  });

  it.each([
    '',
    'abc',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3.4/24',
    '1.2.3.4:80',
    ':::',
    '1::2::3',
    '12345::1',
    'g::1',
    '::1%eth0',
    '1.2.3.4, 5.6.7.8',
    ' 1.2.3.4',
  ])('rejects %j', (text) => {
    expect(parseIp(text)).toBeNull();
  });
});

describe('parseCidr and parseCidrList', () => {
  it('parses ranges and single hosts', () => {
    expect(parseCidr('10.0.0.0/8')).toMatchObject({ version: 4, bits: 8 });
    expect(parseCidr('127.0.0.1')).toMatchObject({ version: 4, bits: 32 });
    expect(parseCidr('::1/128')).toMatchObject({ version: 6, bits: 128 });
    expect(parseCidr('0.0.0.0/0')).toMatchObject({ bits: 0 });
  });
  it.each(['10.0.0.0/33', '::/129', '10.0.0.0/-1', '10.0.0.0/a', '10.0.0.0/8/8', '/8', 'x/8', ''])(
    'rejects %j',
    (t) => {
      expect(parseCidr(t)).toBeNull();
    },
  );
  it('none and empty mean trust nobody; any bad entry fails the whole list', () => {
    expect(parseCidrList('none')).toEqual([]);
    expect(parseCidrList('NONE')).toEqual([]);
    expect(parseCidrList('')).toEqual([]);
    expect(parseCidrList('127.0.0.1/32, ::1/128')).toHaveLength(2);
    expect(parseCidrList('127.0.0.1/32,nonsense')).toBeNull();
    expect(parseCidrList('none,127.0.0.1')).toBeNull(); // "none" is only valid alone
  });
});

describe('inCidrs', () => {
  const list = cidrs('10.0.0.0/8, 192.168.1.5, 2001:db8::/32');
  it.each([
    ['10.1.2.3', true],
    ['10.255.255.255', true],
    ['11.0.0.1', false],
    ['192.168.1.5', true],
    ['192.168.1.6', false],
    ['2001:db8:1::1', true],
    ['2001:db9::1', false],
    ['::ffff:10.0.0.9', true], // a mapped address matches the IPv4 range
  ])('%s -> %s', (text, expected) => {
    expect(inCidrs(parseIp(text) as NonNullable<ReturnType<typeof parseIp>>, list)).toBe(expected);
  });
  it('an IPv4 address never matches an IPv6 range and vice versa', () => {
    expect(
      inCidrs(parseIp('1.2.3.4') as NonNullable<ReturnType<typeof parseIp>>, cidrs('::/0')),
    ).toBe(false);
    expect(
      inCidrs(parseIp('::1') as NonNullable<ReturnType<typeof parseIp>>, cidrs('0.0.0.0/0')),
    ).toBe(false);
  });
});

describe('resolveClientIp (D-69)', () => {
  const trusted = cidrs('127.0.0.1/32, ::1/128, 10.0.0.0/8');
  const r = (socketAddress: string | undefined, forwardedFor: string | undefined, t = trusted) =>
    resolveClientIp({ socketAddress, forwardedFor, trusted: t });

  it('no trusted proxy (the default): the header is ignored and the socket address is the answer, whatever it says', () => {
    expect(r('203.0.113.9', '1.1.1.1', [])).toBe('203.0.113.9');
    expect(r('127.0.0.1', '1.1.1.1', [])).toBe('127.0.0.1');
  });

  it('a spoofed header from a source that is not a trusted proxy is ignored (must fail), the honest header from a trusted one is used (control)', () => {
    expect(r('203.0.113.9', '198.51.100.7')).toBe('203.0.113.9'); // spoof from the open internet
    expect(r('203.0.113.9', '127.0.0.1, 198.51.100.7')).toBe('203.0.113.9');
    expect(r('127.0.0.1', '198.51.100.7')).toBe('198.51.100.7'); // control: from the trusted proxy
  });

  it('walks from the right: the rightmost entry that is not a trusted proxy wins, so client-supplied entries on the left cannot choose the identity', () => {
    // the client claims to be 1.1.1.1; our proxy appended the real peer 198.51.100.7
    expect(r('127.0.0.1', '1.1.1.1, 198.51.100.7')).toBe('198.51.100.7');
    // two proxies in a row: 10.0.0.5 is trusted too, so it is skipped
    expect(r('127.0.0.1', '198.51.100.7, 10.0.0.5')).toBe('198.51.100.7');
    expect(r('127.0.0.1', '1.1.1.1, 2.2.2.2, 198.51.100.7, 10.0.0.5, 10.0.0.6')).toBe(
      '198.51.100.7',
    );
  });

  it('IPv4-mapped socket addresses (dual-stack) are matched as IPv4', () => {
    expect(r('::ffff:127.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
    expect(r('::ffff:203.0.113.9', '198.51.100.7')).toBe('::ffff:203.0.113.9'); // untrusted: socket address untouched
  });

  it('IPv6 clients are returned in their canonical form', () => {
    expect(r('::1', '2001:DB8::1')).toBe('2001:db8:0:0:0:0:0:1');
  });

  it('a missing, empty or malformed header falls back to the socket address (never a guess)', () => {
    expect(r('127.0.0.1', undefined)).toBe('127.0.0.1');
    expect(r('127.0.0.1', '')).toBe('127.0.0.1');
    expect(r('127.0.0.1', ' , ,')).toBe('127.0.0.1');
    expect(r('127.0.0.1', 'garbage')).toBe('127.0.0.1');
    expect(r('127.0.0.1', '198.51.100.7, garbage')).toBe('127.0.0.1'); // the rightmost entry is not an address
    expect(r('127.0.0.1', '1.1.1.1, <script>')).toBe('127.0.0.1');
  });

  it('when every entry is a trusted proxy the leftmost is the answer', () => {
    expect(r('127.0.0.1', '10.0.0.1, 10.0.0.2')).toBe('10.0.0.1');
  });

  it('no socket address, no answer; a socket address that is not an address is returned as is', () => {
    expect(r(undefined, '1.1.1.1')).toBeUndefined();
    expect(r('unix-socket', '1.1.1.1')).toBe('unix-socket');
  });

  it('a very long or hostile header cannot hang or change the answer', () => {
    const hostile = `${'1.1.1.1, '.repeat(5000)}198.51.100.7`;
    expect(r('127.0.0.1', hostile)).toBe('198.51.100.7');
  });
});

describe('TRUSTED_PROXY_CIDRS in the configuration', () => {
  it('defaults to trusting nobody in local and test (control)', () => {
    expect(loadConfig(buildTestEnv({ TRUSTED_PROXY_CIDRS: undefined })).trustedProxies).toEqual([]);
    expect(
      loadConfig(buildTestEnv({ APP_ENV: 'local', TRUSTED_PROXY_CIDRS: undefined })).trustedProxies,
    ).toEqual([]);
  });

  it('reads a list', () => {
    const c = loadConfig(buildTestEnv({ TRUSTED_PROXY_CIDRS: '127.0.0.1/32, 10.0.0.0/8' }));
    expect(c.trustedProxies).toHaveLength(2);
  });

  it('staging and production must state it explicitly: missing is refused, "none" and a list are accepted (control)', () => {
    for (const appEnv of ['staging', 'production']) {
      const base = {
        APP_ENV: appEnv,
        MARKET_DATA_SOURCE: 'PROVIDER',
        COOKIE_SECURE: 'true',
        TRADING_ENABLED: 'true',
      };
      expect(() => loadConfig(buildTestEnv({ ...base, TRUSTED_PROXY_CIDRS: undefined }))).toThrow(
        /TRUSTED_PROXY_CIDRS/,
      );
      expect(
        loadConfig(buildTestEnv({ ...base, TRUSTED_PROXY_CIDRS: 'none' })).trustedProxies,
      ).toEqual([]);
      expect(
        loadConfig(buildTestEnv({ ...base, TRUSTED_PROXY_CIDRS: '10.0.0.0/8' })).trustedProxies,
      ).toHaveLength(1);
    }
  });

  it.each(['nonsense', '10.0.0.0/99', '1.2.3.4,xyz', '10.0.0.0/8/8'])(
    'rejects %j by name without echoing it',
    (value) => {
      let message = '';
      try {
        loadConfig(buildTestEnv({ TRUSTED_PROXY_CIDRS: value }));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('TRUSTED_PROXY_CIDRS');
      expect(message).not.toContain(value);
    },
  );
});
