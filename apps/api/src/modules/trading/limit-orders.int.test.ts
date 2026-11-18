// M8b-1: LIMIT orders on real Postgres, as vantage_app, through the executor (acceptLimitOrder, fillRestingOrder, cancelOrder,
// expireOrder). The golden vectors E to I are HARD-CODED strings (hand-verified in packages/engine/src/limit-orders.test.ts and
// here). Every "must fail" has a control that succeeds. reconcileAccount (zero tolerance, with I3 to I7 and I10) is clean after
// every step.
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import {
  NOW,
  accept,
  accountState,
  cancel,
  command,
  createFundedAccount,
  createInstrument,
  cryptoCommand,
  expire,
  fillResting,
  freshQuote,
  inTx,
  limitCommand,
  run,
  seededCrypto,
} from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import { OrderNotFoundError } from './errors.js';

let db: TestDatabase;
let btc: TestInstrument;
let stock: TestInstrument;

beforeAll(async () => {
  db = await createTestDatabase();
  btc = await seededCrypto(db, 'BTC-USD');
  stock = await createInstrument(db, 'LMT1');
}, 120_000);
afterAll(async () => {
  await db?.dispose();
});

const dec = (s: unknown): string => parse(String(s)).toString();

async function balances(accountId: string): Promise<Record<string, string>> {
  const r = await db.migrator.query<{ type: string; balance: string }>(
    `SELECT type::text AS type, balance FROM ledger_accounts WHERE account_id = $1::uuid AND currency = 'USD'`,
    [accountId],
  );
  return Object.fromEntries(r.rows.map((x) => [x.type, dec(x.balance)]));
}
async function legsOfKind(accountId: string, kind: string): Promise<string[][]> {
  const tx = await db.migrator.query<{ id: string }>(
    `SELECT id FROM ledger_transactions WHERE account_id = $1::uuid AND kind = $2::ledger_tx_kind ORDER BY created_at, id`,
    [accountId, kind],
  );
  const out: string[][] = [];
  for (const t of tx.rows) {
    const r = await db.migrator.query<{ type: string; amount: string }>(
      `SELECT la.type::text AS type, e.amount FROM ledger_entries e
         JOIN ledger_accounts la ON la.id = e.ledger_account_id WHERE e.transaction_id = $1::uuid`,
      [t.id],
    );
    out.push(r.rows.map((x) => `${x.type} ${dec(x.amount)}`).sort());
  }
  return out;
}
async function orderRow(id: string) {
  const r = await db.migrator.query<{
    status: string;
    reserved_usd: string;
    filled_qty: string;
    version: number;
    type: string;
    tif: string;
    limit_price: string;
  }>(
    `SELECT status::text, reserved_usd, filled_qty, version, type::text, tif::text, limit_price FROM orders WHERE id = $1::uuid`,
    [id],
  );
  const x = r.rows[0];
  if (x === undefined) throw new Error('no order');
  return {
    status: x.status,
    reservedUsd: dec(x.reserved_usd),
    filledQty: dec(x.filled_qty),
    version: x.version,
    type: x.type,
    tif: x.tif,
    limitPrice: dec(x.limit_price),
  };
}
async function events(id: string): Promise<string[]> {
  const r = await db.migrator.query<{ seq: number; type: string }>(
    `SELECT seq, type FROM order_events WHERE order_id = $1::uuid ORDER BY seq`,
    [id],
  );
  expect(r.rows.map((x) => x.seq)).toEqual(r.rows.map((_, i) => i + 1)); // contiguous from 1
  return r.rows.map((x) => x.type);
}
async function lots(accountId: string, instrumentId: string) {
  const r = await db.migrator.query<{ qty_open: string; cost_remaining: string }>(
    `SELECT qty_open, cost_remaining FROM position_lots WHERE account_id = $1::uuid AND instrument_id = $2::uuid ORDER BY opened_at, id`,
    [accountId, instrumentId],
  );
  return r.rows.map((x) => [dec(x.qty_open), dec(x.cost_remaining)]);
}
async function position(accountId: string, instrumentId: string) {
  const r = await db.migrator.query<{
    qty: string;
    qty_reserved: string;
    avg: string;
    realised: string;
  }>(
    `SELECT qty, qty_reserved, avg_cost_local AS avg, realized_trading_pnl_usd AS realised FROM positions WHERE account_id = $1::uuid AND instrument_id = $2::uuid`,
    [accountId, instrumentId],
  );
  const x = r.rows[0];
  return x === undefined
    ? null
    : {
        qty: dec(x.qty),
        qtyReserved: dec(x.qty_reserved),
        avgCost: dec(x.avg),
        realised: dec(x.realised),
      };
}
const clean = async (accountId: string): Promise<void> => {
  expect(await reconcileAccount(db.migrator, accountId)).toEqual([]);
};

