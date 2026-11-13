import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX, PASSWORD_MIN } from '@vantage/contracts';
import { FIELD_MESSAGES, checkLogin, checkRegister, errorsForFields } from './auth-forms';

const valid = {
  email: 'ada@example.com',
  password: 'correct horse battery',
  displayName: 'Ada',
  countryCode: 'in',
  confirmAdult: true,
  acceptTerms: true,
};

describe('login form checks', () => {
  it('accepts an email and a password (control)', () => {
    expect(checkLogin({ email: ' ada@example.com ', password: 'x' })).toMatchObject({
      ok: true,
      data: { email: 'ada@example.com', password: 'x' },
    });
  });

  it('asks for what is missing in plain words', () => {
    const r = checkLogin({ email: '', password: '' });
    expect(r).toEqual({
      ok: false,
      errors: { email: 'Enter your email address.', password: 'Enter your password.' },
    });
  });
});

describe('registration form checks (the M2 rules, from the contract)', () => {
  it('accepts a valid form, trims, and upper-cases the country (control)', () => {
    const r = checkRegister(valid);
    expect(r).toMatchObject({ ok: true, data: { countryCode: 'IN', displayName: 'Ada' } });
  });

  it.each([
    ['email', { email: 'not-an-email' }],
    ['password', { password: 'short' }],
    ['password', { password: 'x'.repeat(PASSWORD_MAX + 1) }],
    ['password', { password: 'ada@example.com' }], // equal to the email
    ['displayName', { displayName: 'A' }],
    ['displayName', { displayName: 'x'.repeat(41) }],
    ['countryCode', { countryCode: '' }],
    ['countryCode', { countryCode: 'ZZ' }],
    ['confirmAdult', { confirmAdult: false }],
    ['acceptTerms', { acceptTerms: false }],
  ])('rejects a bad %s with its own sentence', (field, over) => {
    const r = checkRegister({ ...valid, ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[field]).toBe(FIELD_MESSAGES[field]);
  });

  it('the password sentence states the real limits', () => {
    expect(FIELD_MESSAGES.password).toContain(String(PASSWORD_MIN));
    expect(FIELD_MESSAGES.password).toContain(String(PASSWORD_MAX));
  });

  it('reports several problems at once, one sentence per field', () => {
    const r = checkRegister({ ...valid, email: 'x', displayName: '', confirmAdult: false });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(Object.keys(r.errors).sort()).toEqual(['confirmAdult', 'displayName', 'email']);
  });
});

describe('field errors from a server 400', () => {
  it('maps the field names the API reports to our own sentences, and ignores nothing unknown safely', () => {
    expect(errorsForFields(['email', 'displayName'])).toEqual({
      email: FIELD_MESSAGES.email,
      displayName: FIELD_MESSAGES.displayName,
    });
    expect(errorsForFields(['mystery'])).toEqual({ mystery: 'Please check this field.' });
    expect(errorsForFields([])).toEqual({});
  });
});
