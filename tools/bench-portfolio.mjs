// Runs the portfolio read benchmark (apps/api/src/modules/portfolio/portfolio-bench.int.test.ts). Not a CI gate.
// Usage: pnpm bench:portfolio   (needs .env.infra and a running database)
import { spawnSync } from 'node:child_process';

const r = spawnSync(
  process.execPath,
  [
    '--env-file=.env.infra',
    'node_modules/vitest/vitest.mjs',
    'run',
    '--project',
    'integration',
    'apps/api/src/modules/portfolio/portfolio-bench.int.test.ts',
  ],
  { stdio: 'inherit', env: { ...process.env, VANTAGE_BENCH: '1' } },
);
process.exit(r.status ?? 1);