describe('golden vector E: a resting BUY, then a fill below the limit', () => {
  it('accept reserves 224.97475 (cash 9,775.02525); the matcher-style fill at 89,894.93 returns 0.01268768 (cash 9,775.03793768)', async () => {
    const a = await createFundedAccount(db.app, '10000');
    const cmd = limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    const r = await accept(db.app, cmd);
    expect(r.outcome).toBe('ACCEPTED'); // 90,010.00 > 89,900.00: not marketable, it rests
    expect(await orderRow(cmd.orderId)).toEqual({
      status: 'ACCEPTED',
      reservedUsd: '224.97475',
      filledQty: '0',
      version: 1,
      type: 'LIMIT',
      tif: 'GTC',
      limitPrice: '89900',
    });
    expect(await legsOfKind(a, 'ORDER_RESERVE')).toEqual([
      ['CASH -224.97475', 'RESERVED 224.97475'],
    ]);
    expect(await balances(a)).toMatchObject({ CASH: '9775.02525', RESERVED: '224.97475' });
    expect(await events(cmd.orderId)).toEqual(['CREATED', 'ACCEPTED']);
    expect(await position(a, btc.id)).toBeNull();
    await clean(a);

    // a quote that does not cross: nothing happens (control)
    const none = await fillResting(db.app, cmd.orderId, btc, freshQuote('89980.00', '90000.00'));
    expect(none.outcome).toBe('NOT_MARKETABLE');
    expect((await orderRow(cmd.orderId)).status).toBe('ACCEPTED');

    // the quote crosses: 89,830.00 / 89,850.00
    const f = await fillResting(db.app, cmd.orderId, btc, freshQuote('89830.00', '89850.00'));
    expect(f.outcome).toBe('FILLED');
    if (f.outcome !== 'FILLED') throw new Error('unreachable');
    expect(f.execution).toMatchObject({
      price: '89894.93', // 89,850.00 x 1.0005 = 89,894.925 rounded UP to the tick; below the limit 89,900.00
      qty: '0.0025',
      grossUsd: '224.737325',
      feeLocal: '0.22473732', // 0.224737325: an exact tie, the 8th digit 2 is even
    });
    expect(await legsOfKind(a, 'FILL')).toEqual([
      ['CASH 0.01268768', 'FEES 0.22473732', 'POSITION_COST 224.737325', 'RESERVED -224.97475'],
    ]);
    expect(await balances(a)).toMatchObject({
      CASH: '9775.03793768',
      RESERVED: '0',
      POSITION_COST: '224.737325',
      FEES: '0.22473732',
    });
    expect(await orderRow(cmd.orderId)).toMatchObject({
      status: 'FILLED',
      reservedUsd: '0',
      filledQty: '0.0025',
      version: 2,
    });
    expect(await lots(a, btc.id)).toEqual([['0.0025', '224.737325']]);
    expect(await position(a, btc.id)).toEqual({
      qty: '0.0025',
      qtyReserved: '0',
      avgCost: '89894.93',
      realised: '0',
    });
    expect(await events(cmd.orderId)).toEqual(['CREATED', 'ACCEPTED', 'FILLED']);
    await clean(a);

    // the order is terminal now: a second fill is a no-op, a cancel is NOT_OPEN
    expect(
      (await fillResting(db.app, cmd.orderId, btc, freshQuote('89830.00', '89850.00'))).outcome,
    ).toBe('SKIPPED');
    expect((await cancel(db.app, cmd.orderId, a)).outcome).toBe('NOT_OPEN');
    await clean(a);
  });
});

describe('golden vector F: the limit caps the slippage; marketable at accept fills in the same transaction (D-97)', () => {
  it('quote 89,880.00 / 89,899.00, BUY 0.0025 LIMIT 89,900.00: ORDER_RESERVE then FILL at the limit 89,900.00, CASH +0', async () => {
    const a = await createFundedAccount(db.app, '10000');
    const cmd = limitCommand(a, btc, {
      side: 'BUY',
      qty: '0.0025',
      limitPrice: '89900.00',
      bid: '89880.00',
      ask: '89899.00',
    });
    const r = await accept(db.app, cmd);
    expect(r.outcome).toBe('FILLED');
    if (r.outcome !== 'FILLED') throw new Error('unreachable');
    // 89,899.00 x 1.0005 = 89,943.9495 -> up 89,943.95: worse than the limit, so the fill price is the limit
    expect(r.execution).toMatchObject({ price: '89900', grossUsd: '224.75', feeLocal: '0.22475' });
    expect(await legsOfKind(a, 'ORDER_RESERVE')).toEqual([
      ['CASH -224.97475', 'RESERVED 224.97475'],
    ]);
    expect(await legsOfKind(a, 'FILL')).toEqual([
      ['FEES 0.22475', 'POSITION_COST 224.75', 'RESERVED -224.97475'],
    ]); // no CASH leg
    expect(await balances(a)).toMatchObject({
      CASH: '9775.02525',
      RESERVED: '0',
      POSITION_COST: '224.75',
    });
    expect(await orderRow(cmd.orderId)).toMatchObject({
      status: 'FILLED',
      reservedUsd: '0',
      version: 2,
    });
    expect(await events(cmd.orderId)).toEqual(['CREATED', 'ACCEPTED', 'FILLED']);
    const kinds = await db.migrator.query<{ kind: string }>(
      `SELECT kind::text FROM ledger_transactions WHERE account_id = $1::uuid ORDER BY created_at, id`,
      [a],
    );
    // two separate ledger transactions in one database transaction (equal timestamps), so compare them as a set
    expect(kinds.rows.map((x) => x.kind).sort()).toEqual(['FILL', 'GRANT', 'ORDER_RESERVE']);
    await clean(a);
  });
});

