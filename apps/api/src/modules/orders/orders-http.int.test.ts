// Order API over real HTTP (Nest test app) against real Postgres as vantage_app, injected clock, FIXTURE quotes.
// Every "must fail" has a control that succeeds.
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { parse } from '@vantage/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VALID_PASSWORD, WEB_ORIGIN, cookie } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import {
  BUY_AAPL,
  OPEN_TIME,
  cash,
  counts,
  createOrdersHarness,
  getAs,
  newKey,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import type { TestUser } from '../../testing/orders-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';

let db: TestDatabase;
let h: Harness;
let alice: TestUser;
let bob: TestUser;
/** Every response body and header seen, for the final "no secrets" scan. */
const seen: string[] = [];
const track = <T extends { body: unknown; headers: unknown }>(res: T): T => {
  seen.push(JSON.stringify(res.body), JSON.stringify(res.headers));
  return res;
};

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db);
  await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
  alice = await newUser(h, db, 'alice');
  bob = await newUser(h, db, 'bob');
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const dec = (s: string): string => parse(s).toString();

describe('1. golden vector A through HTTP: register, buy 10 AAPL', () => {
  it('201 FILLED, exact order, execution, ledger and cash (8,099.60), reconcile clean', async () => {
    const key = newKey();
    const res = track(await placeOrder(h, alice, key));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      status: 'FILLED',
      qty: '10',
      filledQty: '10',
      rejectCode: null,
      createdAt: OPEN_TIME,
      execution: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        qty: '10',
        price: '190.04', // ask 190.00 x 1.0002 = 190.038 -> up to the tick
        notional: '1900.40',
        fee: '0.00',
        slippageBps: '2',
        executedAt: OPEN_TIME,
        quoteSource: 'FIXTURE',
      },
    });
    for (const v of [res.body.qty, res.body.execution.price, res.body.execution.notional]) {
      expect(typeof v).toBe('string');
    }

    // database: the key became the client order id (D-58 amendment); the account is the session user's
    const order = (
      await db.migrator.query(
        `SELECT account_id, client_order_id, status::text AS status, qty, filled_qty FROM orders WHERE id = $1::uuid`,
        [res.body.id],
      )
    ).rows[0];
    expect(order).toMatchObject({
      account_id: alice.accountId,
      client_order_id: key,
      status: 'FILLED',
    });
    expect(dec(order.qty)).toBe('10');

    const bal = Object.fromEntries(
      (
        await db.migrator.query(
          `SELECT type::text AS t, balance FROM ledger_accounts WHERE account_id = $1::uuid AND currency = 'USD'`,
          [alice.accountId],
        )
      ).rows.map((r) => [r.t, r.balance]),
    );
    expect(dec(bal.CASH)).toBe('8099.6'); // 10000 - 1900.40
    expect(dec(bal.POSITION_COST)).toBe('1900.4');
    const exec = (
      await db.migrator.query(
        `SELECT price, gross_usd, fee_local, slippage_bps, model_version, quote_entitlement::text AS ent
           FROM executions WHERE order_id = $1::uuid`,
        [res.body.id],
      )
    ).rows[0];
    expect([
      dec(exec.price),
      dec(exec.gross_usd),
      dec(exec.fee_local),
      dec(exec.slippage_bps),
    ]).toEqual(['190.04', '1900.4', '0', '2']);
    expect(exec.model_version).toBe('QBX-1/r8he');
    expect(exec.ent).toBe('DELAYED');
    expect(await reconcileAccount(db.app, alice.accountId)).toEqual([]);
  });

  it('GET /v1/orders/:id returns exactly the body the POST returned; the position shows quantity and average cost only', async () => {
    const res = track(await placeOrder(h, alice, newKey(), { ...BUY_AAPL, qty: 1 }));
    expect(res.status).toBe(201);
    const got = track(await getAs(h, alice, `/v1/orders/${String(res.body.id)}`));
    expect(got.status).toBe(200);
    expect(got.body).toEqual(res.body);

    const pos = track(await getAs(h, alice, '/v1/positions'));
    expect(pos.status).toBe(200);
    expect(pos.body).toEqual({ positions: [{ symbol: 'AAPL', qty: '11', avgCost: '190.04' }] });
    expect(JSON.stringify(pos.body)).not.toMatch(/marketValue|pnl|PnL|unrealized/i);
    expect(await reconcileAccount(db.app, alice.accountId)).toEqual([]);
  });

  it('a user with no position gets an empty list (control)', async () => {
    const pos = await getAs(h, bob, '/v1/positions');
    expect(pos.body).toEqual({ positions: [] });
  });
});

