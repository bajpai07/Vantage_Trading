import { createHash } from 'node:crypto';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOCK, LOGGER } from '../../tokens.js';
import { LedgerService } from '../ledger/ledger.service.js';
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

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createHarness(db);
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const count = async (table: string): Promise<number> =>
  Number((await db.migrator.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

const post = (path: string, body: unknown, origin: string | null = WEB_ORIGIN) => {
  const r = h.http.post(path).send(body as object);
  return origin === null ? r : r.set('Origin', origin);
};

describe('1. register', () => {
  it('creates the user, MAIN account, ledger accounts and one GRANT in one go', async () => {
    const res = await post('/v1/auth/register', registerBody('ada@example.com'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: 'ada@example.com',
      displayName: 'Test User',
      countryCode: 'IN',
      role: 'USER',
      status: 'ACTIVE',
    });

    // cookie flags
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((c) => c.startsWith('vantage_session='));
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=604800'); // 7 days
    expect(cookie).not.toContain('Secure'); // COOKIE_SECURE=false in the test config
    const token = sessionTokenFrom(cookies);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // password stored only as an Argon2id hash
    const user = (
      await db.migrator.query<{
        id: string;
        password_hash: string;
        status: string;
        v: Date | null;
      }>(
        `SELECT id, password_hash, status::text AS status, email_verified_at AS v FROM users WHERE email = 'ada@example.com'`,
      )
    ).rows[0];
    expect(user?.password_hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(user?.password_hash).not.toContain(VALID_PASSWORD);
    expect(user?.status).toBe('ACTIVE'); // D-42
    expect(user?.v).toBeNull(); // email_verified_at stays NULL until verification exists

    // the session token is stored only as its SHA-256
    const sess = await db.migrator.query<{ token_hash: Buffer; hex: string }>(
      `SELECT token_hash, encode(token_hash, 'hex') AS hex FROM user_sessions WHERE user_id = $1::uuid`,
      [user?.id],
    );
    expect(sess.rows).toHaveLength(1);
    expect(sess.rows[0]?.hex).toBe(
      createHash('sha256')
        .update(token ?? '')
        .digest('hex'),
    );
    expect(sess.rows[0]?.token_hash.length).toBe(32);
    const rawLeak = await db.migrator.query(
      `SELECT 1 FROM user_sessions WHERE position($1 in coalesce(user_agent, '')) > 0 OR encode(token_hash, 'escape') = $1`,
      [token],
    );
    expect(rawLeak.rowCount).toBe(0);

    // account and ledger
    const acct = (
      await db.migrator.query<{ id: string; initial_capital: string; kind: string }>(
        `SELECT id, initial_capital, kind::text AS kind FROM accounts WHERE user_id = $1::uuid`,
        [user?.id],
      )
    ).rows;
    expect(acct).toHaveLength(1);
    expect(acct[0]?.initial_capital).toBe('10000.0000000000');
    expect(acct[0]?.kind).toBe('MAIN');
    const accountId = acct[0]?.id ?? '';
    const bal = Object.fromEntries(
      (
        await db.migrator.query<{ type: string; balance: string }>(
          `SELECT type::text AS type, balance FROM ledger_accounts WHERE account_id = $1::uuid`,
          [accountId],
        )
      ).rows.map((r) => [r.type, r.balance]),
    );
    expect(bal['CASH']).toBe('10000.0000000000');
    expect(bal['CAPITAL']).toBe('-10000.0000000000');
    expect(await new LedgerService().reconcileAccount(db.migrator, accountId)).toEqual([]);

    const grants = await db.migrator.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM ledger_transactions WHERE account_id = $1::uuid AND kind = 'GRANT'`,
      [accountId],
    );
    expect(grants.rows.map((r) => r.idempotency_key)).toEqual([`grant:${accountId}`]);
  });

  it('new ids are UUIDv7 (D-41)', async () => {
    const r = await db.migrator.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    expect(r.rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('2. registration is atomic', () => {
  it('a failure at the GRANT step leaves no user, account, ledger rows or session (control: it works normally)', async () => {
    const real = new LedgerService();
    const broken = {
      createAccount: real.createAccount.bind(real),
      postTransaction: real.postTransaction.bind(real),
      reconcileAccount: real.reconcileAccount.bind(real),
      grantInitialCapital: () => Promise.reject(new Error('boom at the grant step')),
    };
    const hb = await createHarness(db, { overrides: [[LedgerService, broken]] });
    try {
      const before = {
        users: await count('users'),
        accounts: await count('accounts'),
        ledgerAccounts: await count('ledger_accounts'),
        transactions: await count('ledger_transactions'),
        entries: await count('ledger_entries'),
        sessions: await count('user_sessions'),
      };
      const res = await hb.http
        .post('/v1/auth/register')
        .set('Origin', WEB_ORIGIN)
        .send(registerBody('atomic@example.com'));
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('boom');
      const after = {
        users: await count('users'),
        accounts: await count('accounts'),
        ledgerAccounts: await count('ledger_accounts'),
        transactions: await count('ledger_transactions'),
        entries: await count('ledger_entries'),
        sessions: await count('user_sessions'),
      };
      expect(after).toEqual(before);
      const gone = await db.migrator.query(
        `SELECT 1 FROM users WHERE email = 'atomic@example.com'`,
      );
      expect(gone.rowCount).toBe(0);
    } finally {
      await hb.close();
    }
    // control: the same email registers fine with the real ledger service
    const ok = await post('/v1/auth/register', registerBody('atomic@example.com'));
    expect(ok.status).toBe(201);
  });

  it('a duplicate email (different case) returns 409 and creates nothing (control: first one worked)', async () => {
    const first = await post('/v1/auth/register', registerBody('Dup@Example.com'));
    expect(first.status).toBe(201);
    const before = {
      users: await count('users'),
      accounts: await count('accounts'),
      ledgerAccounts: await count('ledger_accounts'),
      transactions: await count('ledger_transactions'),
      entries: await count('ledger_entries'),
      sessions: await count('user_sessions'),
    };
    const dup = await post('/v1/auth/register', registerBody('dup@example.com'));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    expect(dup.headers['set-cookie']).toBeUndefined();
    expect({
      users: await count('users'),
      accounts: await count('accounts'),
      ledgerAccounts: await count('ledger_accounts'),
      transactions: await count('ledger_transactions'),
      entries: await count('ledger_entries'),
      sessions: await count('user_sessions'),
    }).toEqual(before);
  });
});

describe('3. validation', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['confirmAdult false', { confirmAdult: false }],
    ['acceptTerms false', { acceptTerms: false }],
    ['bad country', { countryCode: 'XX' }],
    ['weak (short) password', { password: 'short' }],
    ['password equal to email', { password: 'valid1@example.com' }],
    ['display name too short', { displayName: 'A' }],
    ['not an email', { email: 'nope' }],
    ['unknown field', { role: 'ADMIN' }],
  ];

  it.each(bad)('rejects %s with the error envelope and writes nothing', async (_name, patch) => {
    const before = { users: await count('users'), accounts: await count('accounts') };
    const res = await post('/v1/auth/register', registerBody('valid1@example.com', patch));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(typeof res.body.error.requestId).toBe('string');
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(JSON.stringify(res.body)).not.toContain(VALID_PASSWORD);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect({ users: await count('users'), accounts: await count('accounts') }).toEqual(before);
  });

  it('the valid control succeeds', async () => {
    const res = await post('/v1/auth/register', registerBody('valid1@example.com'));
    expect(res.status).toBe(201);
  });

  it('an oversized body (over 100 KB) gets 413 in the envelope; malformed JSON gets 400', async () => {
    const big = await h.http
      .post('/v1/auth/register')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(200_000) }));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const broken = await h.http
      .post('/v1/auth/register')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(broken.body)).not.toContain('Unexpected');
  });
});

describe('config providers are overridable (sanity for the harness)', () => {
  it('uses the injected clock and a capturing logger', () => {
    expect(h.app.get(CLOCK).now().toISOString()).toBe('2026-11-10T12:00:00.000Z');
    expect(h.app.get(LOGGER)).toBeDefined();
  });
});
