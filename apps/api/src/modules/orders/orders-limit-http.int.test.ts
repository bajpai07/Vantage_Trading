// M8b-1 T5/T7 over real HTTP and real Postgres: LIMIT orders, the cancel endpoint, previews with reserve and maxQty, the orders list
// filter, positions and the portfolio with reservations. The golden vectors E to I are the hand-verified strings of
// packages/engine/src/limit-orders.test.ts and apps/api/src/modules/trading/limit-orders.int.test.ts, here through the API with
// the matcher driven by the injected clock and the quote store. Every "must fail" has a control that succeeds.
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_ORIGIN, cookie } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import {
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
import { MatcherService } from '../trading/matcher.service.js';

let db: TestDatabase;
let h: Harness;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db, { env: { ORDER_PREVIEW_RATE_LIMIT_PER_MINUTE: '100000' } });
}, 120_000);
afterAll(async () => {
  await h?.close();
  await db?.dispose();
});

const dec = (s: unknown): string => parse(String(s)).toString();
const matcher = (): MatcherService => h.app.get(MatcherService);
const tick = async () => {
  const r = await matcher().runOnce();
  if (r === undefined) throw new Error('the matcher did not run');
  return r;
};
const quote = (bid: string, ask: string, over: { ageSeconds?: number } = {}) =>
  setQuote(h, 'BTC-USD', bid, ask, over);
const limitBtc = (
  side: 'BUY' | 'SELL',
  qty: unknown,
  limitPrice: unknown,
  over: Record<string, unknown> = {},
) => ({
  symbol: 'BTC-USD',
  side,
  type: 'LIMIT',
  qty,
  limitPrice,
  ...over,
});
const cancelHttp = (
  u: Pick<TestUser, 'token'>,
  id: string,
  key: string | undefined,
  origin: string | null = WEB_ORIGIN,
) => {
  let req = h.http.post(`/v1/orders/${id}/cancel`).set('Cookie', cookie(u.token));
  if (origin !== null) req = req.set('Origin', origin);
  if (key !== undefined) req = req.set('Idempotency-Key', key);
  return req.send();
};
const previewAs = (u: Pick<TestUser, 'token'>, body: unknown) =>
  h.http
    .post('/v1/orders/preview')
    .set('Cookie', cookie(u.token))
    .set('Origin', WEB_ORIGIN)
    .send(body as object);
const portfolio = async (u: TestUser) => (await getAs(h, u, '/v1/portfolio')).body;
const clean = async (u: TestUser): Promise<void> => {
  expect(await reconcileAccount(db.migrator, u.accountId)).toEqual([]);
};
const identity = (p: {
  exact: {
    cash: string;
    reservedUsd: string;
    costBasis: string;
    fees: string;
    realisedPnl: string;
  };
}): string =>
  parse(p.exact.cash)
    .add(parse(p.exact.reservedUsd))
    .add(parse(p.exact.costBasis))
    .add(parse(p.exact.fees))
    .sub(parse(p.exact.realisedPnl))
    .toString();

beforeAll(async () => {
  await quote('89990.00', '90010.00');
});

