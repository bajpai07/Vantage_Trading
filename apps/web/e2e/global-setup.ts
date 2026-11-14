// Starts the real API (real Postgres, injected clock, FIXTURE data) for the whole e2e run and waits until it answers.
// Playwright starts the web server first (webServer), then runs this; the API address is fixed in playwright.config.ts.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { API_PORT, CONTROL_PORT, SIM_SESSION, WEB_PORT } from '../playwright.config';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

async function waitFor(url: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export default async function globalSetup(): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--conditions=source', '--import', 'tsx', 'apps/api/src/testing/e2e-server.ts'],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: join(repoRoot, 'apps', 'api', 'tsconfig.json'),
        E2E_API_PORT: String(API_PORT),
        E2E_CONTROL_PORT: String(CONTROL_PORT),
        E2E_SIM_SESSION: SIM_SESSION,
        E2E_WEB_ORIGIN: `http://localhost:${String(WEB_PORT)}`,
      },
    },
  );
  (globalThis as { __e2eApi?: typeof child }).__e2eApi = child;
  await waitFor(`http://127.0.0.1:${String(CONTROL_PORT)}/health`, 120_000);
  await waitFor(`http://127.0.0.1:${String(API_PORT)}/health`, 30_000);
}
