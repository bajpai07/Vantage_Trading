// Every business reject code over HTTP: 201 with a REJECTED order (never an HTTP error), stored, money unchanged.
// Every reject case is followed by a control that fills once the cause is removed.
import { REJECT_RULE_ORDER } from '@vantage/engine';
import { ORDER_REJECT_CODES } from '@vantage/contracts';
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUOTE_STORE } from '../../tokens.js';
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
import { createInstrument } from '../../testing/trading-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import type { InMemoryQuoteStore } from '../market-data/quote.store.js';

let db: TestDatabase;
let h: Harness;
beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db);
  await setQuote(h, 'AAPL', '189.95', '190.00');
  await createInstrument(db, 'ZZTEST'); // a whole-share equity we may reconfigure
  await setQuote(h, 'ZZTEST', '189.95', '190.00');
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const tested = new Set<string>();
const ZZ = { ...BUY_AAPL, symbol: 'ZZTEST' };

/** Places the order, expects the persisted reject and that nothing but the order trail changed. */
async function expectReject(
  user: TestUser,
  code: string,
  body: Record<string, unknown> = BUY_AAPL,
  harness: Harness = h,
): Promise<void> {
  const cashBefore = parse(await cash(db, user.accountId)).toString();
  const before = await counts(db, user.accountId);
  const res = await placeOrder(harness, user, newKey(), body);
  expect(res.status, code).toBe(201); // a business reject is not an HTTP error
  expect(res.body).toMatchObject({
    status: 'REJECTED',
    rejectCode: code,
    filledQty: '0',
    execution: null,
  });
  const row = (
    await db.migrator.query(
      `SELECT status::text AS status, reject_code FROM orders WHERE id = $1::uuid`,
      [res.body.id],
    )
  ).rows[0];
  expect(row).toEqual({ status: 'REJECTED', reject_code: code });
  const after = await counts(db, user.accountId);
  expect(after).toEqual({
    orders: before.orders + 1,
    executions: before.executions,
    idempotency: before.idempotency + 1,
    ledgerTx: before.ledgerTx,
  });
  expect(parse(await cash(db, user.accountId)).toString()).toBe(cashBefore); // money unchanged
  expect(await reconcileAccount(db.app, user.accountId)).toEqual([]);
  // GET returns the same stored rejection
  expect((await getAs(h, user, `/v1/orders/${String(res.body.id)}`)).body).toEqual(res.body);
  tested.add(code);
}

const expectFill = async (
  user: TestUser,
  body: Record<string, unknown> = BUY_AAPL,
  harness: Harness = h,
): Promise<void> => {
  const res = await placeOrder(harness, user, newKey(), body);
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ status: 'FILLED', rejectCode: null });
};

const setInstrument = (sql: string): Promise<unknown> =>
  db.migrator.query(`UPDATE instruments SET ${sql} WHERE symbol = 'ZZTEST'`);
const resetInstrument = (): Promise<unknown> =>
  setInstrument(`status = 'ACTIVE', tradable_in = '{MVP}', min_qty = 1, qty_step = 1`);

