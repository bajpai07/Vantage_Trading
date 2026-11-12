// Concurrency and atomicity over real HTTP and real Postgres (no mocks of the database).
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { parse } from '@vantage/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from '../../testing/harness.js';
import {
  BUY_AAPL,
  cash,
  counts,
  createOrdersHarness,
  getAs,
  newKey,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import { ORDER_HOOKS } from '../../tokens.js';
import { reconcileAccount } from '../ledger/reconcile.js';

let db: TestDatabase;
let h: Harness;
let failNext = false;
let hookCalls = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db, {
    overrides: [
      [
        ORDER_HOOKS,
        {
          afterLedgerPost: () => {
            hookCalls += 1;
            if (failNext) throw new Error('injected failure after the ledger post');
          },
        },
      ],
    ],
  });
  await setQuote(h, 'AAPL', '99.98', '100.00'); // BUY 4 -> 100.02 each, 400.08 per order
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const BUY4 = { ...BUY_AAPL, qty: '4', referencePrice: '100.00' };
const dec = (s: string): string => parse(s).toString();

describe('2. idempotency under parallel requests', () => {
  it('50 parallel identical requests (same key, same body): exactly one fill, every response is the same 201 body', async () => {
    const u = await newUser(h, db);
    const key = newKey();
    const before = await counts(db, u.accountId);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => placeOrder(h, u, key, BUY4)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(50).fill(201));
    const first = results[0]?.body;
    expect(first).toMatchObject({ status: 'FILLED', qty: '4' });
    for (const r of results) expect(r.body).toEqual(first);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await counts(db, u.accountId)).toEqual({
      orders: before.orders + 1,
      executions: before.executions + 1,
      idempotency: before.idempotency + 1,
      ledgerTx: before.ledgerTx + 1,
    });
    expect(dec(await cash(db, u.accountId))).toBe('9599.92'); // 10000 - 4 x 100.02, once
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });

  it('50 parallel requests with one key but two different bodies: exactly one wins, the others are 422 mismatches', async () => {
    const u = await newUser(h, db);
    const key = newKey();
    const bodies = [BUY4, { ...BUY4, qty: '5' }];
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => placeOrder(h, u, key, bodies[i % 2])),
    );
    const ok = results.filter((r) => r.status === 201);
    const mismatch = results.filter((r) => r.status === 422);
    expect(ok.length + mismatch.length).toBe(50);
    expect(ok.length).toBeGreaterThanOrEqual(25); // all requests carrying the winning body replay it
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    for (const r of mismatch) expect(r.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect((await counts(db, u.accountId)).orders).toBe(1);
    expect((await counts(db, u.accountId)).executions).toBe(1);
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });
});

describe('5. concurrency over HTTP', () => {
  it('50 parallel BUYs with distinct keys on one account: exactly 24 FILLED and 26 REJECTED, cash exactly 398.08, no overspend', async () => {
    const u = await newUser(h, db);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => placeOrder(h, u, newKey(), BUY4)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(50).fill(201));
    const filled = results.filter((r) => r.body.status === 'FILLED');
    const rejected = results.filter((r) => r.body.status === 'REJECTED');
    expect(filled).toHaveLength(24); // 24 x 400.08 = 9601.92; the 25th would need 400.08 but 398.08 remains
    expect(rejected).toHaveLength(26);
    for (const r of rejected) expect(r.body.rejectCode).toBe('INSUFFICIENT_BUYING_POWER');
    expect(dec(await cash(db, u.accountId))).toBe('398.08');
    expect(await counts(db, u.accountId)).toMatchObject({ orders: 50, executions: 24 });
    const pos = await getAs(h, u, '/v1/positions');
    expect(pos.body.positions).toEqual([{ symbol: 'AAPL', qty: '96', avgCost: '100.02' }]);
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });

  it('requests from different users in parallel do not interfere: every account ends in its own exact state', async () => {
    const users = await Promise.all(Array.from({ length: 10 }, () => newUser(h, db)));
    const calls = users.flatMap((u) =>
      Array.from({ length: 5 }, () => placeOrder(h, u, newKey(), BUY4).then((r) => ({ u, r }))),
    );
    // interleave a heavy single-account load at the same time
    const heavy = await newUser(h, db);
    const heavyCalls = Array.from({ length: 30 }, () => placeOrder(h, heavy, newKey(), BUY4));
    const [perUser, heavyResults] = await Promise.all([
      Promise.all(calls),
      Promise.all(heavyCalls),
    ]);
    expect(perUser.every((x) => x.r.status === 201)).toBe(true);
    expect(heavyResults.every((r) => r.status === 201)).toBe(true);
    for (const u of users) {
      expect(dec(await cash(db, u.accountId))).toBe('7999.6'); // 10000 - 5 x 400.08
      expect(await counts(db, u.accountId)).toMatchObject({ orders: 5, executions: 5 });
      expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
    }
    expect(await reconcileAccount(db.app, heavy.accountId)).toEqual([]);
  });
});

describe('6. atomicity: a failure after the ledger post', () => {
  it('500 with a request id, nothing persisted (no order, execution, ledger transaction or idempotency row); the retry with the same key then succeeds exactly once', async () => {
    const u = await newUser(h, db);
    const key = newKey();
    const before = await counts(db, u.accountId);
    const cashBefore = dec(await cash(db, u.accountId));

    failNext = true;
    const calls0 = hookCalls;
    const failed = await placeOrder(h, u, key, BUY4);
    failNext = false;
    expect(hookCalls).toBe(calls0 + 1); // the hook really ran, after the ledger post
    expect(failed.status).toBe(500);
    expect(failed.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: expect.any(String),
    });
    expect(failed.headers['x-request-id']).toBe(failed.body.error.requestId);
    expect(JSON.stringify(failed.body)).not.toMatch(/injected|ledger|SELECT|INSERT/);
    expect(await counts(db, u.accountId)).toEqual(before);
    expect(dec(await cash(db, u.accountId))).toBe(cashBefore);
    expect(
      (
        await db.migrator.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [
          key,
        ])
      ).rows[0]?.n,
    ).toBe(0);
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);

    // the retry with the same key succeeds, once
    const retry = await placeOrder(h, u, key, BUY4);
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ status: 'FILLED' });
    const again = await placeOrder(h, u, key, BUY4);
    expect(again.body).toEqual(retry.body);
    expect(await counts(db, u.accountId)).toEqual({
      orders: before.orders + 1,
      executions: before.executions + 1,
      idempotency: before.idempotency + 1,
      ledgerTx: before.ledgerTx + 1,
    });
    expect(dec(await cash(db, u.accountId))).toBe('9599.92');
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });

  it('a failure in the middle of parallel load leaves every other order intact (control: no failure, everything fills)', async () => {
    const u = await newUser(h, db);
    const r1 = await Promise.all(Array.from({ length: 5 }, () => placeOrder(h, u, newKey(), BUY4)));
    expect(r1.every((r) => r.body.status === 'FILLED')).toBe(true);
    failNext = true;
    const r2 = await Promise.all(Array.from({ length: 4 }, () => placeOrder(h, u, newKey(), BUY4)));
    failNext = false;
    expect(r2.every((r) => r.status === 500)).toBe(true);
    expect(await counts(db, u.accountId)).toMatchObject({
      orders: 5,
      executions: 5,
      idempotency: 5,
    });
    expect(dec(await cash(db, u.accountId))).toBe('7999.6');
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });
});
