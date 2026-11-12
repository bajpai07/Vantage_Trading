import pg from 'pg';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NOW,
  accountState,
  command,
  createFundedAccount,
  createInstrument,
  run,
} from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';
import { parse } from '@vantage/money';
import { reconcileAccount } from '../ledger/reconcile.js';
import { ClientOrderIdMismatchError } from './errors.js';

let db: TestDatabase;
let aapl: TestInstrument;
beforeAll(async () => {
  db = await createTestDatabase();
  aapl = await createInstrument(db, 'AAPL');
});
afterAll(async () => {
  await db.dispose();
});

const clean = async (accountId: string): Promise<void> => {
  expect(await reconcileAccount(db.app, accountId)).toEqual([]); // trading checks are ON by default (D-56)
};
const one = async (sql: string, params: unknown[]): Promise<pg.QueryResultRow> => {
  const r = await db.migrator.query(sql, params);
  expect(r.rows).toHaveLength(1);
  return r.rows[0] as pg.QueryResultRow;
};
const T1 = NOW;
const T2 = new Date(NOW.getTime() + 60_000);

describe('1. golden vectors end to end (every figure hard-coded and hand-checked)', () => {
  it('vector 1 and 2: BUY 10 (190.04) then SELL 10 at bid 195.00 (194.96), realised +49.20', async () => {
    const acct = await createFundedAccount(db.app);

    // ---- BUY 10: ask 190.00 x 1.0002 = 190.038 -> up to 190.04; notional 1900.40; fee 0
    const buy = command(acct, aapl, { clientOrderId: 'g1-buy', last: '189.97' });
    const r1 = await run(db.app, buy);
    expect(r1.outcome).toBe('FILLED');
    if (r1.outcome !== 'FILLED') return;
    expect(r1.replayed).toBe(false);

    const order = await one(`SELECT * FROM orders WHERE id = $1::uuid`, [buy.orderId]);
    expect(order).toMatchObject({
      account_id: acct,
      instrument_id: aapl.id,
      client_order_id: 'g1-buy',
      side: 'BUY',
      type: 'MARKET',
      tif: 'DAY',
      qty: '10.0000000000',
      filled_qty: '10.0000000000',
      status: 'FILLED',
      reject_code: null,
      reserved_usd: '0.0000000000',
      version: 1,
    });
    const events = await db.migrator.query(
      `SELECT seq, type, payload FROM order_events WHERE order_id = $1::uuid ORDER BY seq`,
      [buy.orderId],
    );
    expect(events.rows.map((e) => `${String(e.seq)}:${String(e.type)}`)).toEqual([
      '1:CREATED',
      '2:ACCEPTED',
      '3:FILLED',
    ]);
    expect(events.rows[0]?.payload).toMatchObject({
      side: 'BUY',
      qty: '10',
      referencePrice: '190.00',
      symbol: 'AAPL',
    });

    const ex = await one(`SELECT * FROM executions WHERE order_id = $1::uuid`, [buy.orderId]);
    expect(ex).toMatchObject({
      id: r1.execution.id,
      account_id: acct,
      instrument_id: aapl.id,
      seq: 1,
      side: 'BUY',
      qty: '10.0000000000',
      price: '190.0400000000',
      currency: 'USD',
      fee_local: '0.0000000000',
      fx_rate_id: null,
      gross_usd: '1900.4000000000',
      fee_usd: '0.0000000000',
      slippage_bps: '2.0000',
      quote_bid: '189.9500000000',
      quote_ask: '190.0000000000',
      quote_last: '189.9700000000',
      quote_source: 'FIXTURE',
      quote_entitlement: 'DELAYED',
      model_version: 'QBX-1/r8he',
      ledger_tx_id: r1.ledgerTxId,
    });
    expect((ex.quote_ts as Date).toISOString()).toBe('2026-11-10T14:45:00.000Z');
    expect((ex.executed_at as Date).toISOString()).toBe('2026-11-10T15:00:00.000Z');

    const lot = await one(`SELECT * FROM position_lots WHERE account_id = $1::uuid`, [acct]);
    expect(lot).toMatchObject({
      open_execution_id: r1.execution.id,
      qty_initial: '10.0000000000',
      qty_open: '10.0000000000',
      cost_local_per_unit: '190.0400000000',
      cost_usd_per_unit: '190.0400000000',
      closed_at: null,
    });
    const pos = await one(`SELECT * FROM positions WHERE account_id = $1::uuid`, [acct]);
    expect(pos).toMatchObject({
      qty: '10.0000000000',
      avg_cost_local: '190.0400000000',
      realized_trading_pnl_usd: '0.0000000000',
      qty_reserved: '0.0000000000',
    });

    const tx = await one(
      `SELECT order_id, execution_id, kind::text AS kind, idempotency_key FROM ledger_transactions WHERE id = $1::uuid`,
      [r1.ledgerTxId],
    );
    expect(tx).toMatchObject({
      order_id: buy.orderId,
      execution_id: r1.execution.id,
      kind: 'FILL',
      idempotency_key: `fill:${buy.orderId}:1`,
    });
    const entries = await db.migrator.query(
      `SELECT la.type::text AS type, e.amount FROM ledger_entries e JOIN ledger_accounts la ON la.id = e.ledger_account_id WHERE e.transaction_id = $1::uuid ORDER BY la.type::text`,
      [r1.ledgerTxId],
    );
    expect(entries.rows).toEqual([
      { type: 'CASH', amount: '-1900.4000000000' },
      { type: 'POSITION_COST', amount: '1900.4000000000' },
    ]);
    // cash after the grant: 10000.00 - 1900.40 = 8099.60
    expect((await accountState(db, acct)).balances).toMatchObject({
      CASH: '8099.6000000000',
      POSITION_COST: '1900.4000000000',
      CAPITAL: '-10000.0000000000',
    });
    await clean(acct);

    // ---- SELL 10 at bid 195.00: 195.00 x 0.9998 = 194.961 -> down to 194.96; proceeds 1949.60
    const sell = command(acct, aapl, {
      side: 'SELL',
      bid: '195.00',
      ask: '195.05',
      clientOrderId: 'g2-sell',
      now: T2,
    });
    const r2 = await run(db.app, sell);
    if (r2.outcome !== 'FILLED') throw new Error(`expected a fill, got ${r2.outcome}`);
    expect(r2.execution).toMatchObject({
      price: '194.96',
      grossUsd: '1949.6',
      feeLocal: '0',
    });
    const lotAfter = await one(
      `SELECT qty_open, closed_at FROM position_lots WHERE id = $1::uuid`,
      [lot.id],
    );
    expect(lotAfter.qty_open).toBe('0.0000000000');
    expect((lotAfter.closed_at as Date).toISOString()).toBe(T2.toISOString());
    const closure = await one(`SELECT * FROM lot_closures WHERE lot_id = $1::uuid`, [lot.id]);
    expect(closure).toMatchObject({
      close_execution_id: r2.execution.id,
      qty: '10.0000000000',
      proceeds_local: '1949.6000000000',
      cost_local: '1900.4000000000',
      proceeds_usd: '1949.6000000000',
      cost_usd: '1900.4000000000',
      trading_pnl_usd: '49.2000000000',
      fx_pnl_usd: '0.0000000000',
    });
    const posAfter = await one(
      `SELECT qty, avg_cost_local, realized_trading_pnl_usd FROM positions WHERE account_id = $1::uuid`,
      [acct],
    );
    expect(posAfter).toEqual({
      qty: '0.0000000000',
      avg_cost_local: '0.0000000000',
      realized_trading_pnl_usd: '49.2000000000',
    });
    const state = await accountState(db, acct);
    // cash 8099.60 + 1949.60 = 10049.20; POSITION_COST 0; REALIZED_PNL -49.20; CAPITAL -10000; the sum is 0
    expect(state.balances).toMatchObject({
      CASH: '10049.2000000000',
      POSITION_COST: '0.0000000000',
      REALIZED_PNL: '-49.2000000000',
      CAPITAL: '-10000.0000000000',
      FEES: '0.0000000000',
    });
    const sum = await one(
      `SELECT SUM(balance) AS s FROM ledger_accounts WHERE account_id = $1::uuid`,
      [acct],
    );
    expect(sum.s).toBe('0.0000000000');
    await clean(acct);
  });

  it('vector 3: BUY 10 with a 10 bps commission: fee 1.9004, CASH -1902.3004, cash after the grant 8097.6996', async () => {
    const acct = await createFundedAccount(db.app);
    const feeSchedule = {
      commissionBps: '10',
      commissionMinLocal: '0',
      slippageBaseBps: '2',
      slippageSizeCoef: '0',
      modelVersion: 'QBX-1/r8he',
    };
    const buy = command(acct, aapl, { feeSchedule });
    const r = await run(db.app, buy);
    if (r.outcome !== 'FILLED') throw new Error('expected a fill');
    const ex = await one(
      `SELECT fee_local, fee_usd, gross_usd, price FROM executions WHERE order_id = $1::uuid`,
      [buy.orderId],
    );
    expect(ex).toEqual({
      fee_local: '1.9004000000',
      fee_usd: '1.9004000000',
      gross_usd: '1900.4000000000',
      price: '190.0400000000',
    });
    const entries = await db.migrator.query(
      `SELECT la.type::text AS type, e.amount FROM ledger_entries e JOIN ledger_accounts la ON la.id = e.ledger_account_id WHERE e.transaction_id = $1::uuid ORDER BY la.type::text`,
      [r.ledgerTxId],
    );
    // sum: -1902.3004 + 1.9004 + 1900.40 = 0 (fees are expensed, not part of the lot cost)
    expect(entries.rows).toEqual([
      { type: 'CASH', amount: '-1902.3004000000' },
      { type: 'FEES', amount: '1.9004000000' },
      { type: 'POSITION_COST', amount: '1900.4000000000' },
    ]);
    const state = await accountState(db, acct);
    expect(state.balances).toMatchObject({
      CASH: '8097.6996000000',
      FEES: '1.9004000000',
      POSITION_COST: '1900.4000000000',
    });
    const lot = await one(
      `SELECT cost_local_per_unit FROM position_lots WHERE account_id = $1::uuid`,
      [acct],
    );
    expect(lot.cost_local_per_unit).toBe('190.0400000000'); // the fee is NOT in the lot cost
    await clean(acct);
  });

  it('vector 4 (FIFO): buy 3 at ask 100.00 -> 100.02, buy 2 at ask 101.00 -> 101.03, sell 4 at bid 99.00 -> 98.98', async () => {
    const acct = await createFundedAccount(db.app);
    const b1 = await run(
      db.app,
      command(acct, aapl, { qty: '3', bid: '99.98', ask: '100.00', now: T1 }),
    );
    const b2 = await run(
      db.app,
      command(acct, aapl, { qty: '2', bid: '100.98', ask: '101.00', now: T2 }),
    );
    if (b1.outcome !== 'FILLED' || b2.outcome !== 'FILLED') throw new Error('expected fills');
    expect(b1.execution.price).toBe('100.02');
    expect(b2.execution.price).toBe('101.03');
    const sellAt = new Date(NOW.getTime() + 120_000);
    const sell = await run(
      db.app,
      command(acct, aapl, { side: 'SELL', qty: '4', bid: '99.00', ask: '99.05', now: sellAt }),
    );
    if (sell.outcome !== 'FILLED') throw new Error('expected a fill');
    expect(sell.execution.price).toBe('98.98'); // 99.00 x 0.9998 = 98.9802 -> down
    expect(sell.execution.grossUsd).toBe('395.92');

    const lots = await db.migrator.query(
      `SELECT id, qty_initial, qty_open, cost_local_per_unit, closed_at FROM position_lots WHERE account_id = $1::uuid ORDER BY opened_at, id`,
      [acct],
    );
    expect(
      lots.rows.map((l) => [
        l.qty_initial,
        l.qty_open,
        l.cost_local_per_unit,
        l.closed_at === null,
      ]),
    ).toEqual([
      ['3.0000000000', '0.0000000000', '100.0200000000', false], // lot 1 fully consumed
      ['2.0000000000', '1.0000000000', '101.0300000000', true], // lot 2: 1 share left
    ]);
    const closures = await db.migrator.query(
      `SELECT lot_id, qty, proceeds_local, cost_local, trading_pnl_usd FROM lot_closures ORDER BY id`,
    );
    // proceeds 395.92 split 3:1 = 296.94 and 98.98; costs 300.06 and 101.03; pnl -3.12 and -2.05 (total -5.17)
    expect(
      closures.rows
        .filter((c) => lots.rows.some((l) => l.id === c.lot_id))
        .map((c) => [c.qty, c.proceeds_local, c.cost_local, c.trading_pnl_usd]),
    ).toEqual([
      ['3.0000000000', '296.9400000000', '300.0600000000', '-3.1200000000'],
      ['1.0000000000', '98.9800000000', '101.0300000000', '-2.0500000000'],
    ]);
    const pos = await one(
      `SELECT qty, avg_cost_local, realized_trading_pnl_usd FROM positions WHERE account_id = $1::uuid`,
      [acct],
    );
    expect(pos).toEqual({
      qty: '1.0000000000',
      avg_cost_local: '101.0300000000',
      realized_trading_pnl_usd: '-5.1700000000',
    });
    // cash: 10000 - 300.06 - 202.06 + 395.92 = 9893.80; POSITION_COST 101.03; REALIZED_PNL +5.17 (a loss is a positive debit)
    const state = await accountState(db, acct);
    expect(state.balances).toMatchObject({
      CASH: '9893.8000000000',
      POSITION_COST: '101.0300000000',
      REALIZED_PNL: '5.1700000000',
      FEES: '0.0000000000',
    });
    await clean(acct);
  });
});

