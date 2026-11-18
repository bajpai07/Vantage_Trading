// M8b-1 T0(a): golden vector D (proportional cost rounding and the by-subtraction rule) over real HTTP and Postgres.
// A made-up fractional instrument DCOIN (tick 0.00000001, step and minimum 0.1) lives on its own exchange DEXC with its own
// zero-commission, zero-slippage fee schedule, inserted BEFORE the app starts (the calendar service loads exchanges at boot).
// Hand arithmetic (also in packages/engine/src/fractional.test.ts):
//   BUY 0.3 at 90.03333333: 0.3 x 90.03333333 = 27.009999999 -> 27.01 at 8 dp, so the lot costs exactly 27.01.
//   SELL 0.1: 27.01 x 0.1 / 0.3 = 9.003333333... -> 9.00333333; the lot keeps 0.2 and 18.00666667.
//   SELL 0.1: 18.00666667 x 0.1 / 0.2 = 9.003333335, an exact tie -> HALF_EVEN rounds to the even neighbour 9.00333334;
//             the lot keeps 0.1 and 18.00666667 - 9.00333334 = 9.00333333.
//   SELL 0.1: the lot is fully consumed: exactly 9.00333333 (by subtraction). 9.00333333 + 9.00333334 + 9.00333333 = 27.01.
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { parse } from '@vantage/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from '../../testing/harness.js';
import {
  cash,
  createOrdersHarness,
  getAs,
  newKey,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';

let db: TestDatabase;
let h: Harness;

beforeAll(async () => {
  db = await createTestDatabase();
  // the exchange, its always-open calendar, its fee schedule and the instrument exist before the app boots
  const cal = await db.migrator.query<{ calendar: unknown }>(
    `SELECT calendar FROM exchanges WHERE code = 'CRYPTO'`,
  );
  const ex = await db.migrator.query<{ id: string }>(
    `INSERT INTO exchanges (id, code, name, country, timezone, calendar)
     VALUES (gen_random_uuid(), 'DEXC', 'Vector D test exchange', NULL, 'UTC', $1::jsonb) RETURNING id`,
    [JSON.stringify(cal.rows[0]?.calendar)],
  );
  const exchangeId = ex.rows[0]?.id;
  await db.migrator.query(
    `INSERT INTO fee_schedules (id, asset_class, exchange_id, version, effective_from, commission_bps,
                                commission_min_local, slippage_base_bps, slippage_size_coef, fx_spread_bps, model_version)
     VALUES (gen_random_uuid(), 'CRYPTO', $1::uuid, 1, '2026-01-01T00:00:00Z', 0, 0, 0, 0, 0, 'QBX-1/r8he')`,
    [exchangeId],
  );
  await db.migrator.query(
    `INSERT INTO instruments (id, symbol, name, asset_class, exchange_id, quote_currency, base_asset, tick_size, qty_step,
                              min_qty, fractional_ok, tradable_in, attrs)
     VALUES (gen_random_uuid(), 'DCOIN', 'Vector D coin', 'CRYPTO', $1::uuid, 'USD', 'DCOI', 0.00000001, 0.1, 0.1, true,
             '{MVP}', '{"source":"SYNTHETIC"}')`,
    [exchangeId],
  );
  h = await createOrdersHarness(db, { env: { ORDER_PREVIEW_RATE_LIMIT_PER_MINUTE: '100000' } });
}, 120_000);
afterAll(async () => {
  await h?.close();
  await db?.dispose();
});

const order = (side: 'BUY' | 'SELL', qty: string, px: string) => ({
  symbol: 'DCOIN',
  side,
  type: 'MARKET',
  qty,
  referencePrice: px,
});

describe('golden vector D over HTTP', () => {
  it('a lot of 0.3 costing 27.01 sold in three pieces of 0.1 consumes 9.00333333, 9.00333334 and 9.00333333', async () => {
    const u = await newUser(h, db, 'vecd');
    await setQuote(h, 'DCOIN', '90.03333333', '90.03333333');
    const buy = await placeOrder(h, u, newKey(), order('BUY', '0.3', '90.03333333'));
    expect(buy.status).toBe(201);
    expect(buy.body).toMatchObject({
      status: 'FILLED',
      qty: '0.3',
      execution: { price: '90.03333333', notional: '27.01', fee: '0.00' },
    });
    const state = async () => {
      const p = (await getAs(h, u, '/v1/portfolio')).body;
      const lots = await db.migrator.query<{ qty_open: string; cost_remaining: string }>(
        `SELECT qty_open, cost_remaining FROM position_lots WHERE account_id = $1::uuid`,
        [u.accountId],
      );
      const ledger = await db.migrator.query<{ balance: string }>(
        `SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'POSITION_COST'`,
        [u.accountId],
      );
      return {
        costBasis: p.exact.costBasis as string,
        lot: lots.rows.map((r) => [
          parse(r.qty_open).toString(),
          parse(r.cost_remaining).toString(),
        ]),
        ledgerCost: parse(ledger.rows[0]?.balance ?? '0').toString(),
        positions: (await getAs(h, u, '/v1/positions')).body.positions as Array<{
          qty: string;
          avgCost: string;
        }>,
      };
    };
    let s = await state();
    expect(s.lot).toEqual([['0.3', '27.01']]);
    expect(s.costBasis).toBe('27.01');
    expect(s.positions).toEqual([
      {
        symbol: 'DCOIN',
        qty: '0.3',
        qtyReserved: '0',
        qtyAvailable: '0.3',
        avgCost: '90.03333333',
      },
    ]);

    await setQuote(h, 'DCOIN', '100.00', '100.00');
    // piece 1
    const s1 = await placeOrder(h, u, newKey(), order('SELL', '0.1', '100.00'));
    expect(s1.body).toMatchObject({
      status: 'FILLED',
      execution: { price: '100.00', notional: '10.00' },
    });
    s = await state();
    expect(s.lot).toEqual([['0.2', '18.00666667']]);
    expect(s.ledgerCost).toBe('18.00666667');
    expect(s.costBasis).toBe('18.00666667');
    expect(s.positions).toEqual([
      {
        symbol: 'DCOIN',
        qty: '0.2',
        qtyReserved: '0',
        qtyAvailable: '0.2',
        avgCost: '90.03333335',
      },
    ]); // 18.00666667 / 0.2
    expect(await reconcileAccount(db.migrator, u.accountId)).toEqual([]);

    // piece 2: the exact tie 9.003333335 rounds half to even
    const s2 = await placeOrder(h, u, newKey(), order('SELL', '0.1', '100.00'));
    expect(s2.body.status).toBe('FILLED');
    s = await state();
    expect(s.lot).toEqual([['0.1', '9.00333333']]);
    expect(s.ledgerCost).toBe('9.00333333');
    expect(await reconcileAccount(db.migrator, u.accountId)).toEqual([]);

    // piece 3: by subtraction
    const s3 = await placeOrder(h, u, newKey(), order('SELL', '0.1', '100.00'));
    expect(s3.body.status).toBe('FILLED');
    s = await state();
    expect(s.ledgerCost).toBe('0');
    expect(s.positions).toEqual([]);

    const closures = await db.migrator.query<{
      cost_local: string;
      proceeds_local: string;
      trading_pnl_usd: string;
    }>(
      `SELECT c.cost_local, c.proceeds_local, c.trading_pnl_usd FROM lot_closures c
         JOIN position_lots l ON l.id = c.lot_id WHERE l.account_id = $1::uuid ORDER BY c.id`,
      [u.accountId],
    );
    expect(closures.rows.map((r) => parse(r.cost_local).toString())).toEqual([
      '9.00333333',
      '9.00333334',
      '9.00333333',
    ]);
    // total consumed 27.01; proceeds 3 x 10 = 30; realised 2.99; cash 10,000 - 27.01 + 30 = 10,002.99
    expect(
      closures.rows.reduce((acc, r) => acc.add(parse(r.cost_local)), parse('0')).toString(),
    ).toBe('27.01');
    expect(parse(await cash(db, u.accountId)).toString()).toBe('10002.99');
    const p = (await getAs(h, u, '/v1/portfolio')).body;
    expect(p.exact).toMatchObject({
      cash: '10002.99',
      costBasis: '0.00',
      fees: '0.00',
      realisedPnl: '2.99',
    });
    expect(await reconcileAccount(db.migrator, u.accountId)).toEqual([]);
  });
});
