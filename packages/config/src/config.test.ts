import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactUrl } from './index.js';
import { buildTestEnv } from './testing.js';

function fail(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('accepts a valid test env (control)', () => {
    const c = loadConfig(buildTestEnv());
    expect(c.appEnv).toBe('test');
    expect(c.marketDataSource).toBe('FIXTURE');
  });

  it('is pure: ignores process.env', () => {
    process.env.APP_ENV = 'production';
    try {
      expect(loadConfig(buildTestEnv()).appEnv).toBe('test');
    } finally {
      delete process.env.APP_ENV;
    }
  });

  it('guard 1: FIXTURE refused in staging and production, allowed elsewhere (control)', () => {
    for (const appEnv of ['staging', 'production']) {
      const e = fail(buildTestEnv({ APP_ENV: appEnv, MARKET_DATA_SOURCE: 'FIXTURE' }));
      expect(e.issues).toContainEqual(expect.objectContaining({ name: 'MARKET_DATA_SOURCE' }));
    }
    const prod = buildTestEnv({ APP_ENV: 'production', MARKET_DATA_SOURCE: 'PROVIDER' });
    expect(loadConfig(prod).marketDataSource).toBe('PROVIDER');
    expect(loadConfig(buildTestEnv({ APP_ENV: 'local' })).appEnv).toBe('local');
  });

  it('guard 2: one aggregated error lists every bad variable by name and rule, no values', () => {
    const e = fail({
      APP_ENV: 'bogus-value-xyz',
      LOG_LEVEL: 'loud-value-xyz',
      DATABASE_URL: 'not-a-url-xyz',
    });
    const names = e.issues.map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining(['APP_ENV', 'LOG_LEVEL', 'DATABASE_URL', 'MARKET_DATA_SOURCE']),
    );
    expect(e.message).not.toMatch(/bogus-value-xyz|loud-value-xyz|not-a-url-xyz/);
  });

  it('guard 2: a known password never appears in any error', () => {
    const pw = randomBytes(12).toString('hex');
    const cases = [
      buildTestEnv({ DATABASE_URL: `postgres://postgres:${pw}@127.0.0.1:5432/x` }),
      buildTestEnv({ DATABASE_URL: `mysql://vantage_app:${pw}@127.0.0.1/x` }),
      buildTestEnv({
        DATABASE_URL: `postgres://vantage_migrator:${pw}@127.0.0.1/x`,
        VANTAGE_APP_PASSWORD: pw,
        POSTGRES_SUPERUSER_PASSWORD: pw,
        DATABASE_MIGRATOR_URL: `postgres://m:${pw}@h/d`,
      }),
    ];
    for (const env of cases) {
      const e = fail(env);
      expect(JSON.stringify(e.issues)).not.toContain(pw);
      expect(e.message).not.toContain(pw);
      expect(String(e.stack)).not.toContain(pw);
    }
  });

  it('guard 3: migration credentials are rejected in an app env', () => {
    const names = [
      'DATABASE_MIGRATOR_URL',
      'POSTGRES_SUPERUSER_PASSWORD',
      'VANTAGE_APP_PASSWORD',
      'VANTAGE_MIGRATOR_PASSWORD',
    ];
    for (const k of names) {
      const e = fail(buildTestEnv({ [k]: 'x' }));
      expect(e.issues).toContainEqual({ name: k, rule: expect.any(String) });
    }
  });

  it('guard 3: DATABASE_URL user must not be postgres or vantage_migrator', () => {
    for (const u of ['postgres', 'vantage_migrator']) {
      const e = fail(buildTestEnv({ DATABASE_URL: `postgres://${u}@127.0.0.1:5432/x` }));
      expect(e.issues).toContainEqual(expect.objectContaining({ name: 'DATABASE_URL' }));
    }
    const ok = loadConfig(
      buildTestEnv({ DATABASE_URL: 'postgres://vantage_app@127.0.0.1:5432/x' }),
    );
    expect(ok.databaseUrl).toContain('vantage_app');
  });
});

describe('redactUrl', () => {
  it('hides the password', () => {
    expect(redactUrl('postgres://u:hunter2@h:1/d')).not.toContain('hunter2');
    expect(redactUrl('postgres://u@h:1/d')).toContain('u@h');
  });
});