describe('2. every reject code is reachable and a reject changes nothing but the order trail', () => {
  async function expectReject(
    over: Parameters<typeof command>[2],
    code: string,
    setup?: (acct: string) => Promise<void>,
  ): Promise<void> {
    const acct = await createFundedAccount(db.app);
    if (setup !== undefined) await setup(acct);
    const before = await accountState(db, acct);
    const cmd = command(acct, aapl, over);
    const r = await run(db.app, cmd);
    expect(r.outcome, code).toBe('REJECTED');
    if (r.outcome !== 'REJECTED') return;
    expect(r.rejectCode).toBe(code);
    expect(r.order.status).toBe('REJECTED');

    const order = await one(
      `SELECT status::text AS status, reject_code, filled_qty FROM orders WHERE id = $1::uuid`,
      [cmd.orderId],
    );
    expect(order).toEqual({ status: 'REJECTED', reject_code: code, filled_qty: '0.0000000000' });
    const events = await db.migrator.query(
      `SELECT seq, type, payload FROM order_events WHERE order_id = $1::uuid ORDER BY seq`,
      [cmd.orderId],
    );
    expect(events.rows.map((e) => `${String(e.seq)}:${String(e.type)}`)).toEqual([
      '1:CREATED',
      '2:REJECTED',
    ]);
    expect(events.rows[1]?.payload).toMatchObject({ code, facts: { freshness: cmd.freshness } });

    const after = await accountState(db, acct);
    // exactly one more order and its two events; no execution, lot, closure, position or ledger change
    expect(after.counts).toEqual({
      ...before.counts,
      orders: (before.counts.orders ?? 0) + 1,
      events: (before.counts.events ?? 0) + 2,
    });
    expect(after.balances).toEqual(before.balances);
    expect(after.positions).toEqual(before.positions);
    expect(after.lots).toEqual(before.lots);
    await clean(acct);
  }

  it.each([
    ['TRADING_PAUSED', { tradingEnabled: false }],
    ['INSTRUMENT_NOT_TRADABLE', { instrument: { tradableIn: [] as string[] } }],
    ['INSTRUMENT_NOT_TRADABLE', { instrument: { status: 'DELISTED' as const } }],
    ['INSTRUMENT_NOT_TRADABLE', { instrument: { status: 'SELL_ONLY' as const } }], // a BUY on SELL_ONLY
    ['INSTRUMENT_HALTED', { instrument: { status: 'HALTED' as const } }],
    ['QTY_BELOW_MIN', { qty: '1', instrument: { minQty: '5' } }],
    ['QTY_STEP_VIOLATION', { qty: '2.5' }],
    ['NO_ELIGIBLE_QUOTE', { freshness: 'UNAVAILABLE' as const, quote: null }],
    ['NO_ELIGIBLE_QUOTE', { freshness: 'DELAYED' as const, allowExecutionOnDelayed: false }],
    ['MARKET_CLOSED', { freshness: 'CLOSED' as const }],
    ['STALE_QUOTE', { freshness: 'STALE' as const }],
    ['PRICE_MOVED', { referencePrice: '188.00' }],
    ['INSUFFICIENT_BUYING_POWER', { qty: '53' }], // 53 x 190.04 = 10072.12 > 10000
    ['INSUFFICIENT_POSITION', { side: 'SELL' as const, bid: '195.00', ask: '195.05' }], // nothing to sell
  ] as Array<[string, Parameters<typeof command>[2]]>)('%s', async (code, over) => {
    await expectReject(over, code);
  });

  // D-57: a SELL whose commission is larger than its proceeds is a persisted business reject, never a DB error.
  // The schedule has a 5.00 minimum commission (built here, not seeded): BUY 3 at ask 2.00 -> 2.01, then SELL.
  const MIN_FEE_SCHEDULE = {
    commissionBps: '0',
    commissionMinLocal: '5',
    slippageBaseBps: '2',
    slippageSizeCoef: '0',
    modelVersion: 'QBX-1/r8he',
  };
  it('FEE_EXCEEDS_PROCEEDS: a 1-share SELL (proceeds 1.99) with a 5.00 minimum fee is rejected, money unchanged; a 3-share SELL (control) fills', async () => {
    const acct = await createFundedAccount(db.app);
    await run(
      db.app,
      command(acct, aapl, {
        clientOrderId: 'fee-buy',
        qty: '3',
        bid: '1.99',
        ask: '2.00',
        feeSchedule: { ...MIN_FEE_SCHEDULE, commissionMinLocal: '0' },
      }),
    );
    const before = await accountState(db, acct);
    const tiny = command(acct, aapl, {
      side: 'SELL',
      qty: '1',
      bid: '2.00',
      ask: '2.05',
      clientOrderId: 'fee-sell-1',
      feeSchedule: MIN_FEE_SCHEDULE,
    });
    const r = await run(db.app, tiny);
    expect(r).toMatchObject({ outcome: 'REJECTED', rejectCode: 'FEE_EXCEEDS_PROCEEDS' });
    const order = await one(
      `SELECT status::text AS status, reject_code FROM orders WHERE id = $1::uuid`,
      [tiny.orderId],
    );
    expect(order).toEqual({ status: 'REJECTED', reject_code: 'FEE_EXCEEDS_PROCEEDS' });
    const after = await accountState(db, acct);
    expect(after.balances).toEqual(before.balances);
    expect(after.positions).toEqual(before.positions);
    expect(after.lots).toEqual(before.lots);
    expect(after.counts).toEqual({
      ...before.counts,
      orders: (before.counts.orders ?? 0) + 1,
      events: (before.counts.events ?? 0) + 2,
    });

    // control: 3 shares at bid 2.00 -> 1.99 each, proceeds 5.97 > fee 5.00: fills, cash +0.97
    const big3 = command(acct, aapl, {
      side: 'SELL',
      qty: '3',
      bid: '2.00',
      ask: '2.05',
      clientOrderId: 'fee-sell-3',
      feeSchedule: MIN_FEE_SCHEDULE,
    });
    const ok = await run(db.app, big3);
    expect(ok.outcome).toBe('FILLED');
    const cash = await one(
      `SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'CASH'`,
      [acct],
    );
    expect(parse(cash.balance as string).toString()).toBe(
      parse(before.balances.CASH ?? '0')
        .add(parse('0.97'))
        .toString(),
    );
    await clean(acct);
  });

  it('ACCOUNT_NOT_ACTIVE: a frozen account and a suspended user are both rejected (control: ACTIVE trades)', async () => {
    await expectReject({}, 'ACCOUNT_NOT_ACTIVE', async (acct) => {
      await db.migrator.query(`UPDATE accounts SET status = 'FROZEN_RECON' WHERE id = $1::uuid`, [
        acct,
      ]);
    });
    await expectReject({}, 'ACCOUNT_NOT_ACTIVE', async (acct) => {
      await db.migrator.query(
        `UPDATE users SET status = 'SUSPENDED' WHERE id = (SELECT user_id FROM accounts WHERE id = $1::uuid)`,
        [acct],
      );
    });
    const ok = await createFundedAccount(db.app);
    expect((await run(db.app, command(ok, aapl))).outcome).toBe('FILLED');
  });

  it('DELAYED is accepted when allowed and rejected when not (controls); REAL_TIME is accepted either way', async () => {
    const acct = await createFundedAccount(db.app);
    expect(
      (
        await run(
          db.app,
          command(acct, aapl, { freshness: 'DELAYED', allowExecutionOnDelayed: true, qty: '1' }),
        )
      ).outcome,
    ).toBe('FILLED');
    expect(
      (
        await run(
          db.app,
          command(acct, aapl, { freshness: 'DELAYED', allowExecutionOnDelayed: false, qty: '1' }),
        )
      ).outcome,
    ).toBe('REJECTED');
    expect(
      (
        await run(
          db.app,
          command(acct, aapl, { freshness: 'REAL_TIME', allowExecutionOnDelayed: false, qty: '1' }),
        )
      ).outcome,
    ).toBe('FILLED');
    await clean(acct);
  });

  it('a reject is not a malformed order: an invalid quantity throws and stores nothing', async () => {
    const acct = await createFundedAccount(db.app);
    const before = await accountState(db, acct);
    await expect(run(db.app, command(acct, aapl, { qty: '0' }))).rejects.toThrow();
    await expect(run(db.app, command(acct, aapl, { qty: 'abc' }))).rejects.toThrow();
    expect(await accountState(db, acct)).toEqual(before);
  });
});

