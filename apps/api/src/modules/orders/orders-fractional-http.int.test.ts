// M8 over real HTTP and real Postgres: fractional crypto orders, decimal quantity validation, the server-computed maxQty,
// positions and the portfolio with fractional quantities, and the equity identity for mixed accounts. The golden vectors
// A, B and C are the hand-verified strings of packages/engine/src/fractional.test.ts, here through the API.
import { ORDER_PREVIEW_DISCLAIMER } from '@vantage/contracts';
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_ORIGIN, cookie } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import {
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
beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db, { env: { ORDER_PREVIEW_RATE_LIMIT_PER_MINUTE: '100000' } });
  await setQuote(h, 'BTC-USD', '89990.00', '90010.00');
  await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
}, 120_000);
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const btcOrder = (side: 'BUY' | 'SELL', qty: unknown, over: Record<string, unknown> = {}) => ({
  symbol: 'BTC-USD',
  side,
  type: 'MARKET',
  qty,
  referencePrice: side === 'BUY' ? '90010.00' : '89990.00',
  ...over,
});
const previewAs = (u: Pick<TestUser, 'token'>, body: unknown) =>
  h.http
    .post('/v1/orders/preview')
    .set('Cookie', cookie(u.token))
    .set('Origin', WEB_ORIGIN)
    .send(body as object);
const clean = async (u: TestUser): Promise<void> => {
  expect(await reconcileAccount(db.migrator, u.accountId)).toEqual([]);
};
const portfolio = async (u: TestUser) => (await getAs(h, u, '/v1/portfolio')).body;

/** cash + costBasis + fees - realisedPnl from the exact fields, as a string. */
const identity = (p: {
  exact: { cash: string; costBasis: string; fees: string; realisedPnl: string };
}): string =>
  parse(p.exact.cash)
    .add(parse(p.exact.costBasis))
    .add(parse(p.exact.fees))
    .sub(parse(p.exact.realisedPnl))
    .toString();

describe('1. golden vectors A, B, C through the HTTP API (exact strings)', () => {
  it('A: BUY 0.0025, B: SELL 0.001, C: SELL 0.0015: orders, executions, positions, portfolio and balances to the digit', async () => {
    const u = await newUser(h, db, 'vec');

    // ---- A ----
    const a = await placeOrder(h, u, newKey(), btcOrder('BUY', '0.0025'));
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({
      symbol: 'BTC-USD',
      side: 'BUY',
      status: 'FILLED',
      qty: '0.0025',
      filledQty: '0.0025',
      rejectCode: null,
      execution: {
        qty: '0.0025',
        price: '90055.01',
        notional: '225.137525',
        fee: '0.22513752',
        slippageBps: '5',
      },
    });
    expect(await cash(db, u.accountId)).toBe('9774.6373374800');
    const pos = await getAs(h, u, '/v1/positions');
    expect(pos.body.positions).toEqual([{ symbol: 'BTC-USD', qty: '0.0025', avgCost: '90055.01' }]);
    const lotA = await db.migrator.query(
      `SELECT qty_open, cost_remaining FROM position_lots WHERE account_id = $1::uuid`,
      [u.accountId],
    );
    expect(
      lotA.rows.map((r) => [parse(r.qty_open).toString(), parse(r.cost_remaining).toString()]),
    ).toEqual([['0.0025', '225.137525']]);
    const pa = await portfolio(u);
    expect(pa.exact).toMatchObject({
      cash: '9774.63733748',
      costBasis: '225.137525',
      fees: '0.22513752',
      realisedPnl: '0.00',
      positionsValue: '224.975', // 0.0025 x the bid 89,990.00
      unrealisedPnl: '-0.162525', // 224.975 - 225.137525
      equity: '9999.61233748', // 9,774.63733748 + 224.975
    });
    expect(identity(pa)).toBe('10000'); // 9,774.63733748 + 225.137525 + 0.22513752 - 0
    expect(pa.positions[0]).toMatchObject({
      symbol: 'BTC-USD',
      qty: '0.0025',
      avgCost: '90055.01',
      valuation: 'VALUED',
    });
    await clean(u);

    // ---- B ----
    const b = await placeOrder(h, u, newKey(), btcOrder('SELL', '0.001'));
    expect(b.body).toMatchObject({
      status: 'FILLED',
      qty: '0.001',
      execution: { price: '89945.00', notional: '89.945', fee: '0.089945' },
    });
    expect(await cash(db, u.accountId)).toBe('9864.4923924800');
    const pb = await portfolio(u);
    expect(pb.exact).toMatchObject({
      cash: '9864.49239248',
      costBasis: '135.082515', // the remaining lot cost
      fees: '0.31508252',
      realisedPnl: '-0.11001',
    });
    expect(identity(pb)).toBe('10000');
    expect((await getAs(h, u, '/v1/positions')).body.positions).toEqual([
      { symbol: 'BTC-USD', qty: '0.0015', avgCost: '90055.01' },
    ]);
    const ex = await getAs(h, u, '/v1/executions');
    const sellExec = ex.body.executions.find((e: { side: string }) => e.side === 'SELL');
    expect(sellExec).toMatchObject({ qty: '0.001', price: '89945.00' });
    await clean(u);

    // ---- C ----
    const c = await placeOrder(h, u, newKey(), btcOrder('SELL', '0.0015'));
    expect(c.body).toMatchObject({
      status: 'FILLED',
      qty: '0.0015',
      execution: { price: '89945.00', notional: '134.9175', fee: '0.1349175' },
    });
    expect(await cash(db, u.accountId)).toBe('9999.2749749800');
    const pc = await portfolio(u);
    expect(pc.exact).toMatchObject({
      cash: '9999.27497498',
      costBasis: '0.00',
      fees: '0.45000002',
      realisedPnl: '-0.275025',
      positionsValue: '0.00',
    });
    expect(identity(pc)).toBe('10000'); // 9,999.27497498 + 0 + 0.45000002 + 0.275025
    expect(pc.positions).toEqual([]);
    expect((await getAs(h, u, '/v1/positions')).body.positions).toEqual([]);
    // the order list shows fractional quantities exactly as stored, newest first
    const list = await getAs(h, u, '/v1/orders');
    expect(list.body.orders.map((o: { qty: string }) => o.qty)).toEqual([
      '0.0015',
      '0.001',
      '0.0025',
    ]);
    await clean(u);
  });

  it('the stored order is exactly what the POST returned (GET /v1/orders/:id), fractional quantity included', async () => {
    const u = await newUser(h, db, 'get');
    const post = await placeOrder(h, u, newKey(), btcOrder('BUY', '0.00123457'));
    const got = await getAs(h, u, `/v1/orders/${post.body.id as string}`);
    expect(got.body).toEqual(post.body);
    expect(got.body.qty).toBe('0.00123457');
  });
});

