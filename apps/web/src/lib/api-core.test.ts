import { describe, expect, it } from 'vitest';
import { MeResponse, PortfolioResponse } from '@vantage/contracts';
import { fieldsFromMessage, interpretResponse, retryAfterSeconds } from './api-core';
import type { ApiFailure } from './api-core';
import { describeFailure, humanDuration } from './errors';

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const envelope = (code: string, message: string, requestId = 'req-1234abcd') => ({
  error: { code, message, requestId },
});

const me = {
  id: '0198d0d0-1111-7000-8000-000000000001',
  email: 'a@example.com',
  displayName: 'Ada',
  countryCode: 'IN',
  role: 'USER',
  status: 'ACTIVE',
};

describe('interpretResponse: success bodies are validated against the contract', () => {
  it('returns the parsed data for a valid body (control)', async () => {
    const r = await interpretResponse(json(200, me), MeResponse);
    expect(r).toMatchObject({ ok: true, status: 200, data: { displayName: 'Ada' } });
  });

  it('a body that does not match the contract is invalid_response, never rendered', async () => {
    for (const bad of [
      { ...me, role: 'GOD' },
      { ...me, extra: 1 },
      { id: 'x' },
      [],
      null,
      'text',
    ]) {
      const r = await interpretResponse(json(200, bad), MeResponse);
      expect(r).toMatchObject({ ok: false, kind: 'invalid_response', status: 200 });
    }
  });

  it('a body that is not JSON is invalid_response; the request id header becomes the support code', async () => {
    const r = await interpretResponse(
      new Response('<html>oops</html>', {
        status: 200,
        headers: { 'x-request-id': 'hdr-12345678' },
      }),
      MeResponse,
    );
    expect(r).toMatchObject({ ok: false, kind: 'invalid_response', supportCode: 'hdr-12345678' });
  });

  it('a money amount sent as a JSON number fails the contract (money is strings only)', async () => {
    const portfolio = { currency: 'USD', cash: 10000 };
    const r = await interpretResponse(json(200, portfolio), PortfolioResponse);
    expect(r).toMatchObject({ ok: false, kind: 'invalid_response' });
  });

  it('204 and schema null: no body is read', async () => {
    const r = await interpretResponse(new Response(null, { status: 204 }), null);
    expect(r).toMatchObject({ ok: true, status: 204 });
  });
});

describe('interpretResponse: failures become a kind, a code and a support code', () => {
  const cases: Array<[number, string, ApiFailure['kind']]> = [
    [401, 'UNAUTHENTICATED', 'unauthenticated'],
    [401, 'INVALID_CREDENTIALS', 'invalid_credentials'],
    [403, 'CSRF_REJECTED', 'forbidden'],
    [400, 'VALIDATION_ERROR', 'validation'],
    [404, 'NOT_FOUND', 'not_found'],
    [409, 'EMAIL_TAKEN', 'conflict'],
    [429, 'RATE_LIMITED', 'rate_limited'],
    [500, 'INTERNAL_ERROR', 'server'],
    [503, 'NOT_READY', 'server'],
  ];
  it.each(cases)('%s %s is %s, with the request id as support code', async (status, code, kind) => {
    const r = await interpretResponse(
      json(status, envelope(code, 'some internal message')),
      MeResponse,
    );
    expect(r).toMatchObject({ ok: false, kind, status, code, supportCode: 'req-1234abcd' });
  });

  it('a 400 names the fields (never values); a 429 carries the retry hint', async () => {
    const v = await interpretResponse(
      json(400, envelope('VALIDATION_ERROR', 'Invalid request: email, password')),
      MeResponse,
    );
    expect(v).toMatchObject({ fields: ['email', 'password'] });
    const t = await interpretResponse(
      json(429, envelope('RATE_LIMITED', 'Too many'), { 'retry-after': '90' }),
      MeResponse,
    );
    expect(t).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 90 });
  });

  it('a failure that is not the error envelope still yields a safe kind from the status alone', async () => {
    const r = await interpretResponse(
      new Response('<h1>Bad Gateway</h1>', { status: 502 }),
      MeResponse,
    );
    expect(r).toMatchObject({ ok: false, kind: 'server', code: null });
  });
});

describe('small parsers', () => {
  it.each([
    ['Invalid request: email, password', ['email', 'password']],
    ['Invalid request: body', ['body']],
    ['Invalid request: items.0.symbol', ['items.0.symbol']],
    ['no colon here', []],
    ['Invalid request: <script>, ok', ['ok']],
  ])('fieldsFromMessage(%s)', (m, out) => {
    expect(fieldsFromMessage(m)).toEqual(out);
  });

  it.each([
    ['30', 30],
    [' 7 ', 7],
    ['0', 0],
    [null, null],
    ['abc', null],
    ['1.5', null],
    ['-5', null],
    ['Wed, 21 Oct 2026 07:28:00 GMT', null],
  ])('retryAfterSeconds(%s)', (h, out) => {
    expect(retryAfterSeconds(h)).toBe(out);
  });
});

describe('describeFailure: every failure kind has a specific sentence and never echoes the API message', () => {
  const base: ApiFailure = {
    ok: false,
    kind: 'unknown',
    status: 0,
    code: null,
    retryAfterSeconds: null,
    supportCode: null,
    fields: [],
  };
  const kinds: ApiFailure['kind'][] = [
    'unauthenticated',
    'invalid_credentials',
    'forbidden',
    'validation',
    'not_found',
    'conflict',
    'rate_limited',
    'server',
    'network',
    'invalid_response',
    'unknown',
  ];

  it.each(kinds)('%s', (kind) => {
    const m = describeFailure({ ...base, kind, supportCode: 'req-1234abcd' }, 'load');
    expect(m.message.length).toBeGreaterThan(10);
    expect(m.message).not.toMatch(/\{|\}|stack|undefined|null|NaN/);
    expect(m.support).toBe('Support code: req-1234abcd');
  });

  it('the support line is absent when there is no request id (control)', () => {
    expect(describeFailure({ ...base, kind: 'server' }).support).toBeNull();
  });

  it('login: wrong credentials, expired session and rate limit each say the right thing', () => {
    expect(describeFailure({ ...base, kind: 'invalid_credentials' }, 'login').message).toBe(
      'Wrong email or password.',
    );
    expect(describeFailure({ ...base, kind: 'unauthenticated' }, 'load').message).toContain(
      'session has expired',
    );
    expect(
      describeFailure({ ...base, kind: 'rate_limited', retryAfterSeconds: 120 }, 'login').message,
    ).toBe('Too many attempts. Please wait 2 minutes and try again.');
    expect(describeFailure({ ...base, kind: 'rate_limited' }, 'login').message).toContain(
      'a few minutes',
    );
  });

  it('registration: an email already used is said plainly; other conflicts are generic', () => {
    expect(
      describeFailure({ ...base, kind: 'conflict', code: 'EMAIL_TAKEN' }, 'register').message,
    ).toContain('already exists');
    expect(
      describeFailure({ ...base, kind: 'conflict', code: 'OTHER' }, 'register').message,
    ).not.toContain('email');
  });

  it.each([
    [1, '1 second'],
    [45, '45 seconds'],
    [89, '89 seconds'],
    [90, '2 minutes'],
    [900, '15 minutes'],
    [5340, '89 minutes'],
    [5400, '2 hours'],
    [7200, '2 hours'],
    [3600 * 10, '10 hours'],
  ])('humanDuration(%s) = %s', (s, out) => {
    expect(humanDuration(s)).toBe(out);
  });
});
