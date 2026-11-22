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
    const prod = buildTestEnv({
      APP_ENV: 'production',
      MARKET_DATA_SOURCE: 'PROVIDER',
      COOKIE_SECURE: 'true',
      TRADING_ENABLED: 'true',
    });
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

describe('M2 application settings', () => {
  it('applies defaults (control): port 3000, idle 480 min, absolute 7 days, secure cookies', () => {
    const c = loadConfig(buildTestEnv({ COOKIE_SECURE: undefined, APP_ENV: 'local' }));
    expect(c.port).toBe(3000);
    expect(c.sessionIdleMinutes).toBe(480);
    expect(c.sessionAbsoluteDays).toBe(7);
    expect(c.cookieSecure).toBe(true);
    expect(c.webOrigin).toBe('http://localhost:3000');
  });

  it('reads explicit values', () => {
    const c = loadConfig(
      buildTestEnv({
        PORT: '8080',
        SESSION_IDLE_MINUTES: '30',
        SESSION_ABSOLUTE_DAYS: '1',
        COOKIE_SECURE: 'false',
      }),
    );
    expect([c.port, c.sessionIdleMinutes, c.sessionAbsoluteDays, c.cookieSecure]).toEqual([
      8080,
      30,
      1,
      false,
    ]);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['WEB_ORIGIN', 'http://localhost:3000/'],
    ['WEB_ORIGIN', 'http://localhost:3000/app'],
    ['WEB_ORIGIN', 'ftp://localhost'],
    ['WEB_ORIGIN', 'not a url'],
    ['SESSION_IDLE_MINUTES', '0'],
    ['SESSION_ABSOLUTE_DAYS', '91'],
    ['COOKIE_SECURE', 'yes'],
  ])('rejects %s=%s by name and rule, without echoing the value', (name, value) => {
    const e = fail(buildTestEnv({ [name]: value }));
    expect(e.issues.map((i) => i.name)).toContain(name);
    expect(e.message).not.toContain(value === '0' ? 'zzz' : value);
  });

  it('WEB_ORIGIN is required', () => {
    expect(fail(buildTestEnv({ WEB_ORIGIN: undefined })).issues.map((i) => i.name)).toContain(
      'WEB_ORIGIN',
    );
  });

  it('COOKIE_SECURE=false is refused in staging and production, allowed in local and test (control)', () => {
    for (const appEnv of ['staging', 'production']) {
      const e = fail(
        buildTestEnv({ APP_ENV: appEnv, MARKET_DATA_SOURCE: 'PROVIDER', COOKIE_SECURE: 'false' }),
      );
      expect(e.issues).toContainEqual(expect.objectContaining({ name: 'COOKIE_SECURE' }));
    }
    for (const appEnv of ['local', 'test']) {
      expect(
        loadConfig(buildTestEnv({ APP_ENV: appEnv, COOKIE_SECURE: 'false' })).cookieSecure,
      ).toBe(false);
    }
    const prod = loadConfig(
      buildTestEnv({
        APP_ENV: 'production',
        MARKET_DATA_SOURCE: 'PROVIDER',
        COOKIE_SECURE: 'true',
        TRADING_ENABLED: 'true',
      }),
    );
    expect(prod.cookieSecure).toBe(true);
  });
});

describe('M4b trading settings', () => {
  it('local and test default to trading enabled and 30 orders per minute (control)', () => {
    for (const appEnv of ['local', 'test']) {
      const c = loadConfig(buildTestEnv({ APP_ENV: appEnv }));
      expect([c.tradingEnabled, c.orderRateLimitPerMinute]).toEqual([true, 30]);
    }
  });
  it('reads explicit values', () => {
    const c = loadConfig(
      buildTestEnv({ TRADING_ENABLED: 'false', ORDER_RATE_LIMIT_PER_MINUTE: '5' }),
    );
    expect([c.tradingEnabled, c.orderRateLimitPerMinute]).toEqual([false, 5]);
  });
  it('TRADING_ENABLED must be explicit in staging and production, and is accepted when set (control)', () => {
    for (const appEnv of ['staging', 'production']) {
      const base = { APP_ENV: appEnv, MARKET_DATA_SOURCE: 'PROVIDER', COOKIE_SECURE: 'true' };
      const e = fail(buildTestEnv(base));
      expect(e.issues.map((i) => i.name)).toContain('TRADING_ENABLED');
      expect(loadConfig(buildTestEnv({ ...base, TRADING_ENABLED: 'false' })).tradingEnabled).toBe(
        false,
      );
      expect(loadConfig(buildTestEnv({ ...base, TRADING_ENABLED: 'true' })).tradingEnabled).toBe(
        true,
      );
    }
  });
  it.each([
    ['TRADING_ENABLED', 'yes'],
    ['TRADING_ENABLED', '1'],
    ['ORDER_RATE_LIMIT_PER_MINUTE', '0'],
    ['ORDER_RATE_LIMIT_PER_MINUTE', '-1'],
    ['ORDER_RATE_LIMIT_PER_MINUTE', '100001'],
    ['ORDER_RATE_LIMIT_PER_MINUTE', 'many'],
  ])('rejects %s=%s by name without echoing the value', (name, value) => {
    const e = fail(buildTestEnv({ [name]: value }));
    expect(e.issues.map((i) => i.name)).toContain(name);
    expect(e.message).not.toContain(value === '0' || value === '1' ? 'zzz' : value);
  });
});

