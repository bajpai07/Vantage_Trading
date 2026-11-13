import type { Env } from './index.js';

/**
 * A valid application environment for tests. An `undefined` override removes the key.
 * The URL carries no password on purpose: no credential literals live in git.
 */
export function buildTestEnv(overrides: Record<string, string | undefined> = {}): Env {
  const base: Record<string, string | undefined> = {
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgres://vantage_app@127.0.0.1:5432/vantage_test',
    MARKET_DATA_SOURCE: 'FIXTURE',
    WEB_ORIGIN: 'http://localhost:3000',
    COOKIE_SECURE: 'false',
    // staging and production must state it; none trusts no proxy (a test overrides it to trust one)
    TRUSTED_PROXY_CIDRS: 'none',
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