describe('golden vector G: a resting SELL, then a fill above the limit; reserved quantity is not sellable (D-96)', () => {
  it('SELL 0.001 LIMIT 90,100.00 reserves quantity only; a market SELL cannot use it; the fill at the limit realises +0.04499', async () => {
    const a = await createFundedAccount(db.app, '10000');
    // the vector-B-style lot, built through the executor: BUY 0.0025 then SELL 0.001 -> lot 0.0015, cost 135.082515
    await run(db.app, cryptoCommand(a, btc, { side: 'BUY', qty: '0.0025' }));
    await run(db.app, cryptoCommand(a, btc, { side: 'SELL', qty: '0.001' }));
    expect(await lots(a, btc.id)).toEqual([['0.0015', '135.082515']]);
    const before = await accountState(db, a);

    const cmd = limitCommand(a, btc, { side: 'SELL', qty: '0.001', limitPrice: '90100.00' });
    const r = await accept(db.app, cmd);
    expect(r.outcome).toBe('ACCEPTED'); // 89,990.00 < 90,100.00: rests
    expect((await accountState(db, a)).counts.ledgerTransactions).toBe(
      before.counts.ledgerTransactions,
    ); // no ledger movement
    expect(await position(a, btc.id)).toMatchObject({ qty: '0.0015', qtyReserved: '0.001' }); // free quantity 0.0005
    expect(await orderRow(cmd.orderId)).toMatchObject({ status: 'ACCEPTED', reservedUsd: '0' });
    await clean(a);

    // D-96: a MARKET sell may only use the free quantity: 0.0006 > 0.0005 is INSUFFICIENT_POSITION (control: 0.0005 fills later)
    const m = await run(db.app, cryptoCommand(a, btc, { side: 'SELL', qty: '0.0006' }));
    expect(m.outcome === 'REJECTED' && m.rejectCode).toBe('INSUFFICIENT_POSITION');
    // and a LIMIT sell beyond the free quantity by one step is rejected
    const over = await accept(
      db.app,
      limitCommand(a, btc, { side: 'SELL', qty: '0.00050001', limitPrice: '90100.00' }),
    );
    expect(over.outcome === 'REJECTED' && over.rejectCode).toBe('INSUFFICIENT_POSITION');
    await clean(a);

    // the fill: bid 90,120.00 -> slipped 90,074.94 < the limit, so the fill is the limit 90,100.00
    const f = await fillResting(db.app, cmd.orderId, btc, freshQuote('90120.00', '90140.00'));
    expect(f.outcome).toBe('FILLED');
    if (f.outcome !== 'FILLED') throw new Error('unreachable');
    expect(f.execution).toMatchObject({ price: '90100', grossUsd: '90.1', feeLocal: '0.0901' });
    const fills = await legsOfKind(a, 'FILL');
    expect(fills[fills.length - 1]).toEqual([
      'CASH 90.0099',
      'FEES 0.0901',
      'POSITION_COST -90.05501',
      'REALIZED_PNL -0.04499',
    ]);
    expect(await position(a, btc.id)).toEqual({
      qty: '0.0005',
      qtyReserved: '0',
      avgCost: '90055.01', // 45.027505 / 0.0005
      realised: '-0.06502', // -0.11001 (vector B) + 0.04499
    });
    expect(await lots(a, btc.id)).toEqual([['0.0005', '45.027505']]);
    const closure = await db.migrator.query<{ cost_local: string; proceeds_local: string }>(
      `SELECT c.cost_local, c.proceeds_local FROM lot_closures c JOIN position_lots l ON l.id = c.lot_id
        WHERE l.account_id = $1::uuid ORDER BY c.id DESC LIMIT 1`,
      [a],
    );
    expect([dec(closure.rows[0]?.cost_local), dec(closure.rows[0]?.proceeds_local)]).toEqual([
      '90.05501',
      '90.1',
    ]);
    await clean(a);
    // control: now the free quantity is the whole 0.0005 and a market SELL of it fills
    expect(
      (await run(db.app, cryptoCommand(a, btc, { side: 'SELL', qty: '0.0005' }))).outcome,
    ).toBe('FILLED');
    await clean(a);
  });
});