describe('simulated feed settings (M7a: D-74, D-76, D-77)', () => {
  const prod = (over: Record<string, string | undefined>) =>
    buildTestEnv({
      APP_ENV: 'production',
      COOKIE_SECURE: 'true',
      TRADING_ENABLED: 'true',
      ...over,
    });

  it('defaults are safe: no crypto feed, NYSE session, no demo mode, seed and tick set', () => {
    const c = loadConfig(buildTestEnv());
    expect(c).toMatchObject({
      cryptoFeed: 'off',
      simSession: 'NYSE',
      demoMode: false,
      simSeed: 'vantage-demo-1',
      simTickMs: 1000,
    });
  });

  it('SIM with crypto and the 24/7 session is accepted in test (control for the refusals below)', () => {
    const c = loadConfig(
      buildTestEnv({ MARKET_DATA_SOURCE: 'SIM', CRYPTO_FEED: 'sim', SIM_SESSION: 'ALWAYS_OPEN' }),
    );
    expect(c).toMatchObject({
      marketDataSource: 'SIM',
      cryptoFeed: 'sim',
      simSession: 'ALWAYS_OPEN',
    });
  });

  it('ALWAYS_OPEN is refused unless the stock source is SIM (it never applies to FIXTURE or a real provider)', () => {
    for (const source of ['FIXTURE', 'PROVIDER']) {
      const e = fail(buildTestEnv({ MARKET_DATA_SOURCE: source, SIM_SESSION: 'ALWAYS_OPEN' }));
      expect(e.issues.map((i) => i.name)).toContain('SIM_SESSION');
    }
  });

  it('crypto simulation needs the SIM provider', () => {
    const e = fail(buildTestEnv({ MARKET_DATA_SOURCE: 'FIXTURE', CRYPTO_FEED: 'sim' }));
    expect(e.issues.map((i) => i.name)).toContain('CRYPTO_FEED');
  });

  it('staging and production refuse a simulated source without DEMO_MODE=true, and accept it with it', () => {
    for (const appEnv of ['staging', 'production']) {
      const without = fail(
        buildTestEnv({
          APP_ENV: appEnv,
          COOKIE_SECURE: 'true',
          TRADING_ENABLED: 'true',
          MARKET_DATA_SOURCE: 'SIM',
        }),
      );
      expect(without.issues.map((i) => i.name)).toContain('DEMO_MODE');
      const explicitlyFalse = fail(
        buildTestEnv({
          APP_ENV: appEnv,
          COOKIE_SECURE: 'true',
          TRADING_ENABLED: 'true',
          MARKET_DATA_SOURCE: 'SIM',
          DEMO_MODE: 'false',
        }),
      );
      expect(explicitlyFalse.issues.map((i) => i.name)).toContain('DEMO_MODE');
      const ok = loadConfig(
        buildTestEnv({
          APP_ENV: appEnv,
          COOKIE_SECURE: 'true',
          TRADING_ENABLED: 'true',
          MARKET_DATA_SOURCE: 'SIM',
          DEMO_MODE: 'true',
          CRYPTO_FEED: 'sim',
          SIM_SESSION: 'ALWAYS_OPEN',
        }),
      );
      expect(ok.demoMode).toBe(true);
    }
  });

  it('FIXTURE stays refused in production even with DEMO_MODE (D-48 is stricter than D-77)', () => {
    const e = fail(prod({ MARKET_DATA_SOURCE: 'FIXTURE', DEMO_MODE: 'true' }));
    expect(e.issues.map((i) => i.name)).toContain('MARKET_DATA_SOURCE');
  });

  it.each([
    ['CRYPTO_FEED', 'live'],
    ['SIM_SESSION', 'zzz-bad-value'],
    ['DEMO_MODE', 'yes'],
    ['SIM_SEED', 'has space'],
    ['SIM_SEED', ''],
    ['SIM_TICK_MS', '100'],
    ['SIM_TICK_MS', 'fast'],
  ])('%s=%j is refused by name, without echoing the value', (name, value) => {
    const e = fail(buildTestEnv({ MARKET_DATA_SOURCE: 'SIM', [name]: value }));
    expect(e.issues.map((i) => i.name)).toContain(name);
    if (value.length > 3) expect(e.message).not.toContain(value);
  });
});