describe('2. idempotency (D-58, key = client_order_id)', () => {
  it('the same key and body twice: identical status and body, exactly one execution and one ledger transaction', async () => {
    const u = await newUser(h, db);
    const key = newKey();
    const before = await counts(db, u.accountId);
    const first = track(await placeOrder(h, u, key));
    const second = track(await placeOrder(h, u, key));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const after = await counts(db, u.accountId);
    expect(after).toEqual({
      orders: before.orders + 1,
      executions: before.executions + 1,
      idempotency: before.idempotency + 1,
      ledgerTx: before.ledgerTx + 1, // the FILL (the grant was already counted before)
    });
    expect(dec(await cash(db, u.accountId))).toBe('8099.6'); // charged once
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });

  it('a replayed REJECTED order is also stored: same body, no new order (control: a new key places a new order)', async () => {
    const u = await newUser(h, db);
    const key = newKey();
    const body = { ...BUY_AAPL, qty: '53' }; // 53 x 190.04 > 10,000
    const first = await placeOrder(h, u, key, body);
    expect(first.body).toMatchObject({
      status: 'REJECTED',
      rejectCode: 'INSUFFICIENT_BUYING_POWER',
    });
    const before = await counts(db, u.accountId);
    const second = await placeOrder(h, u, key, body);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(await counts(db, u.accountId)).toEqual(before);
    const third = await placeOrder(h, u, newKey(), body);
    expect(third.body.id).not.toBe(first.body.id);
    expect((await counts(db, u.accountId)).orders).toBe(before.orders + 1);
  });

  it('the same key with a different body is 422 IDEMPOTENCY_MISMATCH and changes nothing (control: the original still replays)', async () => {
    const u = await newUser(h, db);
    const key = newKey();
    const first = await placeOrder(h, u, key);
    const before = await counts(db, u.accountId);
    for (const other of [
      { ...BUY_AAPL, qty: '11' },
      { ...BUY_AAPL, side: 'SELL', referencePrice: '189.95' },
      { ...BUY_AAPL, symbol: 'MSFT' },
      { ...BUY_AAPL, referencePrice: '190.01' },
    ]) {
      const res = track(await placeOrder(h, u, key, other));
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
      expect(res.body.error.requestId).toEqual(expect.any(String));
    }
    expect(await counts(db, u.accountId)).toEqual(before);
    const again = await placeOrder(h, u, key);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
  });

  it('requests are compared by their validated, canonical form, not their bytes', async () => {
    const u = await newUser(h, db);
    const key = newKey();
    const first = await placeOrder(h, u, key, {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      qty: '10',
      referencePrice: '190.00',
    });
    // lower-case symbol, qty as a JSON integer, price without decimals, keys in another order
    const same = await placeOrder(h, u, key, {
      referencePrice: '190',
      qty: 10,
      type: 'MARKET',
      side: 'BUY',
      symbol: 'aapl',
    });
    expect(same.status).toBe(201);
    expect(same.body).toEqual(first.body);
    // control: a genuinely different quantity is a mismatch
    expect((await placeOrder(h, u, key, { ...BUY_AAPL, qty: 11 })).status).toBe(422);
  });

  it('the same key used by two different users does not collide and does not leak', async () => {
    const a = await newUser(h, db, 'ka');
    const b = await newUser(h, db, 'kb');
    const key = newKey();
    const ra = await placeOrder(h, a, key, { ...BUY_AAPL, qty: '2' });
    const rb = await placeOrder(h, b, key, { ...BUY_AAPL, qty: '3' }); // a different body: no mismatch across users
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(ra.body.id).not.toBe(rb.body.id);
    expect([ra.body.qty, rb.body.qty]).toEqual(['2', '3']);
    // each user replays only their own
    expect((await placeOrder(h, a, key, { ...BUY_AAPL, qty: '2' })).body).toEqual(ra.body);
    expect((await placeOrder(h, b, key, { ...BUY_AAPL, qty: '3' })).body).toEqual(rb.body);
    // and neither can read the other's order
    expect((await getAs(h, b, `/v1/orders/${String(ra.body.id)}`)).status).toBe(404);
    expect((await getAs(h, a, `/v1/orders/${String(rb.body.id)}`)).status).toBe(404);
    const aRows = await db.migrator.query(
      `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    expect(aRows.rows[0]?.n).toBe(2);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short (7)', 'abcdefg'],
    ['too long (129)', 'a'.repeat(129)],
    ['space', 'abcd efgh'],
    ['slash', 'abcd/efgh'],
    ['comma (two values)', 'abcdefgh, abcdefgh'],
    ['non-ASCII', 'abcdefghé'],
  ])('a %s Idempotency-Key is 400 IDEMPOTENCY_KEY_INVALID and stores nothing', async (_n, key) => {
    const u = await newUser(h, db);
    const res = track(await placeOrder(h, u, key));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect((await counts(db, u.accountId)).orders).toBe(0);
  });

  it('boundary keys of 8 and 128 characters are accepted (controls)', async () => {
    const u = await newUser(h, db);
    expect((await placeOrder(h, u, 'abcdefgh', { ...BUY_AAPL, qty: 1 })).status).toBe(201);
    expect((await placeOrder(h, u, 'a:b.c_d-'.repeat(16), { ...BUY_AAPL, qty: 1 })).status).toBe(
      201,
    );
  });
});

describe('3. authentication, CSRF and isolation', () => {
  it('no session: 401 on every route and nothing is stored', async () => {
    const key = newKey();
    const res = track(
      await h.http
        .post('/v1/orders')
        .set('Origin', WEB_ORIGIN)
        .set('Idempotency-Key', key)
        .send(BUY_AAPL),
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    for (const path of [
      '/v1/orders',
      '/v1/orders/0198d0d0-1111-7000-8000-000000000001',
      '/v1/positions',
    ]) {
      expect((await h.http.get(path)).status, path).toBe(401);
    }
    const garbage = await h.http.get('/v1/orders').set('Cookie', cookie('not-a-real-token'));
    expect(garbage.status).toBe(401);
    expect(
      (
        await db.migrator.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [
          key,
        ])
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('a bad or missing Origin is rejected with 403 and stores nothing (control: the right Origin works)', async () => {
    const u = await newUser(h, db);
    for (const origin of ['http://evil.example', 'http://localhost:3001', null]) {
      const res = track(await placeOrder(h, u, newKey(), BUY_AAPL, origin));
      expect(res.status, String(origin)).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
    }
    expect((await counts(db, u.accountId)).orders).toBe(0);
    expect((await placeOrder(h, u, newKey(), BUY_AAPL, WEB_ORIGIN)).status).toBe(201);
  });

  it("another user's order id is 404 ORDER_NOT_FOUND, the same answer as an id that does not exist; never 403", async () => {
    const a = await newUser(h, db);
    const b = await newUser(h, db);
    const placed = await placeOrder(h, a, newKey());
    const real = track(await getAs(h, b, `/v1/orders/${String(placed.body.id)}`));
    const missing = track(await getAs(h, b, '/v1/orders/0198d0d0-1111-7000-8000-000000000099'));
    const malformed = track(await getAs(h, b, '/v1/orders/not-a-uuid'));
    for (const r of [real, missing, malformed]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('ORDER_NOT_FOUND');
      expect(r.body.error.message).toBe(real.body.error.message);
    }
    expect((await getAs(h, a, `/v1/orders/${String(placed.body.id)}`)).status).toBe(200); // control
    expect((await getAs(h, b, '/v1/orders')).body.orders).toEqual([]); // B's list has none of A's orders
    expect((await getAs(h, b, '/v1/positions')).body.positions).toEqual([]);
  });

  it('an account id (or any other server-decided field) in the body is rejected with 400 and nothing is stored', async () => {
    const a = await newUser(h, db);
    const b = await newUser(h, db);
    for (const extra of [
      { accountId: b.accountId },
      { account_id: b.accountId },
      { price: '1.00' },
      { fee: '0' },
      { now: '2020-01-01T00:00:00Z' },
      { clientOrderId: 'abcdefgh' },
    ]) {
      const res = track(await placeOrder(h, a, newKey(), { ...BUY_AAPL, ...extra }));
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await counts(db, a.accountId)).orders).toBe(0);
    expect((await counts(db, b.accountId)).orders).toBe(0);
    expect((await placeOrder(h, a, newKey(), BUY_AAPL)).status).toBe(201); // control
  });

  it.each([
    ['float qty', { qty: 1.5 }],
    ['zero qty', { qty: 0 }],
    ['negative qty', { qty: -3 }],
    ['text qty', { qty: 'ten' }],
    ['huge qty', { qty: 10_000_000 }],
    ['numeric price', { referencePrice: 190 }],
    ['LIMIT type', { type: 'LIMIT' }],
    ['bad side', { side: 'SHORT' }],
  ])(
    'an invalid body (%s) is 400 VALIDATION_ERROR that names the field, not the value',
    async (_n, over) => {
      const u = await newUser(h, db);
      const res = track(await placeOrder(h, u, newKey(), { ...BUY_AAPL, ...over }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('ten');
      expect((await counts(db, u.accountId)).orders).toBe(0);
    },
  );

  it('a non-JSON or empty body is 400, not a 500', async () => {
    const u = await newUser(h, db);
    const res = await h.http
      .post('/v1/orders')
      .set('Cookie', cookie(u.token))
      .set('Origin', WEB_ORIGIN)
      .set('Idempotency-Key', newKey())
      .set('Content-Type', 'application/json')
      .send('{"symbol":');
    expect(res.status).toBe(400);
    expect((await placeOrder(h, u, newKey(), {})).status).toBe(400);
    expect((await placeOrder(h, u, newKey())).status).toBe(201); // control: a valid body works
  });
});

describe('7. pagination: stable cursor, newest first, no duplicates or skips', () => {
  let u: TestUser;
  const ids: string[] = []; // creation order, oldest first

  it('creates 25 orders (some rejected) and pages through them 10 at a time, newest first', async () => {
    u = await newUser(h, db, 'pager');
    for (let i = 0; i < 25; i += 1) {
      if (i % 5 === 4) h.clock.advance(1000); // vary created_at; the others share a timestamp (ties broken by id)
      const reject = i % 6 === 5; // every sixth is a reject
      const res = await placeOrder(
        h,
        u,
        newKey(),
        reject ? { ...BUY_AAPL, qty: '9999' } : { ...BUY_AAPL, qty: '1' },
      );
      expect(res.status).toBe(201);
      ids.push(String(res.body.id));
    }
    const newestFirst = [...ids].reverse();
    const got: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const q: Record<string, string> = { limit: '10' };
      if (cursor !== null) q.cursor = cursor;
      const page = track(await h.http.get('/v1/orders').query(q).set('Cookie', cookie(u.token)));
      expect(page.status).toBe(200);
      sizes.push(page.body.orders.length);
      got.push(...page.body.orders.map((o: { id: string }) => o.id));
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    expect(sizes).toEqual([10, 10, 5]);
    expect(got).toEqual(newestFirst);
    expect(new Set(got).size).toBe(25);
  });

  it('inserts between pages change neither duplicates nor skips: page 2 is exactly the next 10 older orders', async () => {
    const newestFirst = [...ids].reverse();
    const page1 = await h.http
      .get('/v1/orders')
      .query({ limit: '10' })
      .set('Cookie', cookie(u.token));
    expect(page1.body.orders.map((o: { id: string }) => o.id)).toEqual(newestFirst.slice(0, 10));
    // three new orders arrive after page 1 was read (same timestamp, then a later one)
    const extra: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      if (i === 2) h.clock.advance(5000);
      extra.push(String((await placeOrder(h, u, newKey(), { ...BUY_AAPL, qty: '1' })).body.id));
    }
    const page2 = await h.http
      .get('/v1/orders')
      .query({ limit: '10', cursor: page1.body.nextCursor })
      .set('Cookie', cookie(u.token));
    expect(page2.body.orders.map((o: { id: string }) => o.id)).toEqual(newestFirst.slice(10, 20));
    // control: a fresh first page now starts with the new orders
    const fresh = await h.http
      .get('/v1/orders')
      .query({ limit: '3' })
      .set('Cookie', cookie(u.token));
    expect(fresh.body.orders.map((o: { id: string }) => o.id)).toEqual([...extra].reverse());
  });

  it('filters by status and symbol; a 100-item page limit; bad limits and cursors are 400', async () => {
    const rejected = await getAs(h, u, '/v1/orders?status=REJECTED&limit=100');
    expect(rejected.status).toBe(200);
    expect(rejected.body.orders.length).toBe(4); // i = 5, 11, 17, 23
    expect(new Set(rejected.body.orders.map((o: { status: string }) => o.status))).toEqual(
      new Set(['REJECTED']),
    );
    expect(rejected.body.nextCursor).toBeNull();
    const filled = await getAs(h, u, '/v1/orders?status=FILLED&symbol=aapl&limit=100');
    expect(filled.body.orders.length).toBe(24); // 21 + 3 extra
    expect((await getAs(h, u, '/v1/orders?symbol=MSFT')).body.orders).toEqual([]);
    for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'cursor=!!!', 'status=OPEN', 'foo=1']) {
      const r = await getAs(h, u, `/v1/orders?${bad}`);
      expect(r.status, bad).toBe(400);
    }
    expect((await getAs(h, u, '/v1/orders?limit=100')).status).toBe(200); // control: the boundary is accepted
  });

  it("a cursor from one user used by another never shows the first user's orders", async () => {
    const page = await h.http
      .get('/v1/orders')
      .query({ limit: '5' })
      .set('Cookie', cookie(u.token));
    const other = await newUser(h, db);
    await placeOrder(h, other, newKey(), { ...BUY_AAPL, qty: '1' });
    const res = await h.http
      .get('/v1/orders')
      .query({ cursor: page.body.nextCursor, limit: '100' })
      .set('Cookie', cookie(other.token));
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]); // the other user's only order is newer than the cursor
    const mine = new Set(ids);
    for (const o of res.body.orders as Array<{ id: string }>) expect(mine.has(o.id)).toBe(false);
  });
});

describe('rate limit per user (30 per minute by default, in memory)', () => {
  it('the 4th order in a minute is 429 with Retry-After when the limit is 3; another user is unaffected; the window reopens (controls)', async () => {
    const hl = await createOrdersHarness(db, { env: { ORDER_RATE_LIMIT_PER_MINUTE: '3' } });
    try {
      await setQuote(hl, 'AAPL', '189.95', '190.00');
      const a = await newUser(hl, db, 'rl');
      const b = await newUser(hl, db, 'rl');
      for (let i = 0; i < 3; i += 1) {
        expect((await placeOrder(hl, a, newKey(), { ...BUY_AAPL, qty: 1 })).status).toBe(201);
      }
      const limited = await placeOrder(hl, a, newKey(), { ...BUY_AAPL, qty: 1 });
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect((await counts(db, a.accountId)).orders).toBe(3);
      expect((await placeOrder(hl, b, newKey(), { ...BUY_AAPL, qty: 1 })).status).toBe(201);
      hl.clock.advance(61_000);
      await setQuote(hl, 'AAPL', '189.95', '190.00');
      expect((await placeOrder(hl, a, newKey(), { ...BUY_AAPL, qty: 1 })).status).toBe(201);
    } finally {
      await hl.close();
    }
  });

  it('the default limit is 30 per minute', async () => {
    const hd = await createOrdersHarness(db, { env: { ORDER_RATE_LIMIT_PER_MINUTE: undefined } });
    try {
      expect(hd.config.orderRateLimitPerMinute).toBe(30);
    } finally {
      await hd.close();
    }
  });
});

describe('8. no secrets in responses or logs', () => {
  it('no session token, password, cookie, SQL or stack trace appears in any response or log line', async () => {
    const hay = [...seen, ...h.logs].join('\n');
    // control: the scan sees things that ARE there
    expect(hay).toContain('IDEMPOTENCY_MISMATCH');
    expect(h.logs.join('\n')).toContain('order_placed');
    for (const secret of [
      alice.token,
      bob.token,
      VALID_PASSWORD,
      'vantage_session',
      'set-cookie',
    ]) {
      expect(hay, secret).not.toContain(secret);
    }
    for (const leak of [
      /\bSELECT\b/,
      /\bINSERT INTO\b/,
      /\bFROM orders\b/,
      /node_modules/,
      /\bat \S+ \(/,
      /password/i,
    ]) {
      expect(hay, String(leak)).not.toMatch(leak);
    }
    const audit = await db.migrator.query(
      `SELECT action, target_type, after FROM audit_logs WHERE action = 'ORDER_PLACED' LIMIT 5`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.rows)).not.toMatch(/token|password|cookie/i);
  });
});
