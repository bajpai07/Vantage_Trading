// POST /v1/orders/preview (D-70) over real HTTP and real Postgres. The preview must decide exactly like the real order,
// write nothing, take no locks, and never use another user's data. Every "must fail" has a control that succeeds.
import fc from 'fast-check';
import { REJECT_RULE_ORDER } from '@vantage/engine';
import { ORDER_PREVIEW_DISCLAIMER, ORDER_REJECT_CODES } from '@vantage/contracts';
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_ORIGIN, cookie } from '../../testing/harness.js';
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
import { opArb, priceStr } from '../../testing/reference-model.js';
import { createInstrument } from '../../testing/trading-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import { QUOTE_STORE } from '../../tokens.js';
import type { InMemoryQuoteStore } from '../market-data/quote.store.js';

let db: TestDatabase;
let h: Harness;
beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db, { env: { ORDER_PREVIEW_RATE_LIMIT_PER_MINUTE: '100000' } });
  await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
  await createInstrument(db, 'ZZTEST'); // a whole-share equity we may reconfigure
  await setQuote(h, 'ZZTEST', '189.95', '190.00');
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const preview = (
  user: Pick<TestUser, 'token'>,
  body: unknown = BUY_AAPL,
  harness: Harness = h,
  origin: string | null = WEB_ORIGIN,
) => {
  let req = harness.http.post('/v1/orders/preview').set('Cookie', cookie(user.token));
  if (origin !== null) req = req.set('Origin', origin);
  return req.send(body as object);
};
const dec = (s: unknown): string => parse(String(s)).toString();
const sell = (qty: string, bid: string) => ({
  ...BUY_AAPL,
  side: 'SELL',
  qty,
  referencePrice: bid,
});

describe('3. the preview equals what the real order then produces (the M4a golden vectors)', () => {
  it('vector 1: BUY 10 at ask 190.00: 190.04, notional 1,900.40, fee 0, cash after 8,099.60 (and the exact response shape)', async () => {
    const u = await newUser(h, db, 'v1');
    const p = await preview(u);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({
      wouldFill: true,
      rejectCode: null,
      estimatedPrice: '190.04',
      estimatedNotional: '1900.40',
      estimatedFee: '0.00',
      estimatedCashAfter: '8099.60',
      estimatedProceeds: null,
      slippageBps: '2',
      // M8 (D-90): the most the 10,000.00 cash buys at 190.04 (52 x 190.04 = 9,882.08; 53 x 190.04 = 10,072.12 is too much)
      maxQty: '52',
      quote: {
        bid: '189.95',
        ask: '190.00',
        last: '189.97',
        asOf: '2026-11-10T14:45:00.000Z',
        source: 'FIXTURE',
        freshness: 'DELAYED',
        // the same day-change fields as a quote; null on the fixture feed (no candle source)
        prevClose: null,
        change: null,
        changePct: null,
        changeBasis: null,
        changeOf: null,
      },
      disclaimer: ORDER_PREVIEW_DISCLAIMER,
      generatedAt: OPEN_TIME,
    });
    for (const k of ['estimatedPrice', 'estimatedNotional', 'estimatedFee', 'estimatedCashAfter']) {
      expect(typeof p.body[k], k).toBe('string');
    }
    // the real order produces exactly that
    const o = await placeOrder(h, u, newKey(), BUY_AAPL);
    expect(o.body.execution).toMatchObject({ price: '190.04', notional: '1900.40', fee: '0.00' });
    expect(dec(await cash(db, u.accountId))).toBe(dec(p.body.estimatedCashAfter));
  });

  it('vector 2: SELL 10 at bid 195.00: 194.96, proceeds 1,949.60, cash after 10,049.20', async () => {
    const u = await newUser(h, db, 'v2');
    await placeOrder(h, u, newKey(), BUY_AAPL);
    await setQuote(h, 'AAPL', '195.00', '195.05');
    const p = await preview(u, sell('10', '195.00'));
    expect(p.body).toMatchObject({
      wouldFill: true,
      estimatedPrice: '194.96',
      estimatedNotional: '1949.60',
      estimatedFee: '0.00',
      estimatedProceeds: '1949.60',
      estimatedCashAfter: '10049.20',
    });
    const o = await placeOrder(h, u, newKey(), sell('10', '195.00'));
    expect(o.body.execution).toMatchObject({ price: '194.96', notional: '1949.60' });
    expect(dec(await cash(db, u.accountId))).toBe(dec(p.body.estimatedCashAfter));
    await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
  });

  it('vector 4 (FIFO): buy 3 at ask 100.00, buy 2 at ask 101.00, sell 4 at bid 99.00: every preview equals its fill (100.02, 101.03, 98.98); cash 9,893.80', async () => {
    const u = await newUser(h, db, 'v4');
    const steps: Array<[string, string, Record<string, unknown>, string]> = [
      ['99.98', '100.00', { ...BUY_AAPL, qty: '3', referencePrice: '100.00' }, '100.02'],
      ['100.98', '101.00', { ...BUY_AAPL, qty: '2', referencePrice: '101.00' }, '101.03'],
      ['99.00', '99.05', sell('4', '99.00'), '98.98'],
    ];
    for (const [bid, ask, body, price] of steps) {
      await setQuote(h, 'AAPL', bid, ask);
      const p = await preview(u, body);
      const o = await placeOrder(h, u, newKey(), body);
      expect(p.body.estimatedPrice).toBe(price);
      expect(o.body.execution.price).toBe(price);
      expect(o.body.execution.notional).toBe(p.body.estimatedNotional);
      expect(o.body.execution.fee).toBe(p.body.estimatedFee);
      expect(dec(await cash(db, u.accountId))).toBe(dec(p.body.estimatedCashAfter));
    }
    expect(dec(await cash(db, u.accountId))).toBe('9893.8'); // 10000 - 300.06 - 202.06 + 395.92
    await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });
});

