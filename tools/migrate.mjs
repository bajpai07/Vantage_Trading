// The ONE wrapper around node-pg-migrate. Allows only `up` and `status`.
// The database URL is read from DATABASE_MIGRATOR_URL in the environment (run with
// `node --env-file=.env.infra`). It is never put on a command line.
// VANTAGE_MIGRATIONS_DIR (optional) overrides the directory; it exists for experiments and tests only.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = resolve(root, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const URL_VAR = 'DATABASE_MIGRATOR_URL';
const TABLE = 'pgmigrations';
// Skip dotfiles and Markdown (a README in the folder). Anything else must be NNNN_name.sql.
const IGNORE = '(^\\..*)|(\\.md$)';

function usage(msg) {
  process.stderr.write(
    `migrate: ${msg}\nusage: node --env-file=.env.infra tools/migrate.mjs <up|status>\n`,
  );
  process.exit(2);
}

const [command, ...extra] = process.argv.slice(2);
if (extra.length > 0 || (command !== 'up' && command !== 'status')) {
  usage('only `up` and `status` are allowed, with no extra arguments');
}
const url = process.env[URL_VAR];
if (url === undefined || url === '') usage(`${URL_VAR} is not set (is .env.infra loaded?)`);
const dir = resolve(root, process.env.VANTAGE_MIGRATIONS_DIR ?? 'db/migrations');

async function status() {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let applied = new Map();
  try {
    const r = await client.query(`SELECT name, run_on FROM ${TABLE} ORDER BY id`);
    applied = new Map(r.rows.map((row) => [row.name, row.run_on]));
  } catch (e) {
    if (e?.code !== '42P01') throw e; // undefined_table: nothing applied yet
  } finally {
    await client.end();
  }
  const names = new Set([...files.map((f) => f.replace(/\.sql$/, '')), ...applied.keys()]);
  for (const name of [...names].sort()) {
    const when = applied.get(name);
    process.stdout.write(
      `${when ? 'applied' : 'pending'}  ${name}${when ? `  ${when.toISOString()}` : ''}\n`,
    );
  }
  if (names.size === 0) process.stdout.write('no migrations\n');
}

function up() {
  const args = [
    bin,
    'up',
    '--migrations-dir',
    dir,
    '--migrations-table',
    TABLE,
    '--database-url-var',
    URL_VAR,
    '--no-single-transaction',
    '--advisory-lock-mode',
    'wait',
    '--check-order',
    '--ignore-pattern',
    IGNORE,
  ];
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (command === 'up') up();
else {
  status().catch((e) => {
    process.stderr.write(`migrate: status failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
