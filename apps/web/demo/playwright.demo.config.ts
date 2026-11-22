// `pnpm demo:record` (M10 T6): records scripted walkthroughs of a RUNNING VANTAGE as .webm videos. It is not part of the normal e2e run
// (its own config and its own project names) and it starts nothing: point it at a stack that is already up.
//
//   DEMO_BASE_URL   default http://localhost:3000 (the compose stack, or `pnpm --filter web dev` with the API running)
//   DEMO_PACE_MS    default 1200: the pause between steps, so a viewer can follow
//
// The stack must serve the simulated market with the demo button on (DEMO_ACCOUNTS=on) and an open session for the crypto pair, as the
// compose example does. Videos go to the git-ignored folder demo-videos/ at the repository root; only this script is committed.
import { defineConfig } from '@playwright/test';

const baseURL = process.env.DEMO_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: '.',
  testMatch: /record\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: '../../../demo-videos',
  use: { baseURL, trace: 'off', screenshot: 'off' },
  projects: [
    {
      name: 'demo-desktop',
      use: {
        viewport: { width: 1440, height: 900 },
        video: { mode: 'on', size: { width: 1440, height: 900 } },
      },
    },
    {
      name: 'demo-phone',
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        video: { mode: 'on', size: { width: 390, height: 844 } },
      },
    },
  ],
});