describe('2. decimal quantity validation: bad quantities are 400, never an order', () => {
  it.each([
    ['exponent', '1e-3'],
    ['NaN', 'NaN'],
    ['negative', '-0.5'],
    ['nine decimals', '0.000000001'],
    ['leading dot', '.5'],
    ['trailing dot', '5.'],
    ['junk before', 'x0.5'],
    ['two dots', '0.5.5'],
    ['plus sign', '+0.5'],
    ['zero', '0.00000000'],
    ['above the maximum', '1000000.00000001'],
    ['a float number', 0.5],
  ])('qty %s is 400 VALIDATION_ERROR and stores nothing', async (_n, qty) => {
    const u = await newUser(h, db, 'val');
    const before = await counts(db, u.accountId);
    const r = await placeOrder(h, u, newKey(), btcOrder('BUY', qty));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(await counts(db, u.accountId)).toEqual(before);
    const p = await previewAs(u, btcOrder('BUY', qty));
    expect(p.status).toBe(400);
  });

  it('control: 0.00000001 and the maximum are accepted', async () => {
    const u = await newUser(h, db, 'ok');
    expect((await previewAs(u, btcOrder('BUY', '0.00000001'))).status).toBe(200);
    expect((await previewAs(u, btcOrder('BUY', '1000000'))).status).toBe(200);
  });

  it('a fractional stock quantity is a REJECTED order (QTY_STEP_VIOLATION), decided by the server; the whole quantity fills (control)', async () => {
    const u = await newUser(h, db, 'stk');
    const before = await cash(db, u.accountId);
    const r = await placeOrder(h, u, newKey(), {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      qty: '1.5',
      referencePrice: '190.00',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'REJECTED',
      rejectCode: 'QTY_STEP_VIOLATION',
      filledQty: '0',
      execution: null,
    });
    expect(await cash(db, u.accountId)).toBe(before);
    const p = await previewAs(u, {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      qty: '1.5',
      referencePrice: '190.00',
    });
    expect(p.body).toMatchObject({
      wouldFill: false,
      rejectCode: 'QTY_STEP_VIOLATION',
      estimatedPrice: null,
    });
    const ok = await placeOrder(h, u, newKey(), {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      qty: '2',
      referencePrice: '190.00',
    });
    expect(ok.body).toMatchObject({ status: 'FILLED', filledQty: '2' });
    await clean(u);
  });

  it('the same quantity has one spelling: "0.0025" and "0.00250000" are the same request (replay), a different quantity is 422', async () => {
    const u = await newUser(h, db, 'idem');
    const key = newKey();
    const first = await placeOrder(h, u, key, btcOrder('BUY', '0.0025'));
    const second = await placeOrder(h, u, key, btcOrder('BUY', '0.00250000'));
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect((await counts(db, u.accountId)).executions).toBe(1);
    const other = await placeOrder(h, u, key, btcOrder('BUY', '0.00250001'));
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });
});