describe('golden vector E through HTTP: a resting BUY, then a fill below the limit by the matcher', () => {
  it('accept reserves 224.97475 (cash 9,775.02525, equity unchanged); the matcher fills at 89,894.93; cash 9,775.03793768', async () => {
    const u = await newUser(h, db, 'e');
    await quote('89990.00', '90010.00');
    const key = newKey();
    const r = await placeOrder(h, u, key, limitBtc('BUY', '0.0025', '89900.00', { tif: 'GTC' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'LIMIT',
      status: 'ACCEPTED',
      tif: 'GTC',
      qty: '0.0025',
      filledQty: '0',
      limitPrice: '89900.00',
      reservedUsd: '224.97475',
      version: 1,
      rejectCode: null,
      execution: null,
      expiresAt: '2027-02-08T15:00:00.000Z', // GTC: 2026-11-10T15:00Z + 90 days
    });
    const id = r.body.id as string;
    expect(dec(await cash(db, u.accountId))).toBe('9775.02525');
    const p1 = await portfolio(u);
    expect(p1.exact).toMatchObject({
      cash: '9775.02525',
      reservedUsd: '224.97475',
      equity: '10000.00',
      costBasis: '0.00',
    });
    expect(identity(p1)).toBe('10000'); // cash + reserved + costBasis + fees - realised
    expect(p1.reservedUsd).toBe('224.97'); // 2 dp at the edge, the exact value alongside
    await clean(u);

    // listed as open, not closed
    const open = await getAs(h, u, '/v1/orders?status=open');
    expect(open.body.orders.map((o: { id: string }) => o.id)).toEqual([id]);
    expect((await getAs(h, u, '/v1/orders?status=closed')).body.orders).toEqual([]);
    expect((await getAs(h, u, '/v1/orders?status=all')).body.orders).toHaveLength(1);
    expect((await getAs(h, u, '/v1/orders')).body.orders).toHaveLength(1);

    // the matcher on a quote that does not cross: nothing happens (control)
    expect(await tick()).toMatchObject({ filled: 0, errors: 0 });
    // the quote crosses: 89,830.00 / 89,850.00
    await quote('89830.00', '89850.00');
    const t = await tick();
    expect(t.filled).toBeGreaterThanOrEqual(1);
    const got = await getAs(h, u, `/v1/orders/${id}`);
    expect(got.body).toMatchObject({
      status: 'FILLED',
      filledQty: '0.0025',
      reservedUsd: '0.00',
      version: 2,
      execution: {
        price: '89894.93',
        notional: '224.737325',
        fee: '0.22473732',
        quoteSource: 'FIXTURE',
      },
    });
    expect(dec(await cash(db, u.accountId))).toBe('9775.03793768');
    const p2 = await portfolio(u);
    expect(p2.exact).toMatchObject({
      cash: '9775.03793768',
      reservedUsd: '0.00',
      costBasis: '224.737325',
      fees: '0.22473732',
    });
    expect(identity(p2)).toBe('10000');
    expect((await getAs(h, u, '/v1/orders?status=closed')).body.orders).toHaveLength(1);
    await clean(u);
    await quote('89990.00', '90010.00');
  });
});

describe('golden vector F through HTTP: marketable at accept fills in the same request (D-97)', () => {
  it('quote 89,880.00 / 89,899.00: 201 FILLED at the limit 89,900.00, reserve released through the fill, cash 9,775.02525', async () => {
    const u = await newUser(h, db, 'f');
    await quote('89880.00', '89899.00');
    const r = await placeOrder(h, u, newKey(), limitBtc('BUY', '0.0025', '89900.00'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'FILLED',
      reservedUsd: '0.00',
      version: 2,
      execution: { price: '89900.00', notional: '224.75', fee: '0.22475' },
    });
    expect(dec(await cash(db, u.accountId))).toBe('9775.02525');
    const kinds = await db.migrator.query<{ kind: string }>(
      `SELECT kind::text FROM ledger_transactions WHERE account_id = $1::uuid`,
      [u.accountId],
    );
    expect(kinds.rows.map((x) => x.kind).sort()).toEqual(['FILL', 'GRANT', 'ORDER_RESERVE']);
    expect(identity(await portfolio(u))).toBe('10000');
    await clean(u);
    await quote('89990.00', '90010.00');
  });
});

describe('golden vector G through HTTP: a resting SELL, free quantity, then a fill above the limit', () => {
  it('SELL 0.001 LIMIT 90,100.00 reserves quantity only; a market SELL cannot use it; the fill realises +0.04499', async () => {
    const u = await newUser(h, db, 'g');
    await quote('89990.00', '90010.00');
    // the vector-B-style lot, through the API: BUY 0.0025 then SELL 0.001
    expect(
      (
        await placeOrder(h, u, newKey(), {
          symbol: 'BTC-USD',
          side: 'BUY',
          type: 'MARKET',
          qty: '0.0025',
          referencePrice: '90010.00',
        })
      ).body.status,
    ).toBe('FILLED');
    expect(
      (
        await placeOrder(h, u, newKey(), {
          symbol: 'BTC-USD',
          side: 'SELL',
          type: 'MARKET',
          qty: '0.001',
          referencePrice: '89990.00',
        })
      ).body.status,
    ).toBe('FILLED');
    const cash0 = dec(await cash(db, u.accountId));
    const r = await placeOrder(h, u, newKey(), limitBtc('SELL', '0.001', '90100.00'));
    expect(r.body).toMatchObject({
      status: 'ACCEPTED',
      reservedUsd: '0.00',
      limitPrice: '90100.00',
    });
    expect(dec(await cash(db, u.accountId))).toBe(cash0); // a SELL reserves quantity, no cash moves
    const pos = (await getAs(h, u, '/v1/positions')).body.positions;
    expect(pos).toEqual([
      {
        symbol: 'BTC-USD',
        qty: '0.0015',
        qtyReserved: '0.001',
        qtyAvailable: '0.0005',
        avgCost: '90055.01',
      },
    ]);
    const pf = await portfolio(u);
    expect(pf.positions[0]).toMatchObject({
      qty: '0.0015',
      qtyReserved: '0.001',
      qtyAvailable: '0.0005',
    });
    await clean(u);

    // D-96: a MARKET sell may only use the free quantity (control: 0.0005 is fine)
    const m = await placeOrder(h, u, newKey(), {
      symbol: 'BTC-USD',
      side: 'SELL',
      type: 'MARKET',
      qty: '0.0006',
      referencePrice: '89990.00',
    });
    expect(m.body).toMatchObject({ status: 'REJECTED', rejectCode: 'INSUFFICIENT_POSITION' });
    const pv = await previewAs(u, {
      symbol: 'BTC-USD',
      side: 'SELL',
      type: 'MARKET',
      qty: '0.0001',
      referencePrice: '89990.00',
    });
    expect(pv.body.maxQty).toBe('0.0005'); // the FREE quantity, not the whole position

    await quote('90120.00', '90140.00');
    expect((await tick()).filled).toBeGreaterThanOrEqual(1);
    const got = await getAs(h, u, `/v1/orders/${r.body.id as string}`);
    expect(got.body).toMatchObject({
      status: 'FILLED',
      execution: { price: '90100.00', notional: '90.10', fee: '0.0901' },
    });
    expect((await getAs(h, u, '/v1/positions')).body.positions).toEqual([
      {
        symbol: 'BTC-USD',
        qty: '0.0005',
        qtyReserved: '0',
        qtyAvailable: '0.0005',
        avgCost: '90055.01',
      },
    ]);
    const after = await portfolio(u);
    expect(after.exact.realisedPnl).toBe('-0.06502'); // -0.11001 (vector B) + 0.04499
    expect(identity(after)).toBe('10000');
    await clean(u);
    await quote('89990.00', '90010.00');
  });
});

describe('golden vector H through HTTP: cancel and expire release exactly', () => {
  it('cancel: 200 with the order and what was released, cash back to 10,000.00; a replay returns the stored answer; a second cancel is 409', async () => {
    const u = await newUser(h, db, 'h');
    await quote('89990.00', '90010.00');
    const placed = await placeOrder(h, u, newKey(), limitBtc('BUY', '0.0025', '89900.00'));
    const id = placed.body.id as string;
    const key = newKey();
    const c = await cancelHttp(u, id, key);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({
      id,
      status: 'CANCELLED',
      reservedUsd: '0.00',
      version: 2,
      released: { usd: '224.97475', qty: '0' },
    });
    expect(dec(await cash(db, u.accountId))).toBe('10000');
    expect((await portfolio(u)).exact).toMatchObject({
      cash: '10000.00',
      reservedUsd: '0.00',
      equity: '10000.00',
    });
    await clean(u);
    // the same key and order again: the stored answer, nothing happens twice
    const again = await cancelHttp(u, id, key);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(c.body);
    expect(dec(await cash(db, u.accountId))).toBe('10000');
    // another key on the now-cancelled order: 409 ORDER_NOT_OPEN
    const second = await cancelHttp(u, id, newKey());
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ORDER_NOT_OPEN');
    // the same key for a different request is a 422
    const placed2 = await placeOrder(h, u, newKey(), limitBtc('BUY', '0.001', '89900.00'));
    const mismatch = await cancelHttp(u, placed2.body.id as string, key);
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect((await cancelHttp(u, placed2.body.id as string, newKey())).status).toBe(200); // tidy: no resting order is left
    await clean(u);
  });

  it("cancel needs an Idempotency-Key (400), the right Origin (403), a session (401), and another user's order is 404 (control: the owner can)", async () => {
    const owner = await newUser(h, db, 'own');
    const other = await newUser(h, db, 'oth');
    await quote('89990.00', '90010.00');
    const id = (await placeOrder(h, owner, newKey(), limitBtc('BUY', '0.0025', '89900.00'))).body
      .id as string;
    expect((await cancelHttp(owner, id, undefined)).status).toBe(400);
    expect((await cancelHttp(owner, id, 'short')).status).toBe(400);
    expect((await cancelHttp(owner, id, newKey(), 'http://evil.example')).status).toBe(403);
    expect(
      (
        await h.http
          .post(`/v1/orders/${id}/cancel`)
          .set('Origin', WEB_ORIGIN)
          .set('Idempotency-Key', newKey())
          .send()
      ).status,
    ).toBe(401);
    const nf = await cancelHttp(other, id, newKey());
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('ORDER_NOT_FOUND');
    const unknown = await cancelHttp(other, '0198d0d0-0000-7000-8000-000000000000', newKey());
    expect(unknown.status).toBe(404);
    expect([unknown.body.error.code, unknown.body.error.message]).toEqual([
      nf.body.error.code,
      nf.body.error.message,
    ]); // the same answer: nothing is leaked
    expect((await getAs(h, owner, `/v1/orders/${id}`)).body.status).toBe('ACCEPTED'); // untouched by the failed attempts
    expect((await cancelHttp(owner, id, newKey())).status).toBe(200); // control
    await clean(owner);
  });

  it('expiry: a DAY crypto order expires at the next 00:00 UTC, a DAY stock order at the session close; the matcher releases the reserve', async () => {
    const u = await newUser(h, db, 'exp');
    await quote('89990.00', '90010.00');
    await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
    const crypto = await placeOrder(
      h,
      u,
      newKey(),
      limitBtc('BUY', '0.0025', '89900.00', { tif: 'DAY' }),
    );
    expect(crypto.body.expiresAt).toBe('2026-11-11T00:00:00.000Z'); // the next 00:00 UTC (an illustrative rule for crypto)
    const stock = await placeOrder(h, u, newKey(), {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'LIMIT',
      qty: '5',
      limitPrice: '180.00',
      tif: 'DAY',
    });
    expect(stock.body).toMatchObject({
      status: 'ACCEPTED',
      reservedUsd: '900.00',
      expiresAt: '2026-11-10T21:00:00.000Z',
    }); // Tuesday 16:00 New York = 21:00Z
    expect(dec(await cash(db, u.accountId))).toBe('8875.02525'); // 10000 - 224.97475 - 900
    // before the expiry the matcher expires nothing (control)
    expect((await tick()).expired).toBe(0);
    h.clock.set('2026-11-10T21:00:01.000Z'); // just after the stock's close
    await quote('89990.00', '90010.00');
    expect((await tick()).expired).toBe(1);
    expect((await getAs(h, u, `/v1/orders/${stock.body.id as string}`)).body).toMatchObject({
      status: 'EXPIRED',
      reservedUsd: '0.00',
      version: 2,
    });
    expect((await getAs(h, u, `/v1/orders/${crypto.body.id as string}`)).body.status).toBe(
      'ACCEPTED',
    );
    h.clock.set('2026-11-11T00:00:01.000Z');
    await quote('89990.00', '90010.00');
    expect((await tick()).expired).toBeGreaterThanOrEqual(1); // (other tests' resting DAY orders expire here too)
    expect((await getAs(h, u, `/v1/orders/${crypto.body.id as string}`)).body).toMatchObject({
      status: 'EXPIRED',
      reservedUsd: '0.00',
    });
    expect(dec(await cash(db, u.accountId))).toBe('10000');
    expect((await getAs(h, u, '/v1/orders?status=closed')).body.orders).toHaveLength(2);
    await clean(u);
    h.clock.set(OPEN_TIME);
    await quote('89990.00', '90010.00');
  });
});

describe('golden vector I through HTTP: a stale quote is not evaluated, and there is no back-fill', () => {
  it('a quote that satisfies the limit but is STALE does not fill; a FRESH quote fills at that quote (89,754.86)', async () => {
    const u = await newUser(h, db, 'i');
    await quote('89990.00', '90010.00');
    const r = await placeOrder(h, u, newKey(), limitBtc('BUY', '0.0025', '89900.00'));
    const id = r.body.id as string;
    await quote('89830.00', '89850.00', { ageSeconds: 100_000 }); // far too old: STALE
    const stale = await tick();
    expect(stale.notEvaluable).toBeGreaterThanOrEqual(1);
    expect((await getAs(h, u, `/v1/orders/${id}`)).body.status).toBe('ACCEPTED');
    expect(dec(await cash(db, u.accountId))).toBe('9775.02525');
    await quote('89700.00', '89710.00'); // fresh
    await tick();
    const got = await getAs(h, u, `/v1/orders/${id}`);
    expect(got.body).toMatchObject({ status: 'FILLED', execution: { price: '89754.86' } });
    await clean(u);
    await quote('89990.00', '90010.00');
  });

  it('a limit order placed on a stale quote is accepted and rests ("will be evaluated when the quote is live")', async () => {
    const u = await newUser(h, db, 'i2');
    await quote('89830.00', '89850.00', { ageSeconds: 100_000 });
    const r = await placeOrder(h, u, newKey(), limitBtc('BUY', '0.0025', '89900.00'));
    expect(r.body).toMatchObject({ status: 'ACCEPTED', reservedUsd: '224.97475' }); // crosses, but the quote is stale: it rests
    await quote('89990.00', '90010.00');
    await clean(u);
  });
});

describe('validation, rejects (persisted, nothing moves) and idempotency', () => {
  it('stop orders, IOC/FOK, a limit price on a MARKET order and a missing limit price are 400s with a clear message; nothing is stored', async () => {
    const u = await newUser(h, db, 'val');
    const before = await counts(db, u.accountId);
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        'STOP',
        { symbol: 'BTC-USD', side: 'BUY', type: 'STOP', qty: '0.001', limitPrice: '89900' },
        /MARKET or LIMIT/,
      ],
      [
        'STOP_LIMIT',
        { symbol: 'BTC-USD', side: 'BUY', type: 'STOP_LIMIT', qty: '0.001', limitPrice: '89900' },
        /MARKET or LIMIT/,
      ],
      ['IOC', limitBtc('BUY', '0.001', '89900', { tif: 'IOC' }), /DAY or GTC/],
      ['FOK', limitBtc('BUY', '0.001', '89900', { tif: 'FOK' }), /DAY or GTC/],
      [
        'limit on MARKET',
        {
          symbol: 'BTC-USD',
          side: 'BUY',
          type: 'MARKET',
          qty: '0.001',
          referencePrice: '90010.00',
          limitPrice: '89900',
        },
        /./,
      ],
      ['no limit price', { symbol: 'BTC-USD', side: 'BUY', type: 'LIMIT', qty: '0.001' }, /./],
      ['numeric limit price', limitBtc('BUY', '0.001', 89900), /./],
    ];
    for (const [name, body, msg] of cases) {
      const r = await placeOrder(h, u, newKey(), body);
      expect(r.status, name).toBe(400);
      expect(r.body.error.code, name).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(r.body.error), name).toMatch(msg);
      expect((await previewAs(u, body)).status, `${name} preview`).toBe(400);
    }
    expect(await counts(db, u.accountId)).toEqual(before);
    // control: the valid limit order passes
    expect((await placeOrder(h, u, newKey(), limitBtc('BUY', '0.001', '89900'))).status).toBe(201);
  });

  it('TICK_VIOLATION is a persisted REJECTED order (control: a tick multiple rests)', async () => {
    const u = await newUser(h, db, 'tick');
    await quote('89990.00', '90010.00');
    const before = dec(await cash(db, u.accountId));
    const r = await placeOrder(h, u, newKey(), limitBtc('BUY', '0.0025', '89900.005'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'REJECTED',
      rejectCode: 'TICK_VIOLATION',
      reservedUsd: '0.00',
      expiresAt: null,
    });
    expect(dec(await cash(db, u.accountId))).toBe(before);
    const pv = await previewAs(u, limitBtc('BUY', '0.0025', '89900.005'));
    expect(pv.body).toMatchObject({ wouldFill: false, rejectCode: 'TICK_VIOLATION', maxQty: null });
    expect(
      (await placeOrder(h, u, newKey(), limitBtc('BUY', '0.0025', '89900.01'))).body.status,
    ).toBe('ACCEPTED');
    await clean(u);
  });

  it('buying power is FREE cash: the reserve already held by an open order is not available to a second order', async () => {
    const u = await newUser(h, db, 'bp');
    await quote('89990.00', '90010.00');
    // 10,000.00 cash: first reserve exactly what leaves 0.00000001 less than a second order needs
    // order 1: qty q1 at limit L reserves R1; order 2 must be rejected when cash - R1 < R2 by one unit and accepted at equality
    const first = await placeOrder(h, u, newKey(), limitBtc('BUY', '0.1', '89900.00')); // R = 8,990 + 8.99 = 8,998.99
    expect(first.body.reservedUsd).toBe('8998.99');
    // free cash is now 1,001.01; 0.0111 BTC reserves 997.89 + 0.99789 = 998.88789; 0.0112 reserves 1,006.88 + ... too much
    const fits = await placeOrder(h, u, newKey(), limitBtc('BUY', '0.0111', '89900.00'));
    expect(fits.body.status).toBe('ACCEPTED');
    const over = await placeOrder(h, u, newKey(), limitBtc('BUY', '0.0112', '89900.00'));
    expect(over.body).toMatchObject({
      status: 'REJECTED',
      rejectCode: 'INSUFFICIENT_BUYING_POWER',
    });
    await clean(u);
  });

  it('100 duplicate placements with one Idempotency-Key make one order and one reserve; the same key with another body is 422', async () => {
    const u = await newUser(h, db, 'dup');
    await quote('89990.00', '90010.00');
    const key = newKey();
    const body = limitBtc('BUY', '0.0025', '89900.00');
    const rs = await Promise.all(Array.from({ length: 100 }, () => placeOrder(h, u, key, body)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => (r.body as { id: string }).id)).size).toBe(1);
    expect((await counts(db, u.accountId)).orders).toBe(1);
    const reserve = await db.migrator.query(
      `SELECT 1 FROM ledger_transactions WHERE account_id = $1::uuid AND kind = 'ORDER_RESERVE'`,
      [u.accountId],
    );
    expect(reserve.rowCount).toBe(1);
    expect(dec(await cash(db, u.accountId))).toBe('9775.02525');
    const mismatch = await placeOrder(h, u, key, limitBtc('BUY', '0.0025', '89900.01'));
    expect(mismatch.status).toBe(422);
    // the same limit price spelled differently is the SAME request (canonical spelling)
    const same = await placeOrder(h, u, key, limitBtc('BUY', '0.00250', '89900'));
    expect(same.status).toBe(201);
    expect(same.body.id).toBe(rs[0]?.body.id);
    await clean(u);
  }, 120_000);

  it('100 duplicate cancels with one key make exactly one cancel and one release', async () => {
    const u = await newUser(h, db, 'dupc');
    await quote('89990.00', '90010.00');
    const id = (await placeOrder(h, u, newKey(), limitBtc('BUY', '0.0025', '89900.00'))).body
      .id as string;
    const key = newKey();
    const rs = await Promise.all(Array.from({ length: 100 }, () => cancelHttp(u, id, key)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.every((r) => r.body.status === 'CANCELLED')).toBe(true);
    const rel = await db.migrator.query(
      `SELECT 1 FROM ledger_transactions WHERE account_id = $1::uuid AND kind = 'ORDER_RELEASE'`,
      [u.accountId],
    );
    expect(rel.rowCount).toBe(1);
    expect(dec(await cash(db, u.accountId))).toBe('10000');
    await clean(u);
  }, 120_000);

  it('a cancel and a fill raced over HTTP end in exactly one state (control: both interleavings leave reconcile clean)', async () => {
    for (let i = 0; i < 15; i += 1) {
      const u = await newUser(h, db, 'race');
      await quote('89990.00', '90010.00');
      const id = (await placeOrder(h, u, newKey(), limitBtc('BUY', '0.0025', '89900.00'))).body
        .id as string;
      await quote('89830.00', '89850.00');
      const [c] = await Promise.all([cancelHttp(u, id, newKey()), matcher().runOnce()]);
      const final = (await getAs(h, u, `/v1/orders/${id}`)).body;
      expect(['FILLED', 'CANCELLED']).toContain(final.status);
      expect(c.status === 200).toBe(final.status === 'CANCELLED'); // a successful cancel <=> CANCELLED, otherwise 409
      if (final.status === 'FILLED') expect(c.status).toBe(409);
      expect(parse(final.reservedUsd).toString()).toBe('0');
      await clean(u);
    }
    await quote('89990.00', '90010.00');
  }, 120_000);

  it('an instrument without the MVP gate rejects a limit order too (INSTRUMENT_NOT_TRADABLE), and nothing moves', async () => {
    const u = await newUser(h, db, 'nt');
    await quote('89990.00', '90010.00');
    await db.migrator.query(`UPDATE instruments SET tradable_in = '{}' WHERE symbol = 'ETH-USD'`);
    try {
      await setQuote(h, 'ETH-USD', '3000.00', '3001.00');
      const r = await placeOrder(h, u, newKey(), {
        symbol: 'ETH-USD',
        side: 'BUY',
        type: 'LIMIT',
        qty: '0.1',
        limitPrice: '2900.00',
      });
      expect(r.body).toMatchObject({ status: 'REJECTED', rejectCode: 'INSTRUMENT_NOT_TRADABLE' });
    } finally {
      await db.migrator.query(
        `UPDATE instruments SET tradable_in = '{MVP}' WHERE symbol = 'ETH-USD'`,
      );
    }
    await setQuote(h, 'ETH-USD', '3000.00', '3001.00');
    expect(
      (
        await placeOrder(h, u, newKey(), {
          symbol: 'ETH-USD',
          side: 'BUY',
          type: 'LIMIT',
          qty: '0.1',
          limitPrice: '2900.00',
        })
      ).body.status,
    ).toBe('ACCEPTED'); // control
    await clean(u);
  });
});

