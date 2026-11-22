import { describe, expect, it } from 'vitest';
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_ORDERS_POLL_MS,
  DEFAULT_POLL_MS,
  DEFAULT_QUOTE_POLL_MS,
  WebConfigError,
  loadWebConfig,
} from './config';

function fail(env: Record<string, string | undefined>): WebConfigError {
  try {
    loadWebConfig(env);
  } catch (e) {
    if (e instanceof WebConfigError) return e;
    throw e;
  }
  throw new Error('expected loadWebConfig to throw');
}

describe('loadWebConfig', () => {
  it('local defaults: the local API and a 15 second poll (control)', () => {
    expect(loadWebConfig({})).toEqual({
      appEnv: 'local',
      apiBaseUrl: DEFAULT_API_BASE_URL,
      portfolioPollMs: DEFAULT_POLL_MS,
      quotePollMs: DEFAULT_QUOTE_POLL_MS,
      ordersPollMs: DEFAULT_ORDERS_POLL_MS,
      demoAccounts: false,
      trustForwardedFor: true,
    });
    expect(DEFAULT_POLL_MS).toBe(15_000);
    expect(DEFAULT_ORDERS_POLL_MS).toBe(10_000); // M9b: was a fixed 3 s
  });

  it('reads explicit values', () => {
    expect(
      loadWebConfig({
        APP_ENV: 'test',
        API_BASE_URL: 'http://localhost:4100',
        PORTFOLIO_POLL_MS: '2000',
        QUOTE_POLL_MS: '1500',
        ORDERS_POLL_MS: '3000',
      }),
    ).toEqual({
      appEnv: 'test',
      apiBaseUrl: 'http://localhost:4100',
      portfolioPollMs: 2000,
      quotePollMs: 1500,
      ordersPollMs: 3000,
      demoAccounts: false,
      trustForwardedFor: true,
    });
  });

  it('ORDERS_POLL_MS is a bounded whole number of milliseconds (controls: the bounds load)', () => {
    expect(loadWebConfig({ ORDERS_POLL_MS: '1000' }).ordersPollMs).toBe(1000);
    expect(loadWebConfig({ ORDERS_POLL_MS: '300000' }).ordersPollMs).toBe(300_000);
    for (const v of ['999', '300001', 'often', '10.5', '']) {
      expect(fail({ ORDERS_POLL_MS: v }).issues.map((i) => i.name)).toContain('ORDERS_POLL_MS');
    }
  });

  it('DEMO_ACCOUNTS is off unless it is exactly "on" (M10, D-113; controls: on loads, junk is refused)', () => {
    expect(loadWebConfig({}).demoAccounts).toBe(false);
    expect(loadWebConfig({ DEMO_ACCOUNTS: 'off' }).demoAccounts).toBe(false);
    expect(loadWebConfig({ DEMO_ACCOUNTS: 'on' }).demoAccounts).toBe(true);
    for (const v of ['true', 'ON', '1', '']) {
      expect(fail({ DEMO_ACCOUNTS: v }).issues.map((i) => i.name)).toContain('DEMO_ACCOUNTS');
    }
  });

  it('staging and production must name the API explicitly (control: with it they load)', () => {
    for (const appEnv of ['staging', 'production']) {
      expect(fail({ APP_ENV: appEnv }).issues).toContainEqual({
        name: 'API_BASE_URL',
        rule: expect.stringContaining('required'),
      });
      expect(
        loadWebConfig({
          APP_ENV: appEnv,
          API_BASE_URL: 'https://api.example.test',
          TRUST_FORWARDED_FOR: 'false',
        }).apiBaseUrl,
      ).toBe('https://api.example.test');
    }
  });

  it.each([
    ['API_BASE_URL', 'not a url'],
    ['API_BASE_URL', 'ftp://example.test'],
    ['API_BASE_URL', 'http://localhost:4000/'],
    ['API_BASE_URL', 'http://localhost:4000/v1'],
    ['PORTFOLIO_POLL_MS', '999'],
    ['PORTFOLIO_POLL_MS', '300001'],
    ['PORTFOLIO_POLL_MS', 'fast'],
    ['QUOTE_POLL_MS', '999'],
    ['QUOTE_POLL_MS', '60001'],
    ['QUOTE_POLL_MS', 'soon'],
    ['PORTFOLIO_POLL_MS', '1.5'],
    ['APP_ENV', 'nope-xyz'],
  ])('rejects %s=%s by name and rule, and never echoes the value', (name, value) => {
    const e = fail({ [name]: value });
    expect(e.issues.map((i) => i.name)).toContain(name);
    expect(e.message).not.toContain(value);
  });

  it('reports every problem at once', () => {
    const e = fail({ APP_ENV: 'nope', API_BASE_URL: 'x', PORTFOLIO_POLL_MS: 'y' });
    expect(e.issues.map((i) => i.name).sort()).toEqual([
      'API_BASE_URL',
      'APP_ENV',
      'PORTFOLIO_POLL_MS',
    ]);
  });
});

describe('TRUST_FORWARDED_FOR (D-69)', () => {
  it('defaults to true in local and test (development, no proxy), and can be switched off', () => {
    expect(loadWebConfig({}).trustForwardedFor).toBe(true);
    expect(loadWebConfig({ APP_ENV: 'test' }).trustForwardedFor).toBe(true);
    expect(loadWebConfig({ TRUST_FORWARDED_FOR: 'false' }).trustForwardedFor).toBe(false);
  });

  it('staging and production must state it (control: stated values load)', () => {
    for (const appEnv of ['staging', 'production']) {
      const base = { APP_ENV: appEnv, API_BASE_URL: 'https://api.example.test' };
      expect(fail(base).issues).toContainEqual({
        name: 'TRUST_FORWARDED_FOR',
        rule: expect.stringContaining('required'),
      });
      expect(loadWebConfig({ ...base, TRUST_FORWARDED_FOR: 'true' }).trustForwardedFor).toBe(true);
      expect(loadWebConfig({ ...base, TRUST_FORWARDED_FOR: 'false' }).trustForwardedFor).toBe(
        false,
      );
    }
  });

  it.each(['yes', '1', 'TRUE', ''])('rejects %j by name without echoing it', (v) => {
    const e = fail({ TRUST_FORWARDED_FOR: v });
    expect(e.issues.map((i) => i.name)).toContain('TRUST_FORWARDED_FOR');
  });
});