describe('3. maxQty (D-90): the server computes it; the largest fills, one step more is rejected', () => {
  it('BUY: 10,000.00 buys 0.1109323 BTC-USD; that quantity fills and 0.11093231 is INSUFFICIENT_BUYING_POWER (hand-checked)', async () => {
    const u = await newUser(h, db, 'max1');
    const p = await previewAs(u, btcOrder('BUY', '0.001'));
    expect(p.status).toBe(200);
    expect(p.body.maxQty).toBe('0.1109323');
    expect(p.body.disclaimer).toBe(ORDER_PREVIEW_DISCLAIMER);
    // maxQty fills (a fresh account with exactly that cash would fill it too: here the same account fills it for real)
    const fills = await placeOrder(h, u, newKey(), btcOrder('BUY', p.body.maxQty));
    expect(fills.body).toMatchObject({ status: 'FILLED', filledQty: '0.1109323' });
    expect(parse(await cash(db, u.accountId)).sign()).toBeGreaterThanOrEqual(0);
    await clean(u);
    // one step more is rejected, on another account with the same cash
    const v = await newUser(h, db, 'max2');
    const over = await placeOrder(h, v, newKey(), btcOrder('BUY', '0.11093231'));
    expect(over.body).toMatchObject({
      status: 'REJECTED',
      rejectCode: 'INSUFFICIENT_BUYING_POWER',
    });
  });

  it('BUY of a stock: 52 shares (10,000 / 190.04); 52 fills, 53 is rejected', async () => {
    const u = await newUser(h, db, 'max3');
    const body = {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      qty: '1',
      referencePrice: '190.00',
    };
    const p = await previewAs(u, body);
    expect(p.body.maxQty).toBe('52');
    expect((await placeOrder(h, u, newKey(), { ...body, qty: '52' })).body.status).toBe('FILLED');
    const v = await newUser(h, db, 'max4');
    expect((await placeOrder(h, v, newKey(), { ...body, qty: '53' })).body).toMatchObject({
      status: 'REJECTED',
      rejectCode: 'INSUFFICIENT_BUYING_POWER',
    });
  });

  it('SELL: the position quantity; null/0 when there is nothing to sell or no usable quote', async () => {
    const u = await newUser(h, db, 'max5');
    expect((await previewAs(u, btcOrder('SELL', '0.001'))).body.maxQty).toBe('0'); // owns nothing
    await placeOrder(h, u, newKey(), btcOrder('BUY', '0.0025'));
    const p = await previewAs(u, btcOrder('SELL', '0.001'));
    expect(p.body.maxQty).toBe('0.0025');
    const all = await placeOrder(h, u, newKey(), btcOrder('SELL', p.body.maxQty));
    expect(all.body.status).toBe('FILLED'); // maxQty fills
    const over = await placeOrder(h, u, newKey(), btcOrder('SELL', '0.00000001'));
    expect(over.body).toMatchObject({ status: 'REJECTED', rejectCode: 'INSUFFICIENT_POSITION' }); // one step more
    await clean(u);
  });

  it('maxQty is null when the market state makes any order unfillable (stale quote), and it never trusts the client', async () => {
    const u = await newUser(h, db, 'max6');
    await setQuote(h, 'SOL-USD', '150.00', '150.10', { ageSeconds: 100_000 }); // far too old
    const p = await previewAs(u, {
      symbol: 'SOL-USD',
      side: 'BUY',
      type: 'MARKET',
      qty: '1',
      referencePrice: '150.10',
    });
    expect(p.body).toMatchObject({ wouldFill: false, maxQty: null });
    // a client-sent maxQty is an unknown field: 400
    const bad = await previewAs(u, { ...btcOrder('BUY', '0.001'), maxQty: '5' });
    expect(bad.status).toBe(400);
    // control: a fresh quote gives a value
    await setQuote(h, 'SOL-USD', '150.00', '150.10');
    const ok = await previewAs(u, {
      symbol: 'SOL-USD',
      side: 'BUY',
      type: 'MARKET',
      qty: '1',
      referencePrice: '150.10',
    });
    expect(typeof ok.body.maxQty).toBe('string');
  });
});

describe('4. the equity identity holds exactly for a mixed stock and crypto account', () => {
  it('cash + costBasis + fees - realisedPnl = 10,000 after every step of a mixed sequence (exact fields)', async () => {
    const u = await newUser(h, db, 'mix');
    const stock = (side: 'BUY' | 'SELL', qty: string) => ({
      symbol: 'AAPL',
      side,
      type: 'MARKET',
      qty,
      referencePrice: side === 'BUY' ? '190.00' : '189.95',
    });
    const steps: Array<[string, unknown]> = [
      ['stock buy 7', stock('BUY', '7')],
      ['crypto buy 0.0031', btcOrder('BUY', '0.0031')],
      ['crypto buy 0.00007777', btcOrder('BUY', '0.00007777')],
      ['stock sell 3', stock('SELL', '3')],
      ['crypto sell 0.002', btcOrder('SELL', '0.002')],
      ['crypto buy 0.0005', btcOrder('BUY', '0.0005')],
      ['crypto sell 0.00137777', btcOrder('SELL', '0.00137777')],
      ['stock sell 4', stock('SELL', '4')],
    ];
    for (const [label, body] of steps) {
      const r = await placeOrder(h, u, newKey(), body);
      expect(r.body.status, label).toBe('FILLED');
      const p = await portfolio(u);
      expect(identity(p), label).toBe('10000');
      await clean(u);
    }
  });
});
