import { describe, expect, it } from 'vitest';
import { downstreamResponseHeaders, isAllowedPath, upstreamRequestHeaders } from './upstream';

describe('isAllowedPath: only the API versioned routes and its health check are proxied', () => {
  it.each([
    [['v1', 'auth', 'login']],
    [['v1', 'portfolio']],
    [['v1', 'orders', '0198d0d0-1111-7000-8000-000000000001']],
    [['health']],
    [['health', 'ready']],
  ])('allows %j', (segments) => {
    expect(isAllowedPath(segments)).toBe(true);
  });

  it.each([
    [[]],
    [['']],
    [['v2', 'x']],
    [['admin']],
    [['v1', '..', 'health']],
    [['..', 'v1']],
    [['v1', '.', 'me']],
    [['v1', 'a%2f..%2fb']],
    [['v1', 'a\\b']],
    [['health', 'ready', 'extra']],
    [['_next', 'static']],
  ])('refuses %j', (segments) => {
    expect(isAllowedPath(segments)).toBe(false);
  });
});

describe('upstreamRequestHeaders', () => {
  it('passes the cookie, origin, content type, idempotency key and request id on (control)', () => {
    const out = upstreamRequestHeaders(
      new Headers({
        cookie: 'vantage_session=abc',
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
        'idempotency-key': 'key-12345678',
        'x-request-id': 'req-12345678',
        accept: 'application/json',
      }),
      { trustForwardedFor: false },
    );
    expect(out.get('cookie')).toBe('vantage_session=abc');
    expect(out.get('origin')).toBe('http://localhost:3000');
    expect(out.get('content-type')).toBe('application/json');
    expect(out.get('idempotency-key')).toBe('key-12345678');
    expect(out.get('x-request-id')).toBe('req-12345678');
  });

  it('drops hop-by-hop headers, host, content-length and accept-encoding', () => {
    const out = upstreamRequestHeaders(
      new Headers({
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        host: 'localhost:3000',
        'content-length': '12',
        'accept-encoding': 'gzip',
        te: 'trailers',
        'proxy-authorization': 'x',
      }),
      { trustForwardedFor: false },
    );
    expect([...out.keys()]).toEqual([]);
  });
});

describe('X-Forwarded-For handling (D-69)', () => {
  const incoming = new Headers({
    'x-forwarded-for': '198.51.100.7',
    forwarded: 'for=1.1.1.1',
    'x-real-ip': '1.1.1.1',
    'x-client-ip': '1.1.1.1',
    'true-client-ip': '1.1.1.1',
    cookie: 'vantage_session=abc',
  });

  it('trusted: the X-Forwarded-For Next provides is passed to the API; other claims of a client address are still dropped', () => {
    const out = upstreamRequestHeaders(incoming, { trustForwardedFor: true });
    expect(out.get('x-forwarded-for')).toBe('198.51.100.7');
    for (const h of ['forwarded', 'x-real-ip', 'x-client-ip', 'true-client-ip'])
      expect(out.has(h), h).toBe(false);
    expect(out.get('cookie')).toBe('vantage_session=abc'); // control: the rest still crosses
  });

  it('not trusted (the safe setting for a directly exposed app): every client-address header is dropped, the cookie still crosses', () => {
    const out = upstreamRequestHeaders(incoming, { trustForwardedFor: false });
    for (const h of [
      'x-forwarded-for',
      'forwarded',
      'x-real-ip',
      'x-client-ip',
      'true-client-ip',
    ]) {
      expect(out.has(h), h).toBe(false);
    }
    expect(out.get('cookie')).toBe('vantage_session=abc');
  });
});

describe('downstreamResponseHeaders', () => {
  it('keeps every Set-Cookie as its own header, plus the request id and retry hint (control)', () => {
    const up = new Headers({ 'x-request-id': 'req-12345678', 'retry-after': '30' });
    up.append('set-cookie', 'vantage_session=abc; HttpOnly; SameSite=Lax; Path=/');
    up.append('set-cookie', 'other=1; Path=/');
    const out = downstreamResponseHeaders(up);
    expect(out.getSetCookie()).toEqual([
      'vantage_session=abc; HttpOnly; SameSite=Lax; Path=/',
      'other=1; Path=/',
    ]);
    expect(out.get('x-request-id')).toBe('req-12345678');
    expect(out.get('retry-after')).toBe('30');
  });

  it('drops hop-by-hop, content-encoding and content-length (they no longer describe the body)', () => {
    const out = downstreamResponseHeaders(
      new Headers({
        connection: 'close',
        'transfer-encoding': 'chunked',
        'content-encoding': 'gzip',
        'content-length': '100',
        'content-type': 'application/json',
      }),
    );
    expect([...out.keys()]).toEqual(['content-type']);
  });
});
