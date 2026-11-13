// End-to-end tests: a real browser (Chromium) against the real built web app, the real API and a real Postgres
// database, with FIXTURE quotes and the API's injected clock (see apps/api/src/testing/e2e-server.ts). Not part of
// `pnpm verify` or CI yet: run it with `pnpm --filter web test:e2e` (see docs/web.md, including `playwright install`).
import { defineConfig, devices } from '@playwright/test';

export const WEB_PORT = 3100;
export const API_PORT = 4100;
export const CONTROL_PORT = 4101;
export const POLL_MS = 2000;

export default defineConfig({
  testDir: './e2e',
  // one worker: the tests share one API process, one database and one injected clock
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${String(WEB_PORT)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // The production build, served as in production. API_BASE_URL is read at request time (the proxy route).
  webServer: {
    command: `pnpm exec next start -p ${String(WEB_PORT)}`,
    url: `http://localhost:${String(WEB_PORT)}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      API_BASE_URL: `http://127.0.0.1:${String(API_PORT)}`,
      APP_ENV: 'test',
      PORTFOLIO_POLL_MS: String(POLL_MS),
      QUOTE_POLL_MS: '1000',
      TRUST_FORWARDED_FOR: 'true',
    },
  },
});