describe('rejects over HTTP', () => {
  it('MARKET_CLOSED (after the close), then OPEN fills', async () => {
    const u = await newUser(h, db);
    h.clock.set('2026-11-10T22:00:00.000Z'); // 17:00 New York
    await setQuote(h, 'AAPL', '189.95', '190.00');
    await expectReject(u, 'MARKET_CLOSED');
    h.clock.set(OPEN_TIME);
    await setQuote(h, 'AAPL', '189.95', '190.00');
    await expectFill(u);
  });

  it('STALE_QUOTE (older than the delay plus 60 s), then a fresh quote fills', async () => {
    const u = await newUser(h, db);
    await setQuote(h, 'AAPL', '189.95', '190.00', { ageSeconds: 2000 });
    await expectReject(u, 'STALE_QUOTE');
    await setQuote(h, 'AAPL', '189.95', '190.00');
    await expectFill(u);
  });

  it('NO_ELIGIBLE_QUOTE (no accepted quote at all), then a quote fills', async () => {
    const u = await newUser(h, db);
    await h.app
      .get<InMemoryQuoteStore>(QUOTE_STORE)
      .set('ZZTEST', { lastAccepted: null, pending: null });
    await expectReject(u, 'NO_ELIGIBLE_QUOTE', ZZ);
    await setQuote(h, 'ZZTEST', '189.95', '190.00');
    await expectFill(u, ZZ);
  });

  it('INSUFFICIENT_BUYING_POWER (53 x 190.04 > 10,000), then 52 fills', async () => {
    const u = await newUser(h, db);
    await expectReject(u, 'INSUFFICIENT_BUYING_POWER', { ...BUY_AAPL, qty: '53' });
    await expectFill(u, { ...BUY_AAPL, qty: '52' }); // 52 x 190.04 = 9882.08
  });

  it('INSUFFICIENT_POSITION (nothing to sell, then selling more than held), then selling what is held fills', async () => {
    const u = await newUser(h, db);
    const sell = { ...BUY_AAPL, side: 'SELL', referencePrice: '189.95' };
    await expectReject(u, 'INSUFFICIENT_POSITION', sell);
    await expectFill(u, { ...BUY_AAPL, qty: '3' });
    await expectReject(u, 'INSUFFICIENT_POSITION', { ...sell, qty: '4' });
    await expectFill(u, { ...sell, qty: '3' });
  });

  it('PRICE_MOVED (the ask is more than 1% above the price the user saw), then a favourable move fills', async () => {
    const u = await newUser(h, db);
    await expectReject(u, 'PRICE_MOVED', { ...BUY_AAPL, referencePrice: '188.00' });
    await expectFill(u, { ...BUY_AAPL, referencePrice: '195.00' }); // the price fell: fine
  });

  it('INSTRUMENT_NOT_FOUND is a 404 error (not an order): nothing is stored and the key stays free', async () => {
    const u = await newUser(h, db);
    const key = newKey();
    const res = await placeOrder(h, u, key, { ...BUY_AAPL, symbol: 'NOSUCH' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INSTRUMENT_NOT_FOUND');
    expect(await counts(db, u.accountId)).toMatchObject({
      orders: 0,
      idempotency: 0,
      executions: 0,
    });
    expect(parse(await cash(db, u.accountId)).toString()).toBe('10000');
    // control: the same key with a real instrument then works
    expect((await placeOrder(h, u, key, BUY_AAPL)).status).toBe(201);
  });

  it('INSTRUMENT_HALTED, then ACTIVE fills', async () => {
    const u = await newUser(h, db);
    await setInstrument(`status = 'HALTED'`);
    await expectReject(u, 'INSTRUMENT_HALTED', ZZ);
    await resetInstrument();
    await expectFill(u, ZZ);
  });

  it('INSTRUMENT_NOT_TRADABLE (not enabled for the MVP; delisted; a BUY on SELL_ONLY), then enabled fills', async () => {
    const u = await newUser(h, db);
    await setInstrument(`tradable_in = '{}'`);
    await expectReject(u, 'INSTRUMENT_NOT_TRADABLE', ZZ);
    await resetInstrument();
    await setInstrument(`status = 'DELISTED'`);
    await expectReject(u, 'INSTRUMENT_NOT_TRADABLE', ZZ);
    await resetInstrument();
    await setInstrument(`status = 'SELL_ONLY'`);
    await expectReject(u, 'INSTRUMENT_NOT_TRADABLE', ZZ);
    await resetInstrument();
    await expectFill(u, ZZ);
  });

  it('QTY_BELOW_MIN and QTY_STEP_VIOLATION (instrument rules), then the default rules fill', async () => {
    const u = await newUser(h, db);
    await setInstrument(`min_qty = 5`);
    await expectReject(u, 'QTY_BELOW_MIN', { ...ZZ, qty: '2' });
    await resetInstrument();
    await setInstrument(`qty_step = 10, min_qty = 10`);
    await expectReject(u, 'QTY_STEP_VIOLATION', { ...ZZ, qty: '15' });
    await expectFill(u, { ...ZZ, qty: '20' }); // control inside the same rule: a multiple of the step
    await resetInstrument();
  });

  it('ACCOUNT_NOT_ACTIVE (frozen account; suspended user), then ACTIVE fills', async () => {
    const u = await newUser(h, db);
    await db.migrator.query(`UPDATE accounts SET status = 'FROZEN_RECON' WHERE id = $1::uuid`, [
      u.accountId,
    ]);
    await expectReject(u, 'ACCOUNT_NOT_ACTIVE');
    await db.migrator.query(`UPDATE accounts SET status = 'ACTIVE' WHERE id = $1::uuid`, [
      u.accountId,
    ]);
    await expectFill(u);
  });

  it('TRADING_PAUSED (kill switch TRADING_ENABLED=false), then the enabled app fills the same user', async () => {
    const hp = await createOrdersHarness(db, { env: { TRADING_ENABLED: 'false' } });
    try {
      await setQuote(hp, 'AAPL', '189.95', '190.00');
      const u = await newUser(h, db);
      await expectReject(u, 'TRADING_PAUSED', BUY_AAPL, hp);
      await expectFill(u); // trading enabled
    } finally {
      await hp.close();
    }
  });

  it('FEE_EXCEEDS_PROCEEDS (fee schedule v2 with a 5.00 minimum commission), then a larger SELL fills', async () => {
    const u = await newUser(h, db);
    // buy 3 shares at ask 2.00 -> 2.01 under schedule v1 (no fee), then switch to v2 at 16:00Z
    await setQuote(h, 'AAPL', '1.99', '2.00');
    await expectFill(u, { ...BUY_AAPL, qty: '3', referencePrice: '2.00' });
    await db.migrator.query(
      `INSERT INTO fee_schedules (id, asset_class, exchange_id, version, effective_from, commission_bps,
                                  commission_min_local, slippage_base_bps, slippage_size_coef, model_version)
       VALUES (gen_random_uuid(), 'EQUITY', NULL, 2, '2026-11-10T15:30:00Z', 0, 5, 2, 0, 'QBX-1/r8he')`,
    );
    h.clock.set('2026-11-10T16:00:00.000Z');
    await setQuote(h, 'AAPL', '2.00', '2.05');
    const sell = { ...BUY_AAPL, side: 'SELL', referencePrice: '2.00' };
    await expectReject(u, 'FEE_EXCEEDS_PROCEEDS', { ...sell, qty: '1' }); // proceeds 1.99 < fee 5.00
    const cashBefore = parse(await cash(db, u.accountId));
    const ok = await placeOrder(h, u, newKey(), { ...sell, qty: '3' }); // proceeds 5.97 > fee 5.00
    expect(ok.body).toMatchObject({
      status: 'FILLED',
      execution: { price: '1.99', notional: '5.97', fee: '5.00' },
    });
    expect(parse(await cash(db, u.accountId)).toString()).toBe(
      cashBefore.add(parse('0.97')).toString(),
    );
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
    h.clock.set(OPEN_TIME);
  });
});

describe('coverage', () => {
  it('every reject code of the engine and of the contract was exercised over HTTP, and the two lists agree', () => {
    expect([...ORDER_REJECT_CODES]).toEqual([...REJECT_RULE_ORDER]);
    // TICK_VIOLATION (M8b-1) applies to LIMIT orders only; it is exercised over HTTP in orders-limit-http.int.test.ts
    expect([...tested, 'TICK_VIOLATION'].sort()).toEqual([...ORDER_REJECT_CODES].sort());
  });
});
