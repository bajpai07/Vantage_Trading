import pg from 'pg';
import { buyFillLegs } from '@vantage/engine';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../ledger/ledger.service.js';
import { POOL } from '../../tokens.js';
import {
  VALID_PASSWORD,
  WEB_ORIGIN,
  createHarness,
  registerBody,
  sessionTokenFrom,
} from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';

let db: TestDatabase;
let h: Harness;
const tokens: Record<string, string> = {};
const accountIds: Record<string, string> = {};
/** Every response body seen, for the "no secrets or stack traces" scan. */
const bodies: string[] = [];

const pool = (): pg.Pool => h.app.get<pg.Pool>(POOL);

async function expectPgError(p: Promise<unknown>, code: string | undefined, text?: RegExp) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (code !== undefined) expect(err.code).toBe(code);
    if (text !== undefined) expect(err.message).toMatch(text);
    return;
  }
  throw new Error('expected the statement to fail');
}

async function register(email: string): Promise<void> {
  const res = await h.http
    .post('/v1/auth/register')
    .set('Origin', WEB_ORIGIN)
    .send(registerBody(email));
  expect(res.status).toBe(201);
  tokens[email] = sessionTokenFrom(res.headers['set-cookie']) ?? '';
  const a = await db.migrator.query<{ id: string }>(
    `SELECT a.id FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = $1`,
    [email],
  );
  accountIds[email] = a.rows[0]?.id ?? '';
}
const get = async (path: string, email?: string) => {
  const r = h.http.get(path);
  const res = await (email === undefined
    ? r
    : r.set('Cookie', `vantage_session=${tokens[email] ?? ''}`));
  bodies.push(JSON.stringify(res.body));
  return res;
};

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createHarness(db);
  await register('alice@example.com');
  await register('bob@example.com');
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

