// Creates .env (application) and .env.infra (infrastructure/migration) from the .example files.
// Refuses to overwrite. Never prints secrets. Usage: pnpm setup:env [--port <n>]
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const read = (f: string): string => readFileSync(resolve(root, f), 'utf8');

function fail(msg: string): never {
  process.stderr.write(`setup:env: ${msg}\n`);
  process.exit(1);
}

function portFromArgs(argv: string[]): string | undefined {
  const i = argv.indexOf('--port');
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined) fail('--port needs a value');
  return v;
}

function isFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => done(true)));
  });
}

function fill(template: string, values: Record<string, string>): string {
  return template
    .split('\n')
    .map((line) => {
      const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
      const key = m?.[1];
      return key !== undefined && key in values ? `${key}=${values[key]}` : line;
    })
    .join('\n');
}

async function main(): Promise<void> {
  const targets = ['.env', '.env.infra'];
  const existing = targets.filter((f) => existsSync(resolve(root, f)));
  if (existing.length > 0) {
    fail(
      `refusing to overwrite existing file(s): ${existing.join(', ')}. Delete them yourself if you really want new secrets.`,
    );
  }

  const infraExample = read('.env.infra.example');
  const defaultPort = parseEnv(infraExample).POSTGRES_HOST_PORT ?? '';
  const raw = portFromArgs(process.argv.slice(2)) ?? process.env.POSTGRES_HOST_PORT ?? defaultPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail('POSTGRES_HOST_PORT must be an integer between 1024 and 65535');
  }
  if (!(await isFree(port))) {
    fail(
      `port ${String(port)} on 127.0.0.1 is already in use. Nothing was written. Choose another with: pnpm setup:env --port <free port>`,
    );
  }

  const secret = (): string => randomBytes(24).toString('base64url');
  const migratorPw = secret();
  const appPw = secret();
  const url = (user: string, pw: string): string =>
    `postgres://${user}:${pw}@127.0.0.1:${String(port)}/vantage_dev`;

  const infra = fill(infraExample, {
    POSTGRES_HOST_PORT: String(port),
    POSTGRES_SUPERUSER_PASSWORD: secret(),
    VANTAGE_MIGRATOR_PASSWORD: migratorPw,
    VANTAGE_APP_PASSWORD: appPw,
    DATABASE_MIGRATOR_URL: url('vantage_migrator', migratorPw),
  });
  const app = fill(read('.env.example'), { DATABASE_URL: url('vantage_app', appPw) });

  // flag 'wx' = fail if the file appeared meanwhile. Mode 0600 is only effective on POSIX file systems.
  writeFileSync(resolve(root, '.env.infra'), infra, { flag: 'wx', mode: 0o600 });
  writeFileSync(resolve(root, '.env'), app, { flag: 'wx', mode: 0o600 });
  process.stdout.write(
    `setup:env: created .env and .env.infra (Postgres host port ${String(port)}, secrets not shown).\n`,
  );
  if (process.platform === 'win32') {
    process.stdout.write('setup:env: note: file mode 0600 cannot be enforced on Windows.\n');
  }
}

await main();
