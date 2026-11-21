// M8b-2 T2/T4 over real HTTP and real Postgres: the public depth route, the authenticated my-orders route, the freshness rule
// (D-100), the bounded cache and the cost-based limiter (D-101), and the exact-comparison placement of the caller's own orders
// (D-102). Golden vector J (BTC-USD bid 89,990.00 / ask 90,010.00, levelStep 9.64) is the hand-verified ladder of
// packages/engine/src/depth.test.ts, here through the API. Every "must fail" has a control that succeeds.
import { DEPTH_NOTE, DepthResponse, MyDepthOrdersResponse } from '@vantage/contracts';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookie } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import {
  createOrdersHarness,
  getAs,
  newKey,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import { DEPTH_CACHE_MAX, DepthService } from './depth.service.js';

let db: TestDatabase;
let h: Harness; // a generous limiter: the functional tests
let slow: Harness; // a small limiter: the 429 tests
beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db, { env: { DEPTH_RATE_LIMIT_PER_MINUTE: '100000' } });
  slow = await createOrdersHarness(db, { env: { DEPTH_RATE_LIMIT_PER_MINUTE: '5' } });
}, 120_000);
afterAll(async () => {
  await slow?.close();
  await h?.close();
  await db?.dispose();
});

const depth = (q: string, harness: Harness = h) => harness.http.get(`/v1/market/depth${q}`);
const btc = (bid: string, ask: string, over: { ageSeconds?: number } = {}) =>
  setQuote(h, 'BTC-USD', bid, ask, over);

const limitBuy = (price: string, qty = '0.0025') => ({
  symbol: 'BTC-USD',
  side: 'BUY',
  type: 'LIMIT',
  qty,
  limitPrice: price,
  tif: 'GTC',
});