describe('7. privileges of vantage_app (through the real app connection)', () => {
  it('cannot UPDATE or DELETE users (permission denied)', async () => {
    await expectPgError(pool().query(`UPDATE users SET display_name = 'Hacker'`), '42501');
    await expectPgError(pool().query(`UPDATE users SET role = 'ADMIN'`), '42501');
    await expectPgError(pool().query(`UPDATE users SET status = 'ACTIVE'`), '42501');
    await expectPgError(pool().query(`DELETE FROM users`), '42501');
    await expectPgError(pool().query(`TRUNCATE users CASCADE`), '42501');
  });

  it('cannot change user_sessions.token_hash (or any column except last_seen_at and revoked_at)', async () => {
    await expectPgError(
      pool().query(`UPDATE user_sessions SET token_hash = '\\x00'::bytea`),
      '42501',
    );
    await expectPgError(pool().query(`UPDATE user_sessions SET user_id = user_id`), '42501');
    await expectPgError(pool().query(`UPDATE user_sessions SET expires_at = now()`), '42501');
    await expectPgError(pool().query(`DELETE FROM user_sessions`), '42501');
  });

  it('control: the allowed operations work (insert user and session; update last_seen_at and revoked_at)', async () => {
    await pool().query(`UPDATE user_sessions SET last_seen_at = last_seen_at WHERE false`);
    await pool().query(`UPDATE user_sessions SET revoked_at = revoked_at WHERE false`);
    const sessions = await pool().query(`SELECT id FROM user_sessions LIMIT 1`);
    expect(sessions.rowCount).toBeGreaterThan(0);
    // a real update of an allowed column on a throw-away session
    await register('throwaway@example.com');
    const t = await db.migrator.query<{ id: string }>(
      `SELECT s.id FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'throwaway@example.com'`,
    );
    const r = await pool().query(
      `UPDATE user_sessions SET revoked_at = now() WHERE id = $1::uuid`,
      [t.rows[0]?.id],
    );
    expect(r.rowCount).toBe(1);
  });

  it('cannot read or modify audit_logs, and not even the migrator can (append-only triggers)', async () => {
    await expectPgError(pool().query(`UPDATE audit_logs SET action = 'X'`), '42501');
    await expectPgError(pool().query(`DELETE FROM audit_logs`), '42501');
    await expectPgError(pool().query(`TRUNCATE audit_logs`), '42501');
    await expectPgError(pool().query(`SELECT * FROM audit_logs`), '42501');
    await expectPgError(
      db.migrator.query(`UPDATE audit_logs SET action = 'X'`),
      'P0001',
      /append-only/,
    );
    await expectPgError(db.migrator.query(`DELETE FROM audit_logs`), 'P0001', /append-only/);
    await expectPgError(db.migrator.query(`TRUNCATE audit_logs`), 'P0001', /append-only/);
  });

  it('writes audit rows for register, login success, login failure and logout (control: INSERT works)', async () => {
    const login = await h.http
      .post('/v1/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: 'alice@example.com', password: VALID_PASSWORD });
    expect(login.status).toBe(200);
    const failed = await h.http
      .post('/v1/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({ email: 'alice@example.com', password: 'not the password' });
    expect(failed.status).toBe(401);
    const tok = sessionTokenFrom(login.headers['set-cookie']) ?? '';
    await h.http
      .post('/v1/auth/logout')
      .set('Origin', WEB_ORIGIN)
      .set('Cookie', `vantage_session=${tok}`);

    const rows = await db.migrator.query<{
      action: string;
      actor_id: string | null;
      after: unknown;
      ip: string | null;
      request_id: string | null;
    }>(`SELECT action, actor_id, after, host(ip) AS ip, request_id FROM audit_logs ORDER BY id`);
    const actions = rows.rows.map((r) => r.action);
    for (const a of ['USER_REGISTERED', 'LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGOUT']) {
      expect(actions).toContain(a);
    }
    const failedRow = rows.rows.find((r) => r.action === 'LOGIN_FAILED');
    expect(failedRow?.actor_id).toBeNull();
    const after = failedRow?.after as { emailHash?: string } | null;
    expect(after?.emailHash).toMatch(/^[0-9a-f]{12}$/);
    // never the email or a password in any audit row
    const dump = JSON.stringify(rows.rows);
    expect(dump).not.toContain('alice@example.com');
    expect(dump).not.toContain(VALID_PASSWORD);
    expect(dump).not.toContain('not the password');
    expect(rows.rows.every((r) => r.request_id !== null)).toBe(true);
  });

  it('an audit failure does not block the request, but is logged (control: the login succeeds)', async () => {
    // a pool whose audit insert fails: only audit_logs inserts are rejected
    const real = pool();
    const flaky = {
      query: (sql: unknown, params?: unknown) =>
        typeof sql === 'string' && sql.includes('INSERT INTO audit_logs')
          ? Promise.reject(Object.assign(new Error('audit down'), { code: '57P01' }))
          : real.query(sql as string, params as unknown[] | undefined),
      connect: () => real.connect(),
      end: () => Promise.resolve(),
      on: () => undefined,
    };
    const hf = await createHarness(db, { overrides: [[POOL, flaky]] });
    try {
      const res = await hf.http
        .post('/v1/auth/login')
        .set('Origin', WEB_ORIGIN)
        .send({ email: 'bob@example.com', password: VALID_PASSWORD });
      expect(res.status).toBe(200);
      const line = hf.logs
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.msg === 'audit_write_failed');
      expect(line).toMatchObject({ action: 'LOGIN_SUCCEEDED', errorCode: '57P01' });
    } finally {
      await hf.close();
    }
  });
});

describe('8. account endpoint', () => {
  it('returns money as canonical strings, never numbers', async () => {
    const res = await get('/v1/account', 'alice@example.com');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      currency: 'USD',
      cash: '10000.00',
      equity: '10000.00',
      initialCapital: '10000.00',
    });
    for (const k of ['cash', 'equity', 'initialCapital']) expect(typeof res.body[k]).toBe('string');
    expect(res.body.asOf).toBe('2026-11-10T12:00:00.000Z');
    expect(res.text).toMatch(/"cash":"10000\.00"/); // quoted in the raw JSON
  });

  it('a user sees only their own account; there is no way to name another', async () => {
    // alice spends 1,900.4015 (a canonical string with 4 decimals); bob is untouched
    const aliceAccount = accountIds['alice@example.com'] ?? '';
    const p = pool();
    const c = await p.connect();
    try {
      await c.query('BEGIN');
      await new LedgerService().postTransaction(c, {
        accountId: aliceAccount,
        kind: 'FILL',
        idempotencyKey: 'alice-buy-1',
        legs: buyFillLegs({ qty: '10', price: '190.04015', fee: '0' }),
      });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const alice = await get('/v1/account', 'alice@example.com');
    const bob = await get('/v1/account', 'bob@example.com');
    expect(alice.body.cash).toBe('8099.5985');
    expect(bob.body.cash).toBe('10000.00'); // control: bob is not affected
    // trying to name alice's account while logged in as bob changes nothing
    const spoof = await get(`/v1/account?accountId=${aliceAccount}&userId=x`, 'bob@example.com');
    expect(spoof.body.cash).toBe('10000.00');
    const byPath = await get(`/v1/account/${aliceAccount}`, 'bob@example.com');
    expect(byPath.status).toBe(404);
  });

  it('unauthenticated access gets 401 in the envelope (control: with a session it is 200)', async () => {
    for (const path of ['/v1/me', '/v1/account']) {
      const res = await get(path);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication required',
          requestId: expect.any(String),
        },
      });
      expect((await get(path, 'bob@example.com')).status).toBe(200);
    }
  });

  it('GET /v1/me returns the profile (and no password hash)', async () => {
    const res = await get('/v1/me', 'bob@example.com');
    expect(res.body).toEqual({
      id: expect.any(String),
      email: 'bob@example.com',
      displayName: 'Test User',
      countryCode: 'IN',
      role: 'USER',
      status: 'ACTIVE',
    });
    expect(res.text).not.toContain('argon2');
  });

  it('the balance endpoint requires status ACTIVE (a suspended user gets 403; control: active gets 200)', async () => {
    await register('suspended@example.com');
    expect((await get('/v1/account', 'suspended@example.com')).status).toBe(200);
    await db.migrator.query(
      `UPDATE users SET status = 'SUSPENDED' WHERE email = 'suspended@example.com'`,
    );
    const res = await get('/v1/account', 'suspended@example.com');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
  });
});