describe('candle request allowance (M7b)', () => {
  it('CANDLES_RATE_LIMIT_PER_MINUTE defaults to 120 and is a bounded whole number', () => {
    expect(loadConfig(buildTestEnv()).candlesRateLimitPerMinute).toBe(120);
    expect(
      loadConfig(buildTestEnv({ CANDLES_RATE_LIMIT_PER_MINUTE: '20' })).candlesRateLimitPerMinute,
    ).toBe(20);
    for (const v of ['0', '100001', 'many', '1.5', '']) {
      const e = fail(buildTestEnv({ CANDLES_RATE_LIMIT_PER_MINUTE: v }));
      expect(e.issues.map((i) => i.name)).toContain('CANDLES_RATE_LIMIT_PER_MINUTE');
    }
  });
});

describe('limit-order matcher settings (M8b-1)', () => {
  it('MATCHER defaults to off (no timer in tests and tools), accepts on, and rejects anything else', () => {
    expect(loadConfig(buildTestEnv()).matcher).toBe('off');
    expect(loadConfig(buildTestEnv({ MATCHER: 'on' })).matcher).toBe('on');
    for (const v of ['yes', 'ON', 'true', '1', '']) {
      const e = fail(buildTestEnv({ MATCHER: v }));
      expect(e.issues.map((i) => i.name)).toContain('MATCHER');
    }
  });
  it('MATCHER_INTERVAL_MS defaults to 1000 and is 100 to 60000', () => {
    expect(loadConfig(buildTestEnv()).matcherIntervalMs).toBe(1000);
    expect(loadConfig(buildTestEnv({ MATCHER_INTERVAL_MS: '250' })).matcherIntervalMs).toBe(250);
    for (const v of ['99', '60001', 'fast', '1.5', '']) {
      const e = fail(buildTestEnv({ MATCHER_INTERVAL_MS: v }));
      expect(e.issues.map((i) => i.name)).toContain('MATCHER_INTERVAL_MS');
    }
  });
  it('GTC_EXPIRY_DAYS defaults to 90 and is 1 to 365', () => {
    expect(loadConfig(buildTestEnv()).gtcExpiryDays).toBe(90);
    expect(loadConfig(buildTestEnv({ GTC_EXPIRY_DAYS: '30' })).gtcExpiryDays).toBe(30);
    for (const v of ['0', '366', 'long', '1.5', '']) {
      const e = fail(buildTestEnv({ GTC_EXPIRY_DAYS: v }));
      expect(e.issues.map((i) => i.name)).toContain('GTC_EXPIRY_DAYS');
    }
  });
});

describe('depth request allowance (M8b-2)', () => {
  it('DEPTH_RATE_LIMIT_PER_MINUTE defaults to 120 and is a bounded whole number', () => {
    expect(loadConfig(buildTestEnv()).depthRateLimitPerMinute).toBe(120);
    expect(
      loadConfig(buildTestEnv({ DEPTH_RATE_LIMIT_PER_MINUTE: '20' })).depthRateLimitPerMinute,
    ).toBe(20);
    for (const v of ['0', '100001', 'many', '1.5', '']) {
      const e = fail(buildTestEnv({ DEPTH_RATE_LIMIT_PER_MINUTE: v }));
      expect(e.issues.map((i) => i.name)).toContain('DEPTH_RATE_LIMIT_PER_MINUTE');
    }
  });
});

describe('LISTEN_HOST (M10, D-110)', () => {
  it('defaults to 127.0.0.1 and accepts 0.0.0.0 and an IPv6 address (controls)', () => {
    expect(loadConfig(buildTestEnv()).listenHost).toBe('127.0.0.1');
    expect(loadConfig(buildTestEnv({ LISTEN_HOST: '0.0.0.0' })).listenHost).toBe('0.0.0.0');
    expect(loadConfig(buildTestEnv({ LISTEN_HOST: '::1' })).listenHost).toBe('::1');
  });
  it('rejects a host name or garbage', () => {
    for (const v of ['localhost', '999.1.1.1', '', 'http://x']) {
      const e = fail(buildTestEnv({ LISTEN_HOST: v }));
      expect(e.issues.map((i) => i.name)).toContain('LISTEN_HOST');
    }
  });
});
