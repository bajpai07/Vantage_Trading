import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appUrlWithPassword,
  createTestDatabase,
  dropStaleTestDatabases,
  queryAsSuperuser,
} from './index.js';
import type { TestDatabase } from './index.js';

const PG_INSUFFICIENT_PRIVILEGE = '42501';

async function rejectsWith(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ...(err.code === undefined ? {} : { code: err.code }), message: err.message ?? '' };
  }
  throw new Error('expected the promise to reject');
}

const dbExists = async (name: string): Promise<boolean> =>
  (await queryAsSuperuser('SELECT 1 FROM pg_database WHERE datname = $1', [name])).length === 1;

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.dispose();
});

describe('1. fresh migrated, isolated test databases', () => {
  it('has the baseline extensions (control) and a second database is isolated from it', async () => {
    const ext = await db.migrator.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname IN ('citext','pg_trgm') ORDER BY 1`,
    );
    expect(ext.rows.map((r) => r.extname)).toEqual(['citext', 'pg_trgm']);

    const other = await createTestDatabase();
    try {
      await db.migrator.query('CREATE TABLE only_in_first (id int)');
      const here = await db.migrator.query<{ t: string | null }>(
        `SELECT to_regclass('only_in_first')::text AS t`,
      );
      const there = await other.migrator.query<{ t: string | null }>(
        `SELECT to_regclass('only_in_first')::text AS t`,
      );
      expect(here.rows[0]?.t).toBe('only_in_first'); // control
      expect(there.rows[0]?.t).toBeNull(); // must fail to see it
      expect(other.name).not.toBe(db.name);
    } finally {
      await other.dispose();
    }
  });
});

describe('2. vantage_app over TCP', () => {
  it('connects with the right password over TCP (control)', async () => {
    const r = await db.app.query<{ u: string; addr: string | null }>(
      'SELECT current_user AS u, inet_server_addr()::text AS addr',
    );
    expect(r.rows[0]?.u).toBe('vantage_app');
    expect(r.rows[0]?.addr).not.toBeNull(); // not the unix socket (which uses trust)
  });
  it('a wrong password fails', async () => {
    const wrong = new pg.Client({
      connectionString: appUrlWithPassword(db, randomBytes(12).toString('hex')),
    });
    const err = await rejectsWith(wrong.connect());
    expect(err.code).toBe('28P01'); // invalid_password
    await wrong.end().catch(() => undefined);
  });
});

describe('3. vantage_app has no powers', () => {
  const attrs = `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
    (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
    FROM pg_roles r WHERE rolname = $1`;
  it('the superuser shows the attributes this query would reveal (control)', async () => {
    const rows = await queryAsSuperuser<{ rolsuper: boolean }>(attrs, ['postgres']);
    expect(rows[0]?.rolsuper).toBe(true);
  });
  it('vantage_app is not superuser/createdb/createrole/replication/bypassrls and has no memberships', async () => {
    const rows = await queryAsSuperuser(attrs, ['vantage_app']);
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      memberships: 0,
    });
  });
});

describe('4. DDL', () => {
  it('the migrator can CREATE TABLE (control)', async () => {
    await db.migrator.query('CREATE TABLE ddl_ok (id int)');
  });
  it('vantage_app cannot CREATE TABLE', async () => {
    const err = await rejectsWith(db.app.query('CREATE TABLE ddl_denied (id int)'));
    expect(err.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
  });
});

describe('5. grants are explicit', () => {
  it('a migrator table is unreadable by the app until SELECT is granted; INSERT stays denied', async () => {
    await db.migrator.query('CREATE TABLE secret_rows (id int)');
    await db.migrator.query('INSERT INTO secret_rows VALUES (1)');

    expect((await rejectsWith(db.app.query('SELECT * FROM secret_rows'))).code).toBe(
      PG_INSUFFICIENT_PRIVILEGE,
    );

    await db.migrator.query('GRANT SELECT ON secret_rows TO vantage_app');
    const ok = await db.app.query('SELECT * FROM secret_rows'); // control
    expect(ok.rowCount).toBe(1);

    expect((await rejectsWith(db.app.query('INSERT INTO secret_rows VALUES (2)'))).code).toBe(
      PG_INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe('6. disposal', () => {
  it('a failing test body still drops its database (try/finally pattern)', async () => {
    const t = await createTestDatabase();
    const name = t.name;
    expect(await dbExists(name)).toBe(true); // control
    await expect(
      (async () => {
        try {
          throw new Error('boom');
        } finally {
          await t.dispose();
        }
      })(),
    ).rejects.toThrow('boom');
    expect(await dbExists(name)).toBe(false);
  });

  it('dispose() completes with a busy open connection, and is idempotent', async () => {
    const t = await createTestDatabase();
    const busy = await t.app.connect();
    busy.on('error', () => undefined); // the forced drop terminates this connection on purpose
    const running = busy.query('SELECT pg_sleep(60)').catch(() => undefined); // killed by the forced drop
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await t.dispose();
    await t.dispose();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await dbExists(t.name)).toBe(false);
    await running;
  });

  it('test:cleanup logic drops stale test databases and leaves nothing behind (control)', async () => {
    const stale = await createTestDatabase(); // deliberately not disposed
    expect(await dbExists(stale.name)).toBe(true);
    const dropped = await dropStaleTestDatabases();
    expect(dropped).toContain(stale.name);
    expect(await dbExists(stale.name)).toBe(false);
    // the shared suite database matched the pattern too, so it is gone as well (afterAll dispose is idempotent)
    expect(await dbExists(db.name)).toBe(false);
  });
});