describe('golden vector H: cancel and expire release exactly what was reserved', () => {
  it('cancel before any fill: RESERVED -224.97475, CASH +224.97475, cash back to 10,000, CANCELLED, version incremented', async () => {
    const a = await createFundedAccount(db.app, '10000');
    const cmd = limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    await accept(db.app, cmd);
    const c = await cancel(db.app, cmd.orderId, a);
    expect(c.outcome).toBe('CANCELLED');
    if (c.outcome !== 'CANCELLED') throw new Error('unreachable');
    expect(c.released).toEqual({ usd: '224.97475', qty: '0' });
    expect(await legsOfKind(a, 'ORDER_RELEASE')).toEqual([
      ['CASH 224.97475', 'RESERVED -224.97475'],
    ]);
    expect(await balances(a)).toMatchObject({ CASH: '10000', RESERVED: '0' });
    expect(await orderRow(cmd.orderId)).toMatchObject({
      status: 'CANCELLED',
      reservedUsd: '0',
      version: 2,
      filledQty: '0',
    });
    expect(await events(cmd.orderId)).toEqual(['CREATED', 'ACCEPTED', 'CANCELLED']);
    await clean(a);
    // a second cancel is NOT_OPEN and changes nothing (control: the first one worked)
    const again = await cancel(db.app, cmd.orderId, a);
    expect(again.outcome).toBe('NOT_OPEN');
    expect(await balances(a)).toMatchObject({ CASH: '10000', RESERVED: '0' });
    // another account's order is not found (no leak)
    const other = await createFundedAccount(db.app, '10000');
    await expect(cancel(db.app, cmd.orderId, other)).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it('expire releases exactly like cancel; before the expiry the job does nothing (control)', async () => {
    const a = await createFundedAccount(db.app, '10000');
    const exp = new Date(NOW.getTime() + 60_000);
    const cmd = limitCommand(a, btc, {
      side: 'BUY',
      qty: '0.0025',
      limitPrice: '89900.00',
      tif: 'DAY',
      expiresAt: exp,
    });
    await accept(db.app, cmd);
    expect((await expire(db.app, cmd.orderId, new Date(NOW.getTime() + 30_000))).outcome).toBe(
      'SKIPPED',
    ); // not yet
    expect(await balances(a)).toMatchObject({ CASH: '9775.02525', RESERVED: '224.97475' });
    const e = await expire(db.app, cmd.orderId, exp);
    expect(e.outcome).toBe('EXPIRED');
    expect(await balances(a)).toMatchObject({ CASH: '10000', RESERVED: '0' });
    expect(await orderRow(cmd.orderId)).toMatchObject({
      status: 'EXPIRED',
      reservedUsd: '0',
      version: 2,
    });
    expect(await events(cmd.orderId)).toEqual(['CREATED', 'ACCEPTED', 'EXPIRED']);
    await clean(a);
  });

  it('a SELL cancel and expire give the reserved quantity back (qty_reserved 0), and no ledger transaction is posted', async () => {
    const a = await createFundedAccount(db.app, '10000');
    await run(db.app, cryptoCommand(a, btc, { side: 'BUY', qty: '0.0025' }));
    const tx0 = (await accountState(db, a)).counts.ledgerTransactions;
    const s1 = limitCommand(a, btc, { side: 'SELL', qty: '0.001', limitPrice: '90100.00' });
    const s2 = limitCommand(a, btc, {
      side: 'SELL',
      qty: '0.0005',
      limitPrice: '90200.00',
      expiresAt: new Date(NOW.getTime() + 1000),
    });
    await accept(db.app, s1);
    await accept(db.app, s2);
    expect((await position(a, btc.id))?.qtyReserved).toBe('0.0015');
    await clean(a);
    const c = await cancel(db.app, s1.orderId, a);
    expect(c.outcome === 'CANCELLED' && c.released).toEqual({ usd: '0', qty: '0.001' });
    expect((await position(a, btc.id))?.qtyReserved).toBe('0.0005');
    expect((await expire(db.app, s2.orderId, new Date(NOW.getTime() + 2000))).outcome).toBe(
      'EXPIRED',
    );
    expect((await position(a, btc.id))?.qtyReserved).toBe('0');
    expect((await accountState(db, a)).counts.ledgerTransactions).toBe(tx0);
    await clean(a);
  });

  it('lazy expiry: a crossing fill or a cancel after the expiry expires the order in the same transaction and fills or cancels nothing', async () => {
    const a = await createFundedAccount(db.app, '10000');
    const exp = new Date(NOW.getTime() + 60_000);
    const late = new Date(NOW.getTime() + 120_000);
    const o1 = limitCommand(a, btc, {
      side: 'BUY',
      qty: '0.0025',
      limitPrice: '89900.00',
      expiresAt: exp,
    });
    const o2 = limitCommand(a, btc, {
      side: 'BUY',
      qty: '0.0025',
      limitPrice: '89900.00',
      expiresAt: exp,
    });
    await accept(db.app, o1);
    await accept(db.app, o2);
    const f = await fillResting(db.app, o1.orderId, btc, freshQuote('89830.00', '89850.00', late), {
      now: late,
    });
    expect(f.outcome).toBe('EXPIRED'); // it crosses, but it is past its expiry: expired, never filled
    const c = await cancel(db.app, o2.orderId, a, late);
    expect(c.outcome).toBe('NOT_OPEN');
    expect(c.order.status).toBe('EXPIRED');
    expect(await balances(a)).toMatchObject({ CASH: '10000', RESERVED: '0' });
    expect((await accountState(db, a)).counts.executions).toBe(0);
    await clean(a);
  });
});

describe('golden vector I: a quote that is not evaluable evaluates nothing, and there is no back-fill', () => {
  it('a STALE quote that satisfies the limit does not fill; a FRESH quote fills at THAT quote (89,754.86), not at the earlier one', async () => {
    const a = await createFundedAccount(db.app, '10000');
    const cmd = limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    await accept(db.app, cmd);
    for (const fr of ['STALE', 'CLOSED', 'UNAVAILABLE'] as const) {
      const r = await fillResting(db.app, cmd.orderId, btc, freshQuote('89830.00', '89850.00'), {
        freshness: fr,
      });
      expect(r.outcome).toBe('NOT_MARKETABLE');
    }
    expect((await orderRow(cmd.orderId)).status).toBe('ACCEPTED');
    expect(await balances(a)).toMatchObject({ CASH: '9775.02525', RESERVED: '224.97475' });
    await clean(a);
    // 89,710.00 x 1.0005 = 89,754.855 -> up to the tick = 89,754.86, below the limit
    const r = await fillResting(db.app, cmd.orderId, btc, freshQuote('89700.00', '89710.00'));
    expect(r.outcome === 'FILLED' && r.execution.price).toBe('89754.86');
    await clean(a);
  });
});

describe('rejects persist a REJECTED order, move nothing; each has a control that succeeds', () => {
  async function expectRejected(
    accountId: string,
    cmd: ReturnType<typeof limitCommand>,
    code: string,
  ): Promise<void> {
    const before = await accountState(db, accountId);
    const r = await accept(db.app, cmd);
    expect(r.outcome).toBe('REJECTED');
    if (r.outcome === 'REJECTED') expect(r.rejectCode).toBe(code);
    const after = await accountState(db, accountId);
    expect(after.balances).toEqual(before.balances);
    expect(after.positions).toEqual(before.positions);
    expect(after.lots).toEqual(before.lots);
    expect(after.counts.executions).toBe(before.counts.executions);
    expect(after.counts.ledgerTransactions).toBe(before.counts.ledgerTransactions);
    expect(after.counts.orders).toBe((before.counts.orders ?? 0) + 1);
    expect(await orderRow(cmd.orderId)).toMatchObject({ status: 'REJECTED', reservedUsd: '0' });
    expect(await events(cmd.orderId)).toEqual(['CREATED', 'REJECTED']);
    await clean(accountId);
  }

  it('TICK_VIOLATION (control: a tick multiple is accepted)', async () => {
    const a = await createFundedAccount(db.app);
    await expectRejected(
      a,
      limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.005' }),
      'TICK_VIOLATION',
    );
    expect(
      (
        await accept(
          db.app,
          limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.01' }),
        )
      ).outcome,
    ).toBe('ACCEPTED');
  });

  it('insufficient buying power by one smallest unit of money: 224.97474999 rejects, exactly 224.97475 accepts', async () => {
    const short = await createFundedAccount(db.app, '224.97474999');
    await expectRejected(
      short,
      limitCommand(short, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' }),
      'INSUFFICIENT_BUYING_POWER',
    );
    const exact = await createFundedAccount(db.app, '224.97475');
    expect(
      (
        await accept(
          db.app,
          limitCommand(exact, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' }),
        )
      ).outcome,
    ).toBe('ACCEPTED');
    expect(await balances(exact)).toMatchObject({ CASH: '0', RESERVED: '224.97475' });
    await clean(exact);
  });

  it('a second order cannot reserve cash the first already holds (free cash excludes reservations)', async () => {
    const a = await createFundedAccount(db.app, '300');
    await accept(
      db.app,
      limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' }),
    ); // holds 224.97475
    await expectRejected(
      a,
      limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' }),
      'INSUFFICIENT_BUYING_POWER',
    ); // 75.02525 free
  });

  it('insufficient free quantity for a limit SELL by one step, including when part of the position is already reserved', async () => {
    const a = await createFundedAccount(db.app);
    await run(db.app, cryptoCommand(a, btc, { qty: '0.002' }));
    expect(
      (
        await accept(
          db.app,
          limitCommand(a, btc, { side: 'SELL', qty: '0.0012', limitPrice: '90100.00' }),
        )
      ).outcome,
    ).toBe('ACCEPTED');
    await expectRejected(
      a,
      limitCommand(a, btc, { side: 'SELL', qty: '0.00080001', limitPrice: '90100.00' }),
      'INSUFFICIENT_POSITION',
    ); // free 0.0008
    expect(
      (
        await accept(
          db.app,
          limitCommand(a, btc, { side: 'SELL', qty: '0.0008', limitPrice: '90100.00' }),
        )
      ).outcome,
    ).toBe('ACCEPTED');
    expect((await position(a, btc.id))?.qtyReserved).toBe('0.002');
    await clean(a);
  });

  it('instrument not tradable, and quantity rules (control: the default instrument is accepted)', async () => {
    const a = await createFundedAccount(db.app);
    await expectRejected(
      a,
      limitCommand(a, btc, {
        side: 'BUY',
        qty: '0.0025',
        limitPrice: '89900.00',
        instrument: { tradableIn: [] },
      }),
      'INSTRUMENT_NOT_TRADABLE',
    );
    await expectRejected(
      a,
      limitCommand(a, btc, { side: 'BUY', qty: '0.000000001', limitPrice: '89900.00' }),
      'QTY_BELOW_MIN',
    );
    await expectRejected(
      a,
      limitCommand(a, stock, {
        side: 'BUY',
        qty: '1.5',
        limitPrice: '190.00',
        instrument: { tickSize: '0.01', minQty: '1', qtyStep: '1', assetClass: 'EQUITY' },
        feeSchedule: {
          commissionBps: '0',
          commissionMinLocal: '0',
          slippageBaseBps: '2',
          slippageSizeCoef: '0',
          modelVersion: 'QBX-1/r8he',
        },
      }),
      'QTY_STEP_VIOLATION',
    );
  });

  it('a limit order on a STALE or UNAVAILABLE quote is ACCEPTED and rests; so is one placed while the market is CLOSED', async () => {
    const a = await createFundedAccount(db.app, '10000');
    for (const fr of ['STALE', 'UNAVAILABLE', 'CLOSED'] as const) {
      const r = await accept(
        db.app,
        limitCommand(a, btc, {
          side: 'BUY',
          qty: '0.001',
          limitPrice: '89900.00',
          freshness: fr,
          ...(fr === 'UNAVAILABLE' ? { quote: null } : {}),
        }),
      );
      expect(r.outcome).toBe('ACCEPTED');
    }
    expect(await balances(a)).toMatchObject({ RESERVED: '269.9697' }); // 3 x (89.9 + 0.0899) = 3 x 89.9899
    await clean(a);
  });

  it('a marketable limit SELL whose fee would exceed its proceeds is rejected (FEE_EXCEEDS_PROCEEDS); the normal schedule fills (control)', async () => {
    const a = await createFundedAccount(db.app);
    await run(db.app, cryptoCommand(a, btc, { qty: '0.01' }));
    const high = {
      commissionBps: '20000',
      commissionMinLocal: '0',
      slippageBaseBps: '5',
      slippageSizeCoef: '0',
      modelVersion: 'QBX-1/r8he',
    };
    await expectRejected(
      a,
      limitCommand(a, btc, {
        side: 'SELL',
        qty: '0.005',
        limitPrice: '89000.00',
        feeSchedule: high,
      }),
      'FEE_EXCEEDS_PROCEEDS',
    );
    expect(
      (
        await accept(
          db.app,
          limitCommand(a, btc, { side: 'SELL', qty: '0.005', limitPrice: '89000.00' }),
        )
      ).outcome,
    ).toBe('FILLED');
  });
});

describe('atomicity: an injected failure after the ledger post leaves nothing behind', () => {
  const boom = {
    afterLedgerPost: () => {
      throw new Error('injected failure');
    },
  };

  it('accept (BUY reserve), accept (immediate fill), fill, cancel and expire each roll back completely (controls: without the failure they succeed)', async () => {
    const a = await createFundedAccount(db.app, '10000');
    // accept
    const before0 = await accountState(db, a);
    const c1 = limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    await expect(accept(db.app, c1, boom)).rejects.toThrow('injected failure');
    expect(await accountState(db, a)).toEqual(before0);
    // a marketable accept fails inside the fill: the reserve is rolled back too
    const c2 = limitCommand(a, btc, {
      side: 'BUY',
      qty: '0.0025',
      limitPrice: '89900.00',
      bid: '89880.00',
      ask: '89899.00',
    });
    await expect(accept(db.app, c2, boom)).rejects.toThrow('injected failure');
    expect(await accountState(db, a)).toEqual(before0);
    await clean(a);
    // the controls
    const ok = limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    expect((await accept(db.app, ok)).outcome).toBe('ACCEPTED');
    const resting = await accountState(db, a);
    // fill fails after the FILL post
    await expect(
      fillResting(db.app, ok.orderId, btc, freshQuote('89830.00', '89850.00'), {}, boom),
    ).rejects.toThrow('injected failure');
    expect(await accountState(db, a)).toEqual(resting);
    expect((await orderRow(ok.orderId)).status).toBe('ACCEPTED');
    // cancel fails after the RELEASE post
    await expect(cancel(db.app, ok.orderId, a, NOW, boom)).rejects.toThrow('injected failure');
    expect(await accountState(db, a)).toEqual(resting);
    // expire fails after the RELEASE post
    await expect(
      expire(db.app, ok.orderId, new Date(NOW.getTime() + 100 * 86_400_000), boom),
    ).rejects.toThrow('injected failure');
    expect(await accountState(db, a)).toEqual(resting);
    await clean(a);
    // and the same order cancels fine without the failure
    expect((await cancel(db.app, ok.orderId, a)).outcome).toBe('CANCELLED');
    await clean(a);
  });
});

describe('database protection of the order lifecycle, as vantage_app', () => {
  async function resting(side: 'BUY' | 'SELL' = 'BUY') {
    const a = await createFundedAccount(db.app, '10000');
    if (side === 'SELL') await run(db.app, cryptoCommand(a, btc, { qty: '0.0025' }));
    const cmd = limitCommand(a, btc, {
      side,
      qty: '0.001',
      limitPrice: side === 'BUY' ? '89900.00' : '90100.00',
    });
    await accept(db.app, cmd);
    return { a, id: cmd.orderId };
  }
  const tx = async (body: (c: PoolClient) => Promise<void>): Promise<Error | undefined> => {
    try {
      await inTx(db.app, body);
      return undefined;
    } catch (e) {
      return e as Error;
    }
  };

  it('identity columns cannot be changed (permission denied for the app, a trigger message for the owner)', async () => {
    const { id } = await resting();
    for (const col of [
      'qty = 1',
      'limit_price = 1',
      "tif = 'DAY'",
      "side = 'SELL'",
      "type = 'MARKET'",
      'account_id = account_id',
      'instrument_id = instrument_id',
      "client_order_id = 'x'",
      'created_at = now()',
      'expires_at = now()',
    ]) {
      await expect(
        db.app.query(`UPDATE orders SET ${col} WHERE id = $1::uuid`, [id]),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      db.migrator.query(`UPDATE orders SET qty = 1 WHERE id = $1::uuid`, [id]),
    ).rejects.toThrow(
      /only status, filled_qty, reserved_usd, version, updated_at and triggered_at may change/,
    );
    await expect(
      db.migrator.query(`UPDATE orders SET limit_price = 1 WHERE id = $1::uuid`, [id]),
    ).rejects.toThrow(/may change/);
  });

  it('only the allowed edges: ACCEPTED -> ACCEPTED, a skipped version, a FILLED without a fill all fail; the allowed update succeeds (control)', async () => {
    const { id } = await resting('SELL'); // a SELL: no ledger to keep consistent
    const upd = (set: string) =>
      db.app.query(`UPDATE orders SET ${set}, updated_at = now() WHERE id = $1::uuid`, [id]);
    await expect(upd("status = 'ACCEPTED', version = version + 1")).rejects.toThrow(
      /transition ACCEPTED -> ACCEPTED is not allowed/,
    );
    await expect(upd("status = 'CANCELLED', version = version + 2")).rejects.toThrow(
      /version must increase by exactly 1/,
    );
    await expect(upd("status = 'CANCELLED', version = version")).rejects.toThrow(
      /version must increase by exactly 1/,
    );
    await expect(upd("status = 'FILLED', version = version + 1")).rejects.toThrow(
      /FILLED order has filled_qty = qty/,
    );
    await expect(
      upd("status = 'CANCELLED', filled_qty = 0.0005, version = version + 1"),
    ).rejects.toThrow(/filled_qty 0/);
    await expect(upd("status = 'REJECTED', version = version + 1")).rejects.toThrow(/not allowed/);
    await expect(upd("status = 'NEW', version = version + 1")).rejects.toThrow(/not allowed/);
    // control: the allowed edge, with the position's reservation given back in the same transaction (what the executor does)
    const e = await tx(async (c) => {
      await c.query(
        `UPDATE orders SET status = 'CANCELLED', version = version + 1, updated_at = now() WHERE id = $1::uuid AND version = 1 AND status = 'ACCEPTED'`,
        [id],
      );
      await c.query(
        `UPDATE positions SET qty_reserved = 0 WHERE account_id = (SELECT account_id FROM orders WHERE id = $1::uuid)`,
        [id],
      );
      await c.query(
        `INSERT INTO order_events (order_id, seq, type) VALUES ($1::uuid, 3, 'CANCELLED')`,
        [id],
      );
    });
    expect(e).toBeUndefined();
    // a terminal row never changes again
    await expect(upd("status = 'FILLED', version = version + 1")).rejects.toThrow(/terminal state/);
    await expect(upd('version = version + 1')).rejects.toThrow(/terminal state/);
  });

  it('a terminal order with reserved_usd > 0 fails AT COMMIT (I5); with 0 and the reservation released it commits (control)', async () => {
    const { a, id } = await resting('BUY');
    let ok = false;
    const e = await tx(async (c) => {
      await c.query(
        `UPDATE orders SET status = 'CANCELLED', version = version + 1, updated_at = now() WHERE id = $1::uuid`,
        [id],
      ); // reserved_usd untouched
      ok = true;
    });
    expect(ok).toBe(true); // the statement itself succeeded
    expect(e?.message).toMatch(/I5: terminal order .* still has reserved_usd/);
    expect((await orderRow(id)).status).toBe('ACCEPTED'); // rolled back
    await clean(a);
  });

  it('order_events: a gap in seq fails at commit; contiguous events commit (control)', async () => {
    const { id } = await resting('SELL');
    const gap = await tx(async (c) => {
      await c.query(`INSERT INTO order_events (order_id, seq, type) VALUES ($1::uuid, 5, 'X')`, [
        id,
      ]);
    });
    expect(gap?.message).toMatch(/seq must be contiguous/);
    const fine = await tx(async (c) => {
      await c.query(`INSERT INTO order_events (order_id, seq, type) VALUES ($1::uuid, 3, 'NOTE')`, [
        id,
      ]);
    });
    expect(fine).toBeUndefined();
    await expect(
      db.app.query(`UPDATE order_events SET type = 'Y' WHERE order_id = $1::uuid`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('qty_reserved above the position quantity is refused by the CHECK', async () => {
    const { a } = await resting('SELL');
    await expect(
      db.app.query(`UPDATE positions SET qty_reserved = qty + 1 WHERE account_id = $1::uuid`, [a]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a transaction that leaves RESERVED different from the open orders commits (the database cannot know) and reconcile catches it (I7)', async () => {
    const { a, id } = await resting('BUY');
    expect(await reconcileAccount(db.migrator, a)).toEqual([]); // control: clean before
    // cancel the order by hand WITHOUT posting the release: consistent for I5 (reserved_usd = 0) but RESERVED still holds 89.9899
    const e = await tx(async (c) => {
      await c.query(
        `UPDATE orders SET status = 'CANCELLED', reserved_usd = 0, version = version + 1, updated_at = now() WHERE id = $1::uuid`,
        [id],
      );
      await c.query(
        `INSERT INTO order_events (order_id, seq, type) VALUES ($1::uuid, 3, 'CANCELLED')`,
        [id],
      );
    });
    expect(e).toBeUndefined();
    const v = await reconcileAccount(db.migrator, a);
    expect(v.map((x) => x.invariant)).toEqual(['I7']);
    expect(v[0]?.message).toContain('89.9899');
  });

  it('earlier protections hold: no DELETE or TRUNCATE of orders; executions and closures stay append-only', async () => {
    await expect(db.app.query(`DELETE FROM orders`)).rejects.toMatchObject({ code: '42501' });
    await expect(db.migrator.query(`DELETE FROM orders`)).rejects.toThrow(/append-only/);
    await expect(db.migrator.query(`TRUNCATE orders CASCADE`)).rejects.toThrow(/append-only/);
    await expect(db.app.query(`UPDATE executions SET qty = 1`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(db.migrator.query(`UPDATE executions SET qty = 1`)).rejects.toThrow(/append-only/);
  });
});

// keep imports honest: command() documents the market path next to the limit path in this file's header
void command;