describe('9. health, request ids, and no leaks', () => {
  it('/health and /health/ready return 200 with a working database (control)', async () => {
    expect((await h.http.get('/health')).body).toEqual({ status: 'ok' });
    expect((await h.http.get('/health/ready')).body).toEqual({ status: 'ready' });
  });

  it('/health/ready returns 503 when the pool points at a closed database; /health stays 200', async () => {
    const closed = new pg.Pool({ connectionString: db.appUrl });
    await closed.query('SELECT 1'); // proves it was a working pool...
    await closed.end(); // ...that is now closed
    const hc = await createHarness(db, { overrides: [[POOL, closed]] });
    try {
      const ready = await hc.http.get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.error.code).toBe('NOT_READY');
      expect(JSON.stringify(ready.body)).not.toMatch(/pool|closed|ECONN/i);
      expect((await hc.http.get('/health')).status).toBe(200);
    } finally {
      await hc.close();
    }
  });

  it('reuses a safe incoming x-request-id and replaces an unsafe one; x-powered-by is off', async () => {
    const safe = await h.http.get('/health').set('x-request-id', 'trace-1234.abc_X');
    expect(safe.headers['x-request-id']).toBe('trace-1234.abc_X');
    for (const unsafe of [
      'short',
      'has spaces in it',
      'x'.repeat(65),
      'semi;colon-12345',
      '<script>12345',
    ]) {
      const res = await h.http.get('/health').set('x-request-id', unsafe);
      expect(res.headers['x-request-id']).not.toBe(unsafe);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(safe.headers['x-powered-by']).toBeUndefined();
    expect(safe.headers['x-content-type-options']).toBe('nosniff');
    expect(safe.headers['x-frame-options']).toBe('DENY');
  });

  it('unknown routes and bad methods use the envelope', async () => {
    const res = await h.http.get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    bodies.push(JSON.stringify(res.body));
  });

  it('no response, log line or error ever contains a password, a cookie value or a stack trace', async () => {
    // an unhandled 500 (forced) on a separate app, so its logs are scanned too
    const real = new LedgerService();
    const hb = await createHarness(db, {
      overrides: [
        [
          LedgerService,
          {
            createAccount: real.createAccount.bind(real),
            postTransaction: real.postTransaction.bind(real),
            reconcileAccount: real.reconcileAccount.bind(real),
            grantInitialCapital: () =>
              Promise.reject(
                Object.assign(new Error('secret detail: password=hunter2 INSERT INTO'), {
                  code: 'XX000',
                }),
              ),
          },
        ],
      ],
    });
    let boom;
    try {
      boom = await hb.http
        .post('/v1/auth/register')
        .set('Origin', WEB_ORIGIN)
        .send(registerBody('boom@example.com'));
    } finally {
      await hb.close();
    }
    expect(boom.status).toBe(500);
    bodies.push(JSON.stringify(boom.body));

    const allLogs = [...h.logs, ...hb.logs].join('\n');
    const allBodies = bodies.join('\n');
    const secrets = [
      VALID_PASSWORD,
      'not the password',
      'hunter2',
      'definitely not the password',
      ...Object.values(tokens),
    ];
    for (const s of secrets) {
      expect(allLogs).not.toContain(s);
      expect(allBodies).not.toContain(s);
    }
    for (const text of [allLogs, allBodies]) {
      expect(text).not.toMatch(/\n\s+at \S+/); // no stack frames
      expect(text).not.toContain('"stack"');
      expect(text).not.toContain('node_modules');
      expect(text).not.toMatch(/INSERT INTO|SELECT .* FROM/);
      expect(text).not.toMatch(/\$argon2/);
    }
    // the log did record the failure, in a safe form
    const unhandled = hb.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === 'unhandled_error');
    expect(unhandled).toMatchObject({ errorName: 'Error', errorCode: 'XX000' });
    // request log lines carry no query string, headers or bodies
    const req = h.logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'request');
    expect(req.length).toBeGreaterThan(5);
    for (const l of req)
      expect(Object.keys(l).sort()).toEqual([
        'durationMs',
        'level',
        'method',
        'msg',
        'path',
        'requestId',
        'status',
        'time',
      ]);
  });
});
