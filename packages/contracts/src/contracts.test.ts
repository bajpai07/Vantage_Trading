import { describe, expect, it } from 'vitest';
import {
  AccountResponse,
  COUNTRY_CODES,
  ErrorEnvelope,
  LoginRequest,
  MeResponse,
  RegisterRequest,
  normalizeEmail,
} from './index.js';

const valid = {
  email: '  Ada@Example.com ',
  password: 'correct horse battery',
  displayName: ' Ada ',
  countryCode: 'in',
  confirmAdult: true,
  acceptTerms: true,
};

describe('RegisterRequest', () => {
  it('accepts a valid request, trims, and upper-cases the country (control)', () => {
    const r = RegisterRequest.parse(valid);
    expect(r.email).toBe('Ada@Example.com'); // stored as given, trimmed
    expect(r.displayName).toBe('Ada');
    expect(r.countryCode).toBe('IN');
  });

  it.each([
    ['confirmAdult false', { confirmAdult: false }],
    ['confirmAdult missing', { confirmAdult: undefined }],
    ['acceptTerms false', { acceptTerms: false }],
    ['bad country', { countryCode: 'XX' }],
    ['country UK (not an ISO code)', { countryCode: 'UK' }],
    ['password too short (9)', { password: '123456789' }],
    ['password too long (129)', { password: 'x'.repeat(129) }],
    ['password equals email', { email: 'someone@example.com', password: 'someone@example.com' }],
    [
      'password equals email ignoring case',
      { email: 'Someone@Example.com', password: 'someone@example.com' },
    ],
    ['display name too short', { displayName: 'A' }],
    ['display name too long', { displayName: 'x'.repeat(41) }],
    ['display name only spaces', { displayName: '    ' }],
    ['not an email', { email: 'nope' }],
    ['unknown field', { admin: true }],
  ])('rejects %s', (_name, patch) => {
    expect(RegisterRequest.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('accepts the length boundaries (control)', () => {
    expect(RegisterRequest.safeParse({ ...valid, password: 'x'.repeat(10) }).success).toBe(true);
    expect(RegisterRequest.safeParse({ ...valid, password: 'x'.repeat(128) }).success).toBe(true);
    expect(RegisterRequest.safeParse({ ...valid, displayName: 'Ab' }).success).toBe(true);
    expect(RegisterRequest.safeParse({ ...valid, displayName: 'x'.repeat(40) }).success).toBe(true);
  });

  it('never echoes the password in an error', () => {
    const r = RegisterRequest.safeParse({ ...valid, password: 'secret1' }); // too short, so it fails
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain('secret1');
  });
});

describe('other contracts', () => {
  it('LoginRequest needs an email and a password', () => {
    expect(LoginRequest.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(LoginRequest.safeParse({ email: '', password: 'x' }).success).toBe(false);
    expect(LoginRequest.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });

  it('AccountResponse money fields are canonical strings, never numbers', () => {
    const ok = {
      currency: 'USD',
      cash: '10000.00',
      equity: '10000.00',
      initialCapital: '10000.00',
      asOf: '2026-11-11T10:00:00.000Z',
    };
    expect(AccountResponse.safeParse(ok).success).toBe(true);
    expect(AccountResponse.safeParse({ ...ok, cash: 10000 }).success).toBe(false);
    expect(AccountResponse.safeParse({ ...ok, cash: '10000' }).success).toBe(false);
    expect(AccountResponse.safeParse({ ...ok, cash: '1e4' }).success).toBe(false);
    expect(AccountResponse.safeParse({ ...ok, currency: 'INR' }).success).toBe(false);
  });

  it('MeResponse and ErrorEnvelope shapes', () => {
    expect(
      MeResponse.safeParse({
        id: '0192f0f0-0000-7000-8000-000000000000',
        email: 'a@b.co',
        displayName: 'Ada',
        countryCode: 'IN',
        role: 'USER',
        status: 'ACTIVE',
      }).success,
    ).toBe(true);
    expect(
      ErrorEnvelope.safeParse({ error: { code: 'X', message: 'm', requestId: 'r' } }).success,
    ).toBe(true);
    expect(ErrorEnvelope.safeParse({ error: { code: 'X' } }).success).toBe(false);
  });

  it('normalizeEmail trims and lower-cases', () => {
    expect(normalizeEmail('  A@B.Co ')).toBe('a@b.co');
  });

  it('the bundled country list has 249 unique upper-case codes', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    expect(COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
    for (const c of ['US', 'IN', 'GB', 'DE', 'JP', 'AU']) expect(COUNTRY_CODES).toContain(c);
  });
});
