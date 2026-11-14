// Runs the e2e suite as its two profiles, one after the other (each has its own API, database and ports):
//   default      the NYSE session (everything except always-open.spec.ts), ports 3100 / 4100 / 4101
//   always-open  SIM_SESSION=ALWAYS_OPEN (always-open.spec.ts only), ports 3200 / 4200 / 4201
// Exit code: non-zero if either profile fails. Extra arguments are passed to the default profile only.
import { spawnSync } from 'node:child_process';

const run = (profile, args) =>
  spawnSync('pnpm', ['exec', 'playwright', 'test', ...args], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, E2E_PROFILE: profile },
  }).status ?? 1;

const first = run('default', process.argv.slice(2));
const second = run('always-open', []);
process.exit(first !== 0 ? first : second);