describe('GET /v1/market/depth: public, simulated, exact', () => {
  it('needs no session; vector J through the API: best bid and ask are the quote, levels 2, 3 and 15 are the hand-verified prices', async () => {
    await btc('89990.00', '90010.00');
    const r = await depth('?symbol=BTC-USD&levels=15');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = DepthResponse.parse(r.body); // strict schema: unknown fields would fail
    expect(body).toMatchObject({
      symbol: 'BTC-USD',
      simulated: true,
      freshness: 'DELAYED',
      spread: '20.00',
      mid: '90000.00',
      note: DEPTH_NOTE,
    });
    expect(DEPTH_NOTE).toBe(
      'Simulated depth: informational. Fills use the simulated execution model (QBX-1), not this book.',
    );
    const { bids, asks } = body.levels ?? { bids: [], asks: [] };
    expect(asks.map((l) => l.price).slice(0, 3)).toEqual(['90010.00', '90019.64', '90029.28']);
    expect(asks[14]?.price).toBe('90144.96');
    expect(bids.map((l) => l.price).slice(0, 3)).toEqual(['89990.00', '89980.36', '89970.72']);
    expect(bids[14]?.price).toBe('89855.04');
    expect(asks).toHaveLength(15);
    expect(bids).toHaveLength(15);
    for (const l of [...bids, ...asks]) {
      expect(typeof l.size).toBe('string');
      expect(l.cumPct).toBeGreaterThanOrEqual(0);
      expect(l.cumPct).toBeLessThanOrEqual(100);
    }
  });

  it('follows the quote: a new quote gives a new best bid and ask (never a cached book of the old quote)', async () => {
    await btc('89990.00', '90010.00');
    const a = (await depth('?symbol=BTC-USD')).body;
    await btc('90100.00', '90120.00');
    const b = (await depth('?symbol=BTC-USD')).body;
    expect(a.levels.bids[0].price).toBe('89990.00');
    expect(b.levels.bids[0].price).toBe('90100.00');
    expect(b.levels.asks[0].price).toBe('90120.00');
    await btc('89990.00', '90010.00');
  });

  it('a stock: whole-share sizes, tick 0.01 (vector K ladder)', async () => {
    await setQuote(h, 'AAPL', '189.95', '190.00');
    const r = await depth('?symbol=aapl&levels=15'); // the symbol is upper-cased
    expect(r.status).toBe(200);
    expect(r.body.symbol).toBe('AAPL');
    expect(r.body.levels.asks.map((l: { price: string }) => l.price).slice(0, 3)).toEqual([
      '190.00',
      '190.04',
      '190.08',
    ]);
    expect(r.body.levels.asks[14].price).toBe('190.56');
    expect(r.body.levels.bids[14].price).toBe('189.39');
    for (const l of [...r.body.levels.bids, ...r.body.levels.asks])
      expect(l.size).toMatch(/^[1-9][0-9]*$/);
  });

  it('levels: 1 and 25 are accepted (control); 0, 26, 1.5, abc, an extra parameter and a missing symbol are 400; an unknown symbol is 404', async () => {
    await btc('89990.00', '90010.00');
    const one = await depth('?symbol=BTC-USD&levels=1');
    expect(one.status).toBe(200);
    expect(one.body.levels.bids).toHaveLength(1);
    expect(one.body.levels.asks).toHaveLength(1);
    const max = await depth('?symbol=BTC-USD&levels=25');
    expect(max.status).toBe(200);
    expect(max.body.levels.asks).toHaveLength(25);
    for (const bad of [
      '?symbol=BTC-USD&levels=0',
      '?symbol=BTC-USD&levels=26',
      '?symbol=BTC-USD&levels=1.5',
      '?symbol=BTC-USD&levels=abc',
      '?symbol=BTC-USD&levels=-1',
      '?symbol=BTC-USD&extra=1',
      '',
      '?symbol=!!!',
    ])
      expect((await depth(bad)).status, bad).toBe(400);
    const unknown = await depth('?symbol=NOPE');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('INSTRUMENT_NOT_FOUND');
  });

  it('freshness (D-100): a stale quote, no quote and a closed market give levels null and the state; a fresh quote gives levels (controls)', async () => {
    // a STALE quote: far older than the crypto real-time window
    await btc('89990.00', '90010.00', { ageSeconds: 3600 });
    const stale = DepthResponse.parse((await depth('?symbol=BTC-USD')).body);
    expect(stale.freshness).toBe('STALE');
    expect(stale.levels).toBeNull();
    expect(stale.spread).toBeNull();
    expect(stale.simulated).toBe(true);
    expect(stale.note).toBe(DEPTH_NOTE);
    // control: the same symbol with a fresh quote has a book
    await btc('89990.00', '90010.00');
    expect(DepthResponse.parse((await depth('?symbol=BTC-USD')).body).levels).not.toBeNull();
    // no quote at all: UNAVAILABLE
    const none = DepthResponse.parse((await depth('?symbol=SOL-USD')).body);
    expect(none.freshness).toBe('UNAVAILABLE');
    expect(none.levels).toBeNull();
    expect(none.quoteAt).toBeNull();
    // a closed market: AAPL on a Saturday
    await setQuote(h, 'AAPL', '189.95', '190.00');
    expect(DepthResponse.parse((await depth('?symbol=AAPL')).body).levels).not.toBeNull(); // control: open
    const openAt = h.clock.now().toISOString();
    h.clock.set('2026-11-14T15:00:00.000Z'); // Saturday
    await setQuote(h, 'AAPL', '189.95', '190.00');
    const closed = DepthResponse.parse((await depth('?symbol=AAPL')).body);
    expect(closed.freshness).toBe('CLOSED');
    expect(closed.levels).toBeNull();
    h.clock.set(openAt);
  });
});

describe('cache (D-101): the same quote gives the identical body; the cache is bounded', () => {
  it('a repeated request is a cache hit with an identical body', async () => {
    await btc('89990.00', '90010.00');
    const svc = h.app.get(DepthService);
    const first = await depth('?symbol=BTC-USD&levels=15');
    const misses = svc.misses;
    const hits = svc.hits;
    const second = await depth('?symbol=BTC-USD&levels=15');
    expect(second.text).toBe(first.text);
    expect(svc.hits).toBe(hits + 1);
    expect(svc.misses).toBe(misses);
    // control: another level count is another entry
    await depth('?symbol=BTC-USD&levels=7');
    expect(svc.misses).toBe(misses + 1);
  });

  it(`never holds more than ${String(DEPTH_CACHE_MAX)} books, however many quotes pass`, async () => {
    const svc = h.app.get(DepthService);
    for (let i = 0; i < DEPTH_CACHE_MAX + 40; i += 1) {
      await btc(`${String(80000 + i)}.00`, `${String(80010 + i)}.00`);
      expect((await depth('?symbol=BTC-USD&levels=3')).status).toBe(200);
    }
    expect(svc.cacheSize()).toBe(DEPTH_CACHE_MAX);
    await btc('89990.00', '90010.00');
  });
});