describe('3. every reject code is previewed exactly as the real order then rejects it', () => {
  const seen = new Set<string>();
  const setZZ = (sql: string) =>
    db.migrator.query(`UPDATE instruments SET ${sql} WHERE symbol = 'ZZTEST'`);
  const resetZZ = () =>
    setZZ(`status = 'ACTIVE', tradable_in = '{MVP}', min_qty = 1, qty_step = 1`);
  const ZZ = { ...BUY_AAPL, symbol: 'ZZTEST' };

  async function bothReject(
    u: TestUser,
    code: string,
    body: Record<string, unknown>,
    harness: Harness = h,
  ) {
    const p = await preview(u, body, harness);
    expect(p.status, code).toBe(200); // a would-be reject is a normal answer, not an error
    expect(p.body).toMatchObject({ wouldFill: false, rejectCode: code });
    const o = await placeOrder(harness, u, newKey(), body);
    expect(o.body).toMatchObject({ status: 'REJECTED', rejectCode: code });
    seen.add(code);
    return p.body;
  }
  async function bothFill(u: TestUser, body: Record<string, unknown>, harness: Harness = h) {
    const p = await preview(u, body, harness);
    expect(p.body).toMatchObject({ wouldFill: true, rejectCode: null });
    const o = await placeOrder(harness, u, newKey(), body);
    expect(o.body.status).toBe('FILLED');
    expect(o.body.execution.price).toBe(p.body.estimatedPrice);
  }

  it('MARKET_CLOSED, STALE_QUOTE, NO_ELIGIBLE_QUOTE: no estimate (the quote is not usable); a fresh quote then fills (controls)', async () => {
    const u = await newUser(h, db, 'rej1');
    h.clock.set('2026-11-10T22:00:00.000Z');
    await setQuote(h, 'AAPL', '189.95', '190.00');
    const closed = await bothReject(u, 'MARKET_CLOSED', BUY_AAPL);
    expect(closed).toMatchObject({
      estimatedPrice: null,
      estimatedNotional: null,
      estimatedCashAfter: null,
    });
    expect(closed.quote.freshness).toBe('CLOSED');
    h.clock.set(OPEN_TIME);
    await setQuote(h, 'AAPL', '189.95', '190.00', { ageSeconds: 2000 });
    const stale = await bothReject(u, 'STALE_QUOTE', BUY_AAPL);
    expect(stale.quote.freshness).toBe('STALE');
    await h.app
      .get<InMemoryQuoteStore>(QUOTE_STORE)
      .set('ZZTEST', { lastAccepted: null, pending: null });
    const none = await bothReject(u, 'NO_ELIGIBLE_QUOTE', ZZ);
    expect(none.quote).toEqual({
      bid: null,
      ask: null,
      last: null,
      asOf: null,
      source: null,
      freshness: 'UNAVAILABLE',
    });
    await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
    await setQuote(h, 'ZZTEST', '189.95', '190.00');
    await bothFill(u, BUY_AAPL);
  });

  it('INSUFFICIENT_BUYING_POWER shows what the purchase would have cost (10,072.12) and the negative cash after (-72.12); then 52 fills', async () => {
    const u = await newUser(h, db, 'rej2');
    const p = await bothReject(u, 'INSUFFICIENT_BUYING_POWER', { ...BUY_AAPL, qty: '53' });
    expect(p).toMatchObject({
      estimatedPrice: '190.04',
      estimatedNotional: '10072.12',
      estimatedFee: '0.00',
      estimatedCashAfter: '-72.12',
    });
    await bothFill(u, { ...BUY_AAPL, qty: '52' });
  });

  it('INSUFFICIENT_POSITION (and PRICE_MOVED with the new price): estimates are shown; then the owned quantity fills', async () => {
    const u = await newUser(h, db, 'rej3');
    const s = sell('1', '189.95');
    const nothing = await bothReject(u, 'INSUFFICIENT_POSITION', s);
    expect(nothing).toMatchObject({ estimatedPrice: '189.91', estimatedProceeds: '189.91' });
    await bothFill(u, { ...BUY_AAPL, qty: '3' });
    await bothReject(u, 'INSUFFICIENT_POSITION', { ...s, qty: '4' });
    await bothFill(u, { ...s, qty: '3' });
    const moved = await bothReject(u, 'PRICE_MOVED', { ...BUY_AAPL, referencePrice: '188.00' });
    expect(moved.estimatedPrice).toBe('190.04'); // the UI shows the new price and asks again (D-71)
    await bothFill(u, { ...BUY_AAPL, referencePrice: '195.00' }); // the price fell: fine
  });

  it('INSTRUMENT_HALTED, INSTRUMENT_NOT_TRADABLE (three ways), QTY_BELOW_MIN, QTY_STEP_VIOLATION: no estimate; then the default rules fill', async () => {
    const u = await newUser(h, db, 'rej4');
    await setZZ(`status = 'HALTED'`);
    const halted = await bothReject(u, 'INSTRUMENT_HALTED', ZZ);
    expect(halted.estimatedPrice).toBeNull();
    await resetZZ();
    for (const change of [`tradable_in = '{}'`, `status = 'DELISTED'`, `status = 'SELL_ONLY'`]) {
      await setZZ(change);
      await bothReject(u, 'INSTRUMENT_NOT_TRADABLE', ZZ);
      await resetZZ();
    }
    await setZZ('min_qty = 5');
    await bothReject(u, 'QTY_BELOW_MIN', { ...ZZ, qty: '2' });
    await resetZZ();
    await setZZ('qty_step = 10, min_qty = 10');
    await bothReject(u, 'QTY_STEP_VIOLATION', { ...ZZ, qty: '15' });
    await bothFill(u, { ...ZZ, qty: '20' });
    await resetZZ();
  });

  it('ACCOUNT_NOT_ACTIVE and TRADING_PAUSED: no estimate; then active and enabled fill', async () => {
    const u = await newUser(h, db, 'rej5');
    await db.migrator.query(`UPDATE accounts SET status = 'FROZEN_RECON' WHERE id = $1::uuid`, [
      u.accountId,
    ]);
    await bothReject(u, 'ACCOUNT_NOT_ACTIVE', BUY_AAPL);
    await db.migrator.query(`UPDATE accounts SET status = 'ACTIVE' WHERE id = $1::uuid`, [
      u.accountId,
    ]);
    await bothFill(u, BUY_AAPL);

    const hp = await createOrdersHarness(db, {
      env: { TRADING_ENABLED: 'false', ORDER_PREVIEW_RATE_LIMIT_PER_MINUTE: '1000' },
    });
    try {
      await setQuote(hp, 'AAPL', '189.95', '190.00');
      const paused = await bothReject(
        await newUser(h, db, 'rej5b'),
        'TRADING_PAUSED',
        BUY_AAPL,
        hp,
      );
      expect(paused.estimatedPrice).toBeNull();
    } finally {
      await hp.close();
    }
  });

  it('INSTRUMENT_NOT_FOUND is a 404 for both (not a preview of a reject)', async () => {
    const u = await newUser(h, db, 'rej6');
    const p = await preview(u, { ...BUY_AAPL, symbol: 'NOSUCH' });
    expect(p.status).toBe(404);
    expect(p.body.error.code).toBe('INSTRUMENT_NOT_FOUND');
    expect((await placeOrder(h, u, newKey(), { ...BUY_AAPL, symbol: 'NOSUCH' })).status).toBe(404);
  });

  it('the codes covered here, with FEE_EXCEEDS_PROCEEDS in the fee file, are every code of the engine and the contract', () => {
    const covered = [...seen, 'FEE_EXCEEDS_PROCEEDS'].sort();
    expect(covered).toEqual([...ORDER_REJECT_CODES].sort());
    expect([...ORDER_REJECT_CODES]).toEqual([...REJECT_RULE_ORDER]);
  });
});

