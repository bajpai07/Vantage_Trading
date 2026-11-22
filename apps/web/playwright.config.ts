// End-to-end tests: a real browser (Chromium) against the real built web app, the real API and a real Postgres
// database, with FIXTURE quotes and the API's injected clock (see apps/api/src/testing/e2e-server.ts). Not part of
// `pnpm verify` or CI yet: run it with `pnpm --filter web test:e2e` (see docs/web.md, including `playwright install`).
import { defineConfig, devices } from '@playwright/test';

// M7b: a second profile (E2E_PROFILE=always-open) runs a separate API with SIM_SESSION=ALWAYS_OPEN on its own ports
// (see e2e/run-all.mjs); the default profile is the NYSE session.
export const PROFILE = process.env.E2E_PROFILE ?? 'default';
const ALT = PROFILE === 'always-open';
export const WEB_PORT = ALT ? 3200 : 3100;
export const API_PORT = ALT ? 4200 : 4100;
export const CONTROL_PORT = ALT ? 4201 : 4101;
export const SIM_SESSION = ALT ? 'ALWAYS_OPEN' : 'NYSE';
export const POLL_MS = 2000;

export default defineConfig({
  testDir: './e2e',
  // the always-open profile runs only its own spec; the default profile never runs it
  ...(ALT ? { testMatch: /always-open\.spec\.ts/ } : { testIgnore: /always-open\.spec\.ts/ }),
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
  // M9b: the desktop project never runs the phone spec; the phone project (touch emulation, several viewports set inside the spec)
  // runs only it, and only in the default profile
  projects: [
    {
      name: 'chromium',
      // a project-level testIgnore replaces the top-level one, so always-open is repeated here
      testIgnore: ALT ? /phone.spec.ts/ : [/phone.spec.ts/, /always-open.spec.ts/],
      use: { ...devices['Desktop Chrome'] },
    },
    ...(ALT
      ? []
      : [
          {
            name: 'phone',
            testMatch: /phone.spec.ts/,
            use: { ...devices['Pixel 7'] },
          },
        ]),
  ],
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
      // the default profile shows the "Try the demo" button, the always-open profile does not (M10, D-113)
      DEMO_ACCOUNTS: ALT ? 'off' : 'on',
      ORDERS_POLL_MS: '3000', // production default 10 s; tests look for matcher fills quickly
      TRUST_FORWARDED_FOR: 'true',
    },
  },
});