describe('3. replay never fills twice', () => {
  it('the same clientOrderId and parameters twice return the same order: one execution, one ledger transaction', async () => {
    const acct = await createFundedAccount(db.app);
    const first = command(acct, aapl, { clientOrderId: 'replay-1', qty: '2' });
    const again = command(acct, aapl, { clientOrderId: 'replay-1', qty: '2' }); // a new orderId, same client id
    const r1 = await run(db.app, first);
    const r2 = await run(db.app, again);
    if (r1.outcome !== 'FILLED' || r2.outcome !== 'FILLED') throw new Error('expected fills');
    expect(r1.replayed).toBe(false);
    expect(r2.replayed).toBe(true);
    expect(r2.order.id).toBe(first.orderId); // the stored order, not the new id
    expect(r2.execution).toEqual(r1.execution);
    expect(r2.ledgerTxId).toBe(r1.ledgerTxId);
    const state = await accountState(db, acct);
    expect(state.counts).toMatchObject({
      orders: 1,
      executions: 1,
      lots: 1,
      ledgerTransactions: 2,
    }); // the grant plus one fill
    expect(state.balances.CASH).toBe('9619.9200000000'); // 10000 - 2 x 190.04, charged once
    await clean(acct);
  });

  it('a replayed REJECTED order returns the same rejection and records nothing new', async () => {
    const acct = await createFundedAccount(db.app);
    const c = () => command(acct, aapl, { clientOrderId: 'replay-rej', freshness: 'STALE' });
    const r1 = await run(db.app, c());
    const r2 = await run(db.app, c());
    expect(r1).toMatchObject({ outcome: 'REJECTED', rejectCode: 'STALE_QUOTE', replayed: false });
    expect(r2).toMatchObject({ outcome: 'REJECTED', rejectCode: 'STALE_QUOTE', replayed: true });
    expect((await accountState(db, acct)).counts.orders).toBe(1);
  });

  it('the same clientOrderId with different parameters throws ClientOrderIdMismatchError and changes nothing', async () => {
    const acct = await createFundedAccount(db.app);
    await run(db.app, command(acct, aapl, { clientOrderId: 'mm-1', qty: '2' }));
    const before = await accountState(db, acct);
    const variants = [
      { qty: '3' },
      { side: 'SELL' as const, bid: '195.00', ask: '195.05' },
      { referencePrice: '190.50' },
    ];
    for (const v of variants) {
      await expect(
        run(db.app, command(acct, aapl, { clientOrderId: 'mm-1', qty: '2', ...v })),
      ).rejects.toBeInstanceOf(ClientOrderIdMismatchError);
    }
    const other = await createInstrument(db, 'MSFT');
    await expect(
      run(db.app, command(acct, other, { clientOrderId: 'mm-1', qty: '2' })),
    ).rejects.toBeInstanceOf(ClientOrderIdMismatchError);
    expect(await accountState(db, acct)).toEqual(before);
  });

  it('100 parallel calls with the same clientOrderId produce exactly one execution', async () => {
    const acct = await createFundedAccount(db.app);
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 25 });
    pool.on('error', () => undefined);
    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          run(pool, command(acct, aapl, { clientOrderId: 'parallel-same', qty: '1' })),
        ),
      );
      expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      const state = await accountState(db, acct);
      expect(state.counts).toMatchObject({ orders: 1, executions: 1, ledgerTransactions: 2 });
      expect(state.balances.CASH).toBe('9809.9600000000');
      await clean(acct);
    } finally {
      await pool.end();
    }
  });
});