describe('preview of a LIMIT order and maxQty (the RESERVE formula)', () => {
  it('reports the reserve, marketable, the fill if marketable, the cash after the reserve, the expiry and a maxQty that is accepted while maxQty + step is not', async () => {
    const u = await newUser(h, db, 'pv');
    await quote('89990.00', '90010.00');
    const resting = await previewAs(u, limitBtc('BUY', '0.0025', '89900.00', { tif: 'GTC' }));
    expect(resting.status).toBe(200);
    expect(resting.body).toMatchObject({
      wouldFill: false,
      rejectCode: null,
      marketable: false,
      reserveUsd: '224.97475',
      estimatedPrice: null,
      estimatedCashAfter: '9775.02525', // 10,000 - 224.97475
      expiresAt: '2027-02-08T15:00:00.000Z',
    });
    // a marketable one would fill now: 89,899.00 ask <= 89,900.00
    await quote('89880.00', '89899.00');
    const now = await previewAs(u, limitBtc('BUY', '0.0025', '89900.00'));
    expect(now.body).toMatchObject({
      wouldFill: true,
      marketable: true,
      reserveUsd: '224.97475',
      estimatedPrice: '89900.00',
      estimatedNotional: '224.75',
      estimatedFee: '0.22475',
      estimatedCashAfter: '9775.02525', // 10,000 - 224.75 - 0.22475
      expiresAt: null,
    });
    await quote('89990.00', '90010.00');

    // maxQty: the largest q whose reserve fits 10,000.00, found here by an independent BigInt search
    const U = 100_000_000n;
    const reserveOf = (qU: bigint): bigint => {
      const maxNotional = (qU * 89_900n * U + U - 1n) / U; // ceil8(q x 89,900.00) in units of 1e-8: q(1e-8) x 89,900 exact
      const fee = (() => {
        const num = maxNotional * 10n;
        let q = num / 10_000n;
        const twice = (num % 10_000n) * 2n;
        if (twice > 10_000n || (twice === 10_000n && q % 2n === 1n)) q += 1n;
        return q;
      })();
      return maxNotional + fee;
    };
    let lo = 0n;
    let hi = 100_000_000n; // up to 1 coin
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (reserveOf(mid) <= 10_000n * U) lo = mid;
      else hi = mid - 1n;
    }
    const text = (x: bigint): string =>
      `${(x / U).toString()}.${(x % U).toString().padStart(8, '0')}`
        .replace(/0+$/, '')
        .replace(/\.$/, '');
    const expected = text(lo);
    const pv = await previewAs(u, limitBtc('BUY', '0.001', '89900.00'));
    expect(pv.body.maxQty).toBe(expected);
    // maxQty is accepted ...
    const ok = await placeOrder(h, u, newKey(), limitBtc('BUY', expected, '89900.00'));
    expect(ok.body.status).toBe('ACCEPTED');
    // ... and maxQty + one step is rejected (on a fresh account with the same cash)
    const v = await newUser(h, db, 'pv2');
    const over = await placeOrder(h, v, newKey(), limitBtc('BUY', text(lo + 1n), '89900.00'));
    expect(over.body).toMatchObject({
      status: 'REJECTED',
      rejectCode: 'INSUFFICIENT_BUYING_POWER',
    });
    await clean(u);
    await clean(v);
  });

  it('SELL maxQty is the FREE quantity (position minus reserved); it is accepted and one step more is rejected', async () => {
    const u = await newUser(h, db, 'pvs');
    await quote('89990.00', '90010.00');
    await placeOrder(h, u, newKey(), {
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'MARKET',
      qty: '0.002',
      referencePrice: '90010.00',
    });
    await placeOrder(h, u, newKey(), limitBtc('SELL', '0.0012', '90100.00'));
    const pv = await previewAs(u, limitBtc('SELL', '0.0001', '90100.00'));
    expect(pv.body).toMatchObject({ reserveUsd: '0.00', marketable: false, maxQty: '0.0008' }); // 0.002 - 0.0012
    expect(
      (await placeOrder(h, u, newKey(), limitBtc('SELL', '0.0008', '90100.00'))).body.status,
    ).toBe('ACCEPTED');
    const over = await placeOrder(h, u, newKey(), limitBtc('SELL', '0.00000001', '90100.00'));
    expect(over.body).toMatchObject({ status: 'REJECTED', rejectCode: 'INSUFFICIENT_POSITION' });
    await clean(u);
  });

  it('a preview writes nothing and holds no reservation', async () => {
    const u = await newUser(h, db, 'pvn');
    await quote('89990.00', '90010.00');
    const before = {
      counts: await counts(db, u.accountId),
      cash: dec(await cash(db, u.accountId)),
    };
    for (let i = 0; i < 5; i += 1) await previewAs(u, limitBtc('BUY', '0.0025', '89900.00'));
    expect({
      counts: await counts(db, u.accountId),
      cash: dec(await cash(db, u.accountId)),
    }).toEqual(before);
    await clean(u);
  });
});

