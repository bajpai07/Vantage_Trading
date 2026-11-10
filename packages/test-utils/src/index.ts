import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';

// Works from both src/ and dist/: the repo root is three levels above this file's folder.
const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const DB_PREFIX = 't_';
const TEST_DB_RE = /^t_[0-9a-f]{12}$/;

interface InfraEnv {
  host: string;
  port: number;
  superPassword: string;
  migratorPassword: string;
  appPassword: string;
}

/** Reads .env.infra into an object. It never touches process.env. */
export function readInfraEnv(): InfraEnv {
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(readFileSync(resolve(repoRoot, '.env.infra'), 'utf8'));
  } catch {
    throw new Error('Cannot read .env.infra. Run `pnpm setup:env` and `pnpm db:up` first.');
  }
  const need = (k: string): string => {
    const v = parsed[k];
    if (v === undefined || v === '') throw new Error(`${k} is missing from .env.infra`);
    return v;
  };
  return {
    host: '127.0.0.1',
    port: Number(need('POSTGRES_HOST_PORT')),
    superPassword: need('POSTGRES_SUPERUSER_PASSWORD'),
    migratorPassword: need('VANTAGE_MIGRATOR_PASSWORD'),
    appPassword: need('VANTAGE_APP_PASSWORD'),
  };
}

function connUrl(env: InfraEnv, user: string, password: string, db: string): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${env.host}:${String(env.port)}/${db}`;
}

async function withSuperuser<T>(
  env: InfraEnv,
  db: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new pg.Client({ connectionString: connUrl(env, 'postgres', env.superPassword, db) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/** Same database-level hardening as infra/postgres/01-bootstrap.sh. */
const HARDENING_SQL = [
  'REVOKE ALL ON DATABASE {db} FROM PUBLIC',
  'GRANT CONNECT ON DATABASE {db} TO vantage_app',
  'REVOKE ALL ON SCHEMA public FROM PUBLIC',
  'GRANT USAGE ON SCHEMA public TO vantage_app',
  'ALTER DEFAULT PRIVILEGES FOR ROLE vantage_migrator REVOKE ALL ON TABLES FROM PUBLIC',
  'ALTER DEFAULT PRIVILEGES FOR ROLE vantage_migrator REVOKE ALL ON SEQUENCES FROM PUBLIC',
];

function runMigrations(migratorUrl: string): Promise<void> {
  return new Promise((done, fail) => {
    let out = '';
    const child = spawn(process.execPath, [resolve(repoRoot, 'tools/migrate.mjs'), 'up'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_MIGRATOR_URL: migratorUrl },
    });
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', fail);
    child.on('exit', (code) => {
      if (code === 0) done();
      else fail(new Error(`migration wrapper exited with ${String(code)}:\n${out.slice(-2000)}`));
    });
  });
}

export interface TestDatabase {
  readonly name: string;
  readonly appUrl: string;
  readonly migratorUrl: string;
  readonly app: pg.Pool;
  readonly migrator: pg.Pool;
  /** Ends the pools (with a timeout) and drops the database. Safe to call more than once. */
  dispose(): Promise<void>;
}

async function dropDatabase(env: InfraEnv, name: string): Promise<void> {
  if (!TEST_DB_RE.test(name))
    throw new Error('refusing to drop a database that is not a test database');
  await withSuperuser(env, 'postgres', (c) =>
    c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  );
}

async function endWithTimeout(pool: pg.Pool, ms: number): Promise<void> {
  await Promise.race([
    pool.end().catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, ms)),
  ]);
}

/** Creates an empty, hardened, migrated database `t_<random>`. Never touches vantage_dev. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const env = readInfraEnv();
  const name = `${DB_PREFIX}${randomBytes(6).toString('hex')}`;
  const migratorUrl = connUrl(env, 'vantage_migrator', env.migratorPassword, name);
  const appUrl = connUrl(env, 'vantage_app', env.appPassword, name);

  await withSuperuser(env, 'postgres', (c) =>
    c.query(`CREATE DATABASE ${name} OWNER vantage_migrator`),
  );
  const pools: pg.Pool[] = [];
  try {
    await withSuperuser(env, name, async (c) => {
      for (const s of HARDENING_SQL) await c.query(s.replaceAll('{db}', name));
    });
    await runMigrations(migratorUrl);
    const mk = (url: string): pg.Pool => {
      const p = new pg.Pool({ connectionString: url, max: 4 });
      p.on('error', () => undefined); // a forced drop kills idle clients; that is expected
      pools.push(p);
      return p;
    };
    const migrator = mk(migratorUrl);
    const app = mk(appUrl);
    let disposed: Promise<void> | undefined;
    return {
      name,
      appUrl,
      migratorUrl,
      app,
      migrator,
      dispose: () => {
        disposed ??= (async () => {
          await Promise.all(pools.map((p) => endWithTimeout(p, 5000)));
          await dropDatabase(env, name);
        })();
        return disposed;
      },
    };
  } catch (e) {
    await Promise.all(pools.map((p) => endWithTimeout(p, 1000)));
    await dropDatabase(env, name).catch(() => undefined);
    throw e;
  }
}

/** Superuser access for assertions about the cluster (e.g. "is the database gone?"). */
export async function queryAsSuperuser<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const env = readInfraEnv();
  return withSuperuser(env, 'postgres', async (c) => (await c.query<T>(sql, params)).rows);
}

/** Drops every leftover test database (`t_` + 12 hex chars). Returns the names dropped. */
export async function dropStaleTestDatabases(): Promise<string[]> {
  const env = readInfraEnv();
  const rows = await queryAsSuperuser<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname ~ '^t_[0-9a-f]{12}$' ORDER BY 1`,
  );
  for (const r of rows) await dropDatabase(env, r.datname);
  return rows.map((r) => r.datname);
}

/** Builds a URL for `vantage_app` with an explicit password (used to prove a wrong one fails). */
export function appUrlWithPassword(db: TestDatabase, password: string): string {
  const u = new URL(db.appUrl);
  u.password = password;
  return u.toString();
}