describe('4. atomicity', () => {
  it('a failure after the ledger post leaves nothing behind, and the retry then succeeds exactly once', async () => {
    const acct = await createFundedAccount(db.app);
    const before = await accountState(db, acct);
    const cmd = command(acct, aapl, { clientOrderId: 'atomic-1', qty: '4' });
    await expect(
      run(db.app, cmd, {
        afterLedgerPost: () => {
          throw new Error('injected failure after the ledger post');
        },
      }),
    ).rejects.toThrow('injected failure');
    // no order, execution, lot, position change or ledger transaction survived
    expect(await accountState(db, acct)).toEqual(before);
    const gone = await db.migrator.query(`SELECT 1 FROM orders WHERE id = $1::uuid`, [cmd.orderId]);
    expect(gone.rowCount).toBe(0);
    const tx = await db.migrator.query(
      `SELECT 1 FROM ledger_transactions WHERE idempotency_key = $1`,
      [`fill:${cmd.orderId}:1`],
    );
    expect(tx.rowCount).toBe(0);

    // the retry (same command) succeeds once
    const r = await run(db.app, cmd);
    expect(r).toMatchObject({ outcome: 'FILLED', replayed: false });
    const after = await accountState(db, acct);
    expect(after.counts).toMatchObject({
      orders: 1,
      executions: 1,
      lots: 1,
      ledgerTransactions: 2,
    });
    expect(after.balances.CASH).toBe('9239.8400000000'); // 10000 - 4 x 190.04
    await clean(acct);
  });
});