describe('cost-based limiter (D-101): trips and recovers', () => {
  it('a 15-level request costs 1 and a 25-level request costs 2, from 5 points per minute; a 429 carries Retry-After; it recovers when the window passes', async () => {
    await setQuote(slow, 'BTC-USD', '89990.00', '90010.00');
    expect((await depth('?symbol=BTC-USD&levels=25', slow)).status).toBe(200); // 2
    expect((await depth('?symbol=BTC-USD&levels=25', slow)).status).toBe(200); // 4
    const tooBig = await depth('?symbol=BTC-USD&levels=25', slow); // would be 6 > 5
    expect(tooBig.status).toBe(429);
    expect(tooBig.body.error.code).toBe('RATE_LIMITED');
    expect(Number(tooBig.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await depth('?symbol=BTC-USD&levels=15', slow)).status).toBe(200); // control: 1 point is still left (5)
    expect((await depth('?symbol=BTC-USD&levels=15', slow)).status).toBe(429); // used up
    slow.clock.advance(61_000);
    await setQuote(slow, 'BTC-USD', '89990.00', '90010.00');
    expect((await depth('?symbol=BTC-USD&levels=25', slow)).status).toBe(200); // recovered
  });
});

describe('GET /v1/market/depth/my-orders: only the caller, placed by exact comparison on the server', () => {
  it('needs a session (401 without one)', async () => {
    const r = await h.http.get('/v1/market/depth/my-orders?symbol=BTC-USD');
    expect(r.status).toBe(401);
  });

  it('level 3 (vector J), level 1 (the best bid), outside the ladder; a SELL on the ask ladder; B never appears for A', async () => {
    await btc('89990.00', '90010.00');
    const a = await newUser(h, db, 'depth-a');
    const b = await newUser(h, db, 'depth-b');
    const place = async (u: typeof a, body: object) => {
      const r = await placeOrder(h, u, newKey(), body);
      expect(r.status).toBe(201);
      expect(r.body.status).toBe('ACCEPTED');
      return r.body.id as string;
    };
    const idLevel3 = await place(a, limitBuy('89970.72')); // bid level 3 = 89,990.00 - 2 x 9.64
    const idLevel1 = await place(a, limitBuy('89990.00')); // the best bid itself
    const idOutside = await place(a, limitBuy('89000.00')); // far below the 15-level ladder
    const idBetween = await place(a, limitBuy('89985.00')); // between two levels: not on the book (no rounding)
    // a SELL needs a position: a market BUY first, then a resting SELL at ask level 2 = 90,019.64
    const mk = await placeOrder(h, a, newKey(), {
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'MARKET',
      qty: '0.01',
      referencePrice: '90010.00',
    });
    expect(mk.status).toBe(201);
    const idSell = await place(a, {
      symbol: 'BTC-USD',
      side: 'SELL',
      type: 'LIMIT',
      qty: '0.004',
      limitPrice: '90019.64',
      tif: 'GTC',
    });
    // B has an order on the very same price as A's level-3 order
    const idB = await place(b, limitBuy('89970.72'));

    const r = await getAs(h, a, '/v1/market/depth/my-orders?symbol=BTC-USD&levels=15');
    expect(r.status).toBe(200);
    const mine = MyDepthOrdersResponse.parse(r.body);
    expect(mine.symbol).toBe('BTC-USD');
    expect(mine.freshness).toBe('DELAYED');
    const by = new Map(mine.orders.map((o) => [o.orderId, o]));
    expect(by.get(idLevel3)).toMatchObject({
      side: 'BUY',
      price: '89970.72',
      onBook: true,
      level: 3,
    });
    expect(by.get(idLevel1)).toMatchObject({
      side: 'BUY',
      price: '89990.00',
      onBook: true,
      level: 1,
    });
    expect(by.get(idOutside)).toMatchObject({ onBook: false, level: null });
    expect(by.get(idBetween)).toMatchObject({ price: '89985.00', onBook: false, level: null });
    expect(by.get(idSell)).toMatchObject({
      side: 'SELL',
      price: '90019.64',
      onBook: true,
      level: 2,
    });
    // never anyone else's order (control: B sees its own)
    expect(by.has(idB)).toBe(false);
    expect(mine.orders).toHaveLength(5); // the market order is filled, not an open limit order
    const rb = MyDepthOrdersResponse.parse(
      (await getAs(h, b, '/v1/market/depth/my-orders?symbol=BTC-USD')).body,
    );
    expect(rb.orders.map((o) => o.orderId)).toEqual([idB]);
    expect(rb.orders[0]).toMatchObject({ onBook: true, level: 3 });

    // a smaller book hides level 3: the same order is then off the visible book
    const small = MyDepthOrdersResponse.parse(
      (await getAs(h, a, '/v1/market/depth/my-orders?symbol=BTC-USD&levels=2')).body,
    );
    expect(small.orders.find((o) => o.orderId === idLevel3)).toMatchObject({
      onBook: false,
      level: null,
    });
    expect(small.orders.find((o) => o.orderId === idLevel1)).toMatchObject({
      onBook: true,
      level: 1,
    });

    // a stale quote: the orders are still listed but no ladder exists, so nothing is on the book
    await btc('89990.00', '90010.00', { ageSeconds: 3600 });
    const stale = MyDepthOrdersResponse.parse(
      (await getAs(h, a, '/v1/market/depth/my-orders?symbol=BTC-USD')).body,
    );
    expect(stale.freshness).toBe('STALE');
    expect(stale.orders).toHaveLength(5);
    expect(stale.orders.every((o) => !o.onBook && o.level === null)).toBe(true);
    await btc('89990.00', '90010.00');

    // cancelling removes the order from the list
    const c = await h.http
      .post(`/v1/orders/${idLevel3}/cancel`)
      .set('Cookie', cookie(a.token))
      .set('Origin', 'http://localhost:3000')
      .set('Idempotency-Key', newKey())
      .send();
    expect(c.status).toBe(200);
    const after = MyDepthOrdersResponse.parse(
      (await getAs(h, a, '/v1/market/depth/my-orders?symbol=BTC-USD')).body,
    );
    expect(after.orders.some((o) => o.orderId === idLevel3)).toBe(false);
    expect(after.orders).toHaveLength(4);
  });

  it('validation: levels 0 and 26 and an unknown symbol are rejected (controls: 1 and 25 are fine)', async () => {
    const u = await newUser(h, db, 'depth-v');
    for (const bad of ['levels=0', 'levels=26', 'levels=x'])
      expect((await getAs(h, u, `/v1/market/depth/my-orders?symbol=BTC-USD&${bad}`)).status).toBe(
        400,
      );
    expect((await getAs(h, u, '/v1/market/depth/my-orders?symbol=NOPE')).status).toBe(404);
    for (const ok of ['levels=1', 'levels=25'])
      expect((await getAs(h, u, `/v1/market/depth/my-orders?symbol=BTC-USD&${ok}`)).status).toBe(
        200,
      );
  });

  it('is limited per user with the same cost style (429 with Retry-After, then recovery)', async () => {
    await setQuote(slow, 'BTC-USD', '89990.00', '90010.00');
    const u = await newUser(slow, db, 'depth-l');
    for (let i = 0; i < 5; i += 1)
      expect((await getAs(slow, u, '/v1/market/depth/my-orders?symbol=BTC-USD')).status).toBe(200);
    const r = await getAs(slow, u, '/v1/market/depth/my-orders?symbol=BTC-USD');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    slow.clock.advance(61_000);
    await setQuote(slow, 'BTC-USD', '89990.00', '90010.00');
    expect((await getAs(slow, u, '/v1/market/depth/my-orders?symbol=BTC-USD')).status).toBe(200);
  });
});