describe('equity includes RESERVED and the identity is exact for a mixed account with open orders', () => {
  it('a stock and a crypto position, a resting stock BUY and a resting crypto SELL: cash + reserved + costBasis + fees - realised = 10,000 at every step', async () => {
    const u = await newUser(h, db, 'mix');
    await quote('89990.00', '90010.00');
    await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
    const steps: Array<[string, () => Promise<unknown>]> = [
      [
        'market buy AAPL 7',
        () =>
          placeOrder(h, u, newKey(), {
            symbol: 'AAPL',
            side: 'BUY',
            type: 'MARKET',
            qty: '7',
            referencePrice: '190.00',
          }),
      ],
      [
        'market buy BTC 0.0031',
        () =>
          placeOrder(h, u, newKey(), {
            symbol: 'BTC-USD',
            side: 'BUY',
            type: 'MARKET',
            qty: '0.0031',
            referencePrice: '90010.00',
          }),
      ],
      [
        'limit buy AAPL 5 @ 180',
        () =>
          placeOrder(h, u, newKey(), {
            symbol: 'AAPL',
            side: 'BUY',
            type: 'LIMIT',
            qty: '5',
            limitPrice: '180.00',
            tif: 'GTC',
          }),
      ],
      [
        'limit sell BTC 0.002 @ 90100',
        () => placeOrder(h, u, newKey(), limitBtc('SELL', '0.002', '90100.00')),
      ],
      [
        'limit buy BTC 0.0077 @ 89000',
        () => placeOrder(h, u, newKey(), limitBtc('BUY', '0.0077', '89000.00')),
      ],
      [
        'market sell AAPL 3',
        () =>
          placeOrder(h, u, newKey(), {
            symbol: 'AAPL',
            side: 'SELL',
            type: 'MARKET',
            qty: '3',
            referencePrice: '189.95',
          }),
      ],
    ];
    for (const [label, fn] of steps) {
      await fn();
      const p = await portfolio(u);
      expect(identity(p), label).toBe('10000');
      await clean(u);
    }
    const p = await portfolio(u);
    expect(parse(p.exact.reservedUsd).sign()).toBe(1); // two reservations are held
    // equity = cash + reserved + positions at the bid
    expect(parse(p.exact.equity).toString()).toBe(
      parse(p.exact.cash)
        .add(parse(p.exact.reservedUsd))
        .add(parse(p.exact.positionsValue))
        .toString(),
    );
    // the open orders cancel one by one and the identity holds after each
    const open = (await getAs(h, u, '/v1/orders?status=open')).body.orders as Array<{ id: string }>;
    expect(open).toHaveLength(3);
    for (const o of open) {
      expect((await cancelHttp(u, o.id, newKey())).status).toBe(200);
      expect(identity(await portfolio(u))).toBe('10000');
      await clean(u);
    }
    expect((await portfolio(u)).exact.reservedUsd).toBe('0.00');
  });
});