describe('3. the preview writes nothing and takes no locks', () => {
  it('after many previews (fills, rejects, sells, an unknown symbol) every row count, balance and the audit log are unchanged', async () => {
    const u = await newUser(h, db, 'ro');
    await placeOrder(h, u, newKey(), { ...BUY_AAPL, qty: '4' });
    const snapshot = async () => ({
      counts: await counts(db, u.accountId),
      events: (await db.migrator.query(`SELECT count(*)::int AS n FROM order_events`)).rows[0]?.n,
      audit: (await db.migrator.query(`SELECT count(*)::int AS n FROM audit_logs`)).rows[0]?.n,
      lots: (
        await db.migrator.query(
          `SELECT count(*)::int AS n FROM position_lots WHERE account_id = $1::uuid`,
          [u.accountId],
        )
      ).rows[0]?.n,
      closures: (await db.migrator.query(`SELECT count(*)::int AS n FROM lot_closures`)).rows[0]?.n,
      ledgerEntries: (await db.migrator.query(`SELECT count(*)::int AS n FROM ledger_entries`))
        .rows[0]?.n,
      balances: (
        await db.migrator.query(
          `SELECT type::text AS t, balance FROM ledger_accounts WHERE account_id = $1::uuid ORDER BY type`,
          [u.accountId],
        )
      ).rows,
      position: (
        await db.migrator.query(`SELECT qty, version FROM positions WHERE account_id = $1::uuid`, [
          u.accountId,
        ])
      ).rows,
    });
    const before = await snapshot();
    const bodies: Array<Record<string, unknown>> = [
      BUY_AAPL,
      { ...BUY_AAPL, qty: '4000' },
      sell('2', '189.95'),
      sell('9', '189.95'),
      { ...BUY_AAPL, referencePrice: '100.00' },
      { ...BUY_AAPL, symbol: 'ZZTEST' },
    ];
    for (let i = 0; i < 30; i += 1) {
      const r = await preview(u, bodies[i % bodies.length]);
      expect(r.status).toBe(200);
    }
    expect((await preview(u, { ...BUY_AAPL, symbol: 'NOSUCH' })).status).toBe(404);
    expect(await snapshot()).toEqual(before);
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });

  it('a preview is not blocked by the locks a real order takes (and a real order IS blocked by them: control)', async () => {
    const u = await newUser(h, db, 'lock');
    const holder = await db.migrator.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM accounts WHERE id = $1::uuid FOR UPDATE`, [u.accountId]);
      await holder.query(
        `SELECT 1 FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'CASH' FOR UPDATE`,
        [u.accountId],
      );

      // the preview answers at once while both rows are locked
      const t0 = Date.now();
      const p = await preview(u);
      expect(p.status).toBe(200);
      expect(p.body.wouldFill).toBe(true);
      expect(Date.now() - t0).toBeLessThan(3000);

      // control: a real order on the same account waits for the lock
      let settled = false;
      const order = placeOrder(h, u, newKey(), BUY_AAPL).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 800));
      expect(settled).toBe(false);
      await holder.query('COMMIT');
      const done = await order;
      expect(done.status).toBe(201);
    } finally {
      holder.release();
    }
  });

  it('100 previews and 50 real orders at the same time on one account: no deadlock, no error, and exactly the 24 fills (cash 398.08)', async () => {
    await setQuote(h, 'AAPL', '99.98', '100.00');
    const u = await newUser(h, db, 'conc');
    const BUY4 = { ...BUY_AAPL, qty: '4', referencePrice: '100.00' };
    const previews = Array.from({ length: 100 }, () => preview(u, BUY4));
    const orders = Array.from({ length: 50 }, () => placeOrder(h, u, newKey(), BUY4));
    const [pr, or] = await Promise.all([Promise.all(previews), Promise.all(orders)]);
    expect(pr.every((r) => r.status === 200)).toBe(true);
    expect(or.every((r) => r.status === 201)).toBe(true);
    expect(or.filter((r) => r.body.status === 'FILLED')).toHaveLength(24);
    expect(dec(await cash(db, u.accountId))).toBe('398.08');
    // the previews that came after the cash ran out say so (control that previews see the live state)
    const after = await preview(u, BUY4);
    expect(after.body).toMatchObject({ wouldFill: false, rejectCode: 'INSUFFICIENT_BUYING_POWER' });
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
    await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
  }, 120_000);
});

describe("another user's data never influences a preview", () => {
  it("B owns shares and has less cash; A's preview uses only A's cash and position", async () => {
    const a = await newUser(h, db, 'iso-a');
    const b = await newUser(h, db, 'iso-b');
    await placeOrder(h, b, newKey(), BUY_AAPL); // B: 10 shares, cash 8,099.60
    const pa = await preview(a, sell('1', '189.95'));
    expect(pa.body).toMatchObject({ wouldFill: false, rejectCode: 'INSUFFICIENT_POSITION' }); // A owns nothing
    const pa2 = await preview(a, BUY_AAPL);
    expect(pa2.body.estimatedCashAfter).toBe('8099.60'); // 10,000 minus the purchase: A's own cash
    const pb = await preview(b, sell('10', '189.95'));
    expect(pb.body.wouldFill).toBe(true); // control: B does own them
    // 189.95 x 0.9998 = 189.912 -> 189.91 per share; 10 x 189.91 = 1,899.10; B's 8,099.60 + 1,899.10 = 9,998.70
    expect(pb.body).toMatchObject({ estimatedPrice: '189.91', estimatedCashAfter: '9998.70' });
  });
});

describe('auth, CSRF, validation and the rate limit', () => {
  it('no session is 401; a bad or missing Origin is 403; invalid bodies are 400 (controls: a valid request works)', async () => {
    const u = await newUser(h, db, 'auth');
    expect(
      (await h.http.post('/v1/orders/preview').set('Origin', WEB_ORIGIN).send(BUY_AAPL)).status,
    ).toBe(401);
    for (const origin of ['http://evil.example', 'http://localhost:3001', null]) {
      const r = await preview(u, BUY_AAPL, h, origin);
      expect(r.status, String(origin)).toBe(403);
      expect(r.body.error.code).toBe('CSRF_REJECTED');
    }
    for (const bad of [
      { ...BUY_AAPL, qty: 0 },
      { ...BUY_AAPL, qty: 1.5 },
      { ...BUY_AAPL, qty: 10_000_000 },
      { ...BUY_AAPL, referencePrice: 190 },
      { ...BUY_AAPL, accountId: '0198d0d0-0000-7000-8000-000000000000' },
      { ...BUY_AAPL, price: '1.00' },
      { ...BUY_AAPL, type: 'LIMIT' },
      {},
    ]) {
      const r = await preview(u, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await preview(u)).status).toBe(200);
  });

  it('is limited per user (own counter): the 4th preview in a minute is 429 with Retry-After, another user and real orders are unaffected, the window reopens', async () => {
    const hl = await createOrdersHarness(db, { env: { ORDER_PREVIEW_RATE_LIMIT_PER_MINUTE: '3' } });
    try {
      await setQuote(hl, 'AAPL', '189.95', '190.00');
      const a = await newUser(hl, db, 'rl-a');
      const b = await newUser(hl, db, 'rl-b');
      for (let i = 0; i < 3; i += 1) expect((await preview(a, BUY_AAPL, hl)).status).toBe(200);
      const limited = await preview(a, BUY_AAPL, hl);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect((await preview(b, BUY_AAPL, hl)).status).toBe(200); // another user
      expect((await placeOrder(hl, a, newKey(), { ...BUY_AAPL, qty: '1' })).status).toBe(201); // placing is a different limit
      hl.clock.advance(61_000);
      await setQuote(hl, 'AAPL', '189.95', '190.00');
      expect((await preview(a, BUY_AAPL, hl)).status).toBe(200);
    } finally {
      await hl.close();
    }
  });

  it('the default is 60 previews a minute', async () => {
    const hd = await createOrdersHarness(db, {
      env: { ORDER_PREVIEW_RATE_LIMIT_PER_MINUTE: undefined },
    });
    try {
      expect(hd.config.orderPreviewRateLimitPerMinute).toBe(60);
    } finally {
      await hd.close();
    }
  });
});

describe('the preview and the real order agree on random orders (same rules, not just the golden cases)', () => {
  it('25 random orders on 3 instruments: the preview says what the order then does (reject code, price, notional, fee)', async () => {
    const insts = [
      await createInstrument(db, 'AAA'),
      await createInstrument(db, 'BBB'),
      await createInstrument(db, 'CCC'),
    ];
    const symbols = insts.map((i) => i.symbol);
    const ops = fc.sample(opArb, { numRuns: 25, seed: 20261113 });
    const u = await newUser(h, db, 'rand');
    let fills = 0;
    for (const [i, op] of ops.entries()) {
      const bidC = BigInt(op.bidC);
      const askC = bidC + BigInt(op.spreadC);
      const refC =
        op.side === 'BUY'
          ? op.refMode === 'exact'
            ? askC
            : (askC * 100n) / 103n
          : op.refMode === 'exact'
            ? bidC
            : (bidC * 103n) / 100n + 1n;
      const symbol = symbols[op.inst] as string;
      await setQuote(h, symbol, priceStr(bidC), priceStr(askC));
      const body = {
        symbol,
        side: op.side,
        type: 'MARKET',
        qty: String(op.qty),
        referencePrice: priceStr(refC),
      };
      const p = await preview(u, body);
      const o = await placeOrder(h, u, `rand-${String(i)}-${newKey()}`, body);
      expect(p.status).toBe(200);
      expect(p.body.rejectCode, JSON.stringify(body)).toBe(o.body.rejectCode);
      expect(p.body.wouldFill, JSON.stringify(body)).toBe(o.body.status === 'FILLED');
      if (o.body.status === 'FILLED') {
        fills += 1;
        expect(o.body.execution.price).toBe(p.body.estimatedPrice);
        expect(o.body.execution.notional).toBe(p.body.estimatedNotional);
        expect(o.body.execution.fee).toBe(p.body.estimatedFee);
      }
    }
    expect(fills).toBeGreaterThan(3); // the sample really filled orders
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  }, 120_000);

  it('(control) the helper API reads back the same orders: GET /v1/orders lists them', async () => {
    const u = await newUser(h, db, 'rd');
    await placeOrder(h, u, newKey(), { ...BUY_AAPL, qty: '1' });
    expect((await getAs(h, u, '/v1/orders')).body.orders).toHaveLength(1);
  });
});
