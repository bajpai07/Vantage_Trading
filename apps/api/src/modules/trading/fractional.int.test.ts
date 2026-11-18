// M8: fractional quantities and crypto through executeMarketOrder, on real Postgres, as vantage_app.
// The golden vectors A-D are HARD-CODED strings (hand-verified in packages/engine/src/fractional.test.ts and here); the
// concurrency expectations are computed independently in the test with BigInt. Every "must fail" has a control.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { newId } from '../../ids.js';
import {
  NOW,
  SCHEDULE_CRYPTO,
  accountState,
  command,
  createFractionalInstrument,
  createFundedAccount,
  createInstrument,
  cryptoCommand,
  run,
  seededCrypto,
} from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import { executeMarketOrder } from './execute-market-order.js';
import type { ExecutionResult } from './execute-market-order.js';

let db: TestDatabase;
let big: pg.Pool;
let btc: TestInstrument;
let stock: TestInstrument;

beforeAll(async () => {
  db = await createTestDatabase();
  big = new pg.Pool({ connectionString: db.appUrl, max: 24 });
  btc = await seededCrypto(db, 'BTC-USD');
  stock = await createInstrument(db, 'FSTK');
}, 120_000);
afterAll(async () => {
  await big?.end().catch(() => undefined);
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

async function legsOf(txId: string): Promise<string[]> {
  const r = await db.migrator.query<{ type: string; amount: string }>(
    `SELECT la.type::text AS type, e.amount FROM ledger_entries e
       JOIN ledger_accounts la ON la.id = e.ledger_account_id WHERE e.transaction_id = $1::uuid`,
    [txId],
  );
  return r.rows.map((x) => `${x.type} ${dec(x.amount)}`).sort();
}

async function lotsOf(accountId: string, instrumentId: string) {
  const r = await db.migrator.query<{ qty_open: string; cost_remaining: string; closed: boolean }>(
    `SELECT qty_open, cost_remaining, closed_at IS NOT NULL AS closed FROM position_lots
      WHERE account_id = $1::uuid AND instrument_id = $2::uuid ORDER BY opened_at, id`,
    [accountId, instrumentId],
  );
  return r.rows.map((x) => ({
    qtyOpen: dec(x.qty_open),
    costRemaining: dec(x.cost_remaining),
    closed: x.closed,
  }));
}

async function positionOf(accountId: string, instrumentId: string) {
  const r = await db.migrator.query<{ qty: string; avg: string; realised: string }>(
    `SELECT qty, avg_cost_local AS avg, realized_trading_pnl_usd AS realised FROM positions
      WHERE account_id = $1::uuid AND instrument_id = $2::uuid`,
    [accountId, instrumentId],
  );
  const x = r.rows[0];
  return x === undefined
    ? null
    : { qty: dec(x.qty), avgCost: dec(x.avg), realised: dec(x.realised) };
}

const clean = async (accountId: string): Promise<void> => {
  expect(await reconcileAccount(db.migrator, accountId)).toEqual([]);
};

function filled(r: ExecutionResult) {
  if (r.outcome !== 'FILLED') throw new Error(`expected a fill, got ${r.rejectCode}`);
  return r;
}

describe('golden vectors A, B, C: BTC-USD with 5 bps slippage and 10 bps commission, grant 10,000', () => {
  it('A: BUY 0.0025, B: SELL 0.001, C: SELL the remaining 0.0015 reproduce every stated digit; reconcile is clean after each step', async () => {
    const a = await createFundedAccount(db.app, '10000');

    // ---- A -------------------------------------------------------------------------------------------------------
    const ra = filled(await run(db.app, cryptoCommand(a, btc, { side: 'BUY', qty: '0.0025' })));
    expect(ra.execution).toMatchObject({
      price: '90055.01', // 90,010.00 x 1.0005 = 90,055.005 rounded UP to the tick
      qty: '0.0025',
      grossUsd: '225.137525', // 0.0025 x 90,055.01
      feeLocal: '0.22513752', // 0.225137525: exact tie, 8th digit 2 is even
      slippageBps: '5',
      modelVersion: 'QBX-1/r8he',
    });
    expect(await legsOf(ra.ledgerTxId)).toEqual([
      'CASH -225.36266252',
      'FEES 0.22513752',
      'POSITION_COST 225.137525',
    ]);
    expect((await balances(a)).CASH).toBe('9774.63733748');
    expect(await lotsOf(a, btc.id)).toEqual([
      { qtyOpen: '0.0025', costRemaining: '225.137525', closed: false },
    ]);
    expect(await positionOf(a, btc.id)).toEqual({
      qty: '0.0025',
      avgCost: '90055.01',
      realised: '0',
    });
    await clean(a);

    // ---- B -------------------------------------------------------------------------------------------------------
    const rb = filled(await run(db.app, cryptoCommand(a, btc, { side: 'SELL', qty: '0.001' })));
    expect(rb.execution).toMatchObject({
      price: '89945', // 89,990.00 x 0.9995 = 89,945.005 rounded DOWN to the tick
      grossUsd: '89.945',
      feeLocal: '0.089945',
    });
    expect(await legsOf(rb.ledgerTxId)).toEqual([
      'CASH 89.855055',
      'FEES 0.089945',
      'POSITION_COST -90.05501', // 225.137525 x 0.001 / 0.0025
      'REALIZED_PNL 0.11001', // a loss of 0.11001 (89.945 - 90.05501)
    ]);
    const bal = await balances(a);
    expect(bal).toMatchObject({
      CASH: '9864.49239248',
      POSITION_COST: '135.082515',
      FEES: '0.31508252', // 0.22513752 + 0.089945
      REALIZED_PNL: '0.11001',
    });
    expect(await lotsOf(a, btc.id)).toEqual([
      { qtyOpen: '0.0015', costRemaining: '135.082515', closed: false },
    ]);
    expect(await positionOf(a, btc.id)).toEqual({
      qty: '0.0015',
      avgCost: '90055.01',
      realised: '-0.11001',
    });
    const closure = await db.migrator.query<{
      qty: string;
      proceeds_local: string;
      cost_local: string;
      trading_pnl_usd: string;
    }>(
      `SELECT c.qty, c.proceeds_local, c.cost_local, c.trading_pnl_usd FROM lot_closures c
         JOIN position_lots l ON l.id = c.lot_id WHERE l.account_id = $1::uuid`,
      [a],
    );
    expect(
      closure.rows.map((x) => [
        dec(x.qty),
        dec(x.proceeds_local),
        dec(x.cost_local),
        dec(x.trading_pnl_usd),
      ]),
    ).toEqual([['0.001', '89.945', '90.05501', '-0.11001']]);
    await clean(a);

    // ---- C -------------------------------------------------------------------------------------------------------
    const rc = filled(await run(db.app, cryptoCommand(a, btc, { side: 'SELL', qty: '0.0015' })));
    expect(rc.execution).toMatchObject({
      price: '89945',
      grossUsd: '134.9175',
      feeLocal: '0.1349175',
    });
    expect(await legsOf(rc.ledgerTxId)).toEqual([
      'CASH 134.7825825',
      'FEES 0.1349175',
      'POSITION_COST -135.082515', // the whole remaining cost, by subtraction
      'REALIZED_PNL 0.165015',
    ]);
    const fin = await balances(a);
    expect(fin).toMatchObject({
      CASH: '9999.27497498',
      POSITION_COST: '0',
      FEES: '0.45000002',
      REALIZED_PNL: '0.275025', // ledger sign: a loss of 0.275025 in total
    });
    expect(await lotsOf(a, btc.id)).toEqual([{ qtyOpen: '0', costRemaining: '0', closed: true }]);
    expect(await positionOf(a, btc.id)).toEqual({ qty: '0', avgCost: '0', realised: '-0.275025' });
    // total equity change -0.72502502 = fees 0.45000002 + realised loss 0.275025: 10,000 - 9,999.27497498 = 0.72502502
    expect(
      parse('10000')
        .sub(parse(fin.CASH ?? '0'))
        .toString(),
    ).toBe('0.72502502');
    expect(
      parse(fin.FEES ?? '0')
        .add(parse(fin.REALIZED_PNL ?? '0'))
        .toString(),
    ).toBe('0.72502502');
    await clean(a);
  });
});

describe('golden vector D: proportional cost rounding and the by-subtraction rule on a made-up fractional instrument', () => {
  it('a lot of 0.3 costing 27.01 sold in three pieces of 0.1 consumes 9.00333333, 9.00333334 and 9.00333333', async () => {
    // a made-up coin: tick 0.00000001, step and minimum 0.1. bid = ask = 90.03333333, no slippage or commission:
    // 0.3 x 90.03333333 = 27.009999999 -> 27.01 at 8 dp, so the lot costs exactly 27.01
    const coin = await createFractionalInstrument(db, 'DCOIN', { tick: '0.00000001', step: '0.1' });
    const a = await createFundedAccount(db.app, '10000');
    const mk = (side: 'BUY' | 'SELL', qty: string, px: string) =>
      cryptoCommand(a, coin, {
        side,
        qty,
        bid: px,
        ask: px,
        feeSchedule: {
          commissionBps: '0',
          commissionMinLocal: '0',
          slippageBaseBps: '0',
          slippageSizeCoef: '0',
          modelVersion: 'QBX-1/r8he',
        },
        instrument: { tickSize: '0.00000001', minQty: '0.1', qtyStep: '0.1' },
      });
    filled(await run(db.app, mk('BUY', '0.3', '90.03333333')));
    expect(await lotsOf(a, coin.id)).toEqual([
      { qtyOpen: '0.3', costRemaining: '27.01', closed: false },
    ]);
    expect((await balances(a)).POSITION_COST).toBe('27.01');

    const cost = async (): Promise<string[]> => {
      const r = await db.migrator.query<{ cost_local: string }>(
        `SELECT c.cost_local FROM lot_closures c JOIN position_lots l ON l.id = c.lot_id
          WHERE l.account_id = $1::uuid ORDER BY c.id`,
        [a],
      );
      return r.rows.map((x) => dec(x.cost_local));
    };
    // piece 1: 27.01 x 0.1 / 0.3 = 9.00333333...; remaining 18.00666667
    filled(await run(db.app, mk('SELL', '0.1', '100')));
    expect(await lotsOf(a, coin.id)).toEqual([
      { qtyOpen: '0.2', costRemaining: '18.00666667', closed: false },
    ]);
    expect((await balances(a)).POSITION_COST).toBe('18.00666667');
    await clean(a);
    // piece 2: 18.00666667 x 0.1 / 0.2 = 9.003333335, an exact tie, HALF_EVEN -> 9.00333334; remaining 9.00333333
    filled(await run(db.app, mk('SELL', '0.1', '100')));
    expect(await lotsOf(a, coin.id)).toEqual([
      { qtyOpen: '0.1', costRemaining: '9.00333333', closed: false },
    ]);
    expect((await balances(a)).POSITION_COST).toBe('9.00333333');
    await clean(a);
    // piece 3: the lot is fully consumed: exactly what is left
    filled(await run(db.app, mk('SELL', '0.1', '100')));
    expect(await lotsOf(a, coin.id)).toEqual([{ qtyOpen: '0', costRemaining: '0', closed: true }]);
    expect(await cost()).toEqual(['9.00333333', '9.00333334', '9.00333333']);
    expect((await balances(a)).POSITION_COST).toBe('0');
    // 9.00333333 + 9.00333334 + 9.00333333 = 27.01 exactly
    expect((await cost()).reduce((acc, c) => acc.add(parse(c)), parse('0')).toString()).toBe(
      '27.01',
    );
    await clean(a);
  });
});

describe('rejects persist a REJECTED order and move nothing; each has a control that fills', () => {
  async function expectRejected(
    accountId: string,
    cmd: ReturnType<typeof cryptoCommand>,
    code: string,
  ): Promise<void> {
    const before = await accountState(db, accountId);
    const r = await run(db.app, cmd);
    expect(r.outcome).toBe('REJECTED');
    if (r.outcome === 'REJECTED') expect(r.rejectCode).toBe(code);
    const after = await accountState(db, accountId);
    expect(after.balances).toEqual(before.balances); // no money moved
    expect(after.positions).toEqual(before.positions); // no shares moved
    expect(after.lots).toEqual(before.lots);
    expect(after.counts.executions).toBe(before.counts.executions);
    expect(after.counts.ledgerTransactions).toBe(before.counts.ledgerTransactions);
    expect(after.counts.orders).toBe((before.counts.orders ?? 0) + 1); // the REJECTED order itself
    const o = await db.migrator.query<{ status: string; reject_code: string; filled_qty: string }>(
      `SELECT status::text, reject_code, filled_qty FROM orders WHERE id = $1::uuid`,
      [cmd.orderId],
    );
    expect(o.rows[0]).toMatchObject({ status: 'REJECTED', reject_code: code });
    expect(dec(o.rows[0]?.filled_qty)).toBe('0');
    await clean(accountId);
  }

  it('a fractional stock quantity is QTY_STEP_VIOLATION and below the minimum is QTY_BELOW_MIN (control: a whole share fills)', async () => {
    const a = await createFundedAccount(db.app);
    await expectRejected(a, command(a, stock, { qty: '1.5' }), 'QTY_STEP_VIOLATION');
    await expectRejected(a, command(a, stock, { qty: '2.00000001' }), 'QTY_STEP_VIOLATION');
    await expectRejected(a, command(a, stock, { qty: '0.5' }), 'QTY_BELOW_MIN');
    filled(await run(db.app, command(a, stock, { qty: '1' })));
  });

  it('a crypto quantity below 0.00000001 is QTY_BELOW_MIN (control: the smallest step fills)', async () => {
    const a = await createFundedAccount(db.app);
    await expectRejected(a, cryptoCommand(a, btc, { qty: '0.000000001' }), 'QTY_BELOW_MIN');
    filled(await run(db.app, cryptoCommand(a, btc, { qty: '0.00000001' })));
  });

  it('a stale or unavailable crypto quote rejects (controls: a REAL_TIME quote fills)', async () => {
    const a = await createFundedAccount(db.app);
    await expectRejected(
      a,
      cryptoCommand(a, btc, { qty: '0.001', freshness: 'STALE' }),
      'STALE_QUOTE',
    );
    await expectRejected(
      a,
      cryptoCommand(a, btc, { qty: '0.001', freshness: 'UNAVAILABLE', quote: null }),
      'NO_ELIGIBLE_QUOTE',
    );
    filled(await run(db.app, cryptoCommand(a, btc, { qty: '0.001' })));
  });

  it('buying power by one smallest step: exactly enough cash fills, a larger quantity does not', async () => {
    // 0.0025 costs 225.36266252 (vector A): that cash fills it exactly (cash 0 after); one step more (0.00250001) does not
    const exact = await createFundedAccount(db.app, '225.36266252');
    await expectRejected(
      exact,
      cryptoCommand(exact, btc, { qty: '0.00250001' }),
      'INSUFFICIENT_BUYING_POWER',
    );
    filled(await run(db.app, cryptoCommand(exact, btc, { qty: '0.0025' })));
    expect((await balances(exact)).CASH).toBe('0');
    await clean(exact);
    const short = await createFundedAccount(db.app, '225.36266251'); // one smallest unit of money less
    await expectRejected(
      short,
      cryptoCommand(short, btc, { qty: '0.0025' }),
      'INSUFFICIENT_BUYING_POWER',
    );
  });

  it('position by one smallest step: selling the position fills, one step more does not', async () => {
    const a = await createFundedAccount(db.app);
    filled(await run(db.app, cryptoCommand(a, btc, { qty: '0.001' })));
    await expectRejected(
      a,
      cryptoCommand(a, btc, { side: 'SELL', qty: '0.00100001' }),
      'INSUFFICIENT_POSITION',
    );
    filled(await run(db.app, cryptoCommand(a, btc, { side: 'SELL', qty: '0.001' })));
    // nothing owned any more
    await expectRejected(
      a,
      cryptoCommand(a, btc, { side: 'SELL', qty: '0.00000001' }),
      'INSUFFICIENT_POSITION',
    );
  });

  it('PRICE_MOVED uses the 2% crypto collar: +2.4% is rejected, +1.1% fills (control)', async () => {
    const a = await createFundedAccount(db.app);
    await expectRejected(
      a,
      cryptoCommand(a, btc, {
        qty: '0.001',
        referencePrice: '90010.00',
        bid: '92150.00',
        ask: '92170.00',
      }),
      'PRICE_MOVED',
    );
    filled(
      await run(
        db.app,
        cryptoCommand(a, btc, {
          qty: '0.001',
          referencePrice: '90010.00',
          bid: '90990.00',
          ask: '91010.00',
        }),
      ),
    );
  });

  it('FEE_EXCEEDS_PROCEEDS with a high-fee schedule built in the test (control: the normal schedule sells)', async () => {
    const a = await createFundedAccount(db.app);
    filled(await run(db.app, cryptoCommand(a, btc, { qty: '0.01' })));
    const high = { ...SCHEDULE_CRYPTO, commissionBps: '20000' }; // a 200% fee
    await expectRejected(
      a,
      cryptoCommand(a, btc, { side: 'SELL', qty: '0.005', feeSchedule: high }),
      'FEE_EXCEEDS_PROCEEDS',
    );
    filled(await run(db.app, cryptoCommand(a, btc, { side: 'SELL', qty: '0.005' })));
  });

  it('a crypto BUY that costs 0 at 8 decimals is rejected as too small instead of failing in the database (control: a larger one fills)', async () => {
    const coin = await createFractionalInstrument(db, 'DUST', {
      tick: '0.00001',
      step: '0.00000001',
    });
    const a = await createFundedAccount(db.app);
    const dust = (qty: string) =>
      cryptoCommand(a, coin, {
        qty,
        bid: '0.00001',
        ask: '0.00001',
        feeSchedule: {
          commissionBps: '0',
          commissionMinLocal: '0',
          slippageBaseBps: '0',
          slippageSizeCoef: '0',
          modelVersion: 'QBX-1/r8he',
        },
        instrument: { tickSize: '0.00001' },
      });
    await expectRejected(a, dust('0.00000001'), 'QTY_BELOW_MIN'); // 1e-8 x 0.00001 = 1e-13 -> 0
    filled(await run(db.app, dust('1000')));
  });
});

describe('concurrency on real Postgres (each order in its own transaction and connection)', () => {
  it('(a) 50 parallel fractional BUYs with cash for exactly N: exactly N fill, cash is never negative and ends exact', async () => {
    const capital = '2000';
    const a = await createFundedAccount(big, capital);
    // N computed independently: each 0.0025 BTC buy costs 225.36266252 (vector A) = 22,536,266,252 units of 1e-8
    const unit = 22_536_266_252n;
    const cashUnits = 2000n * 100_000_000n;
    const n = Number(cashUnits / unit); // 8: 8 x 225.36266252 = 1,802.90130016; 9 x = 2,028.26...
    expect(n).toBe(8);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => run(big, cryptoCommand(a, btc, { qty: '0.0025' }))),
    );
    const fills = results.filter((r) => r.outcome === 'FILLED');
    const rejects = results.filter((r) => r.outcome === 'REJECTED');
    expect(fills).toHaveLength(n);
    expect(rejects).toHaveLength(50 - n);
    for (const r of rejects)
      expect(r.outcome === 'REJECTED' && r.rejectCode).toBe('INSUFFICIENT_BUYING_POWER');
    // 2,000 - 8 x 225.36266252 = 197.09869984
    expect((await balances(a)).CASH).toBe('197.09869984');
    expect(await positionOf(a, btc.id)).toMatchObject({ qty: '0.02' });
    expect(await lotsOf(a, btc.id)).toHaveLength(n);
    await clean(a);
  }, 120_000);

  it('(b) a position of 0.0100 BTC and 30 parallel SELLs of 0.0007: exactly 14 fill, quantity never negative, cost exact', async () => {
    const a = await createFundedAccount(big, '10000');
    filled(await run(big, cryptoCommand(a, btc, { qty: '0.01' }))); // fill 90,055.01: cost 900.5501
    expect((await lotsOf(a, btc.id))[0]).toEqual({
      qtyOpen: '0.01',
      costRemaining: '900.5501',
      closed: false,
    });
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        run(big, cryptoCommand(a, btc, { side: 'SELL', qty: '0.0007' })),
      ),
    );
    const fills = results.filter((r) => r.outcome === 'FILLED').length;
    expect(fills).toBe(14); // floor(0.0100 / 0.0007)
    for (const r of results)
      if (r.outcome === 'REJECTED') expect(r.rejectCode).toBe('INSUFFICIENT_POSITION');
    // reference chain (BigInt, units of 1e-8): R = 900.5501 = 90,055,010,000; Q = 1,000,000; piece 70,000
    let q = 1_000_000n;
    let c = 90_055_010_000n;
    for (let i = 0; i < 14; i += 1) {
      const num = c * 70_000n;
      let consumed = num / q;
      const twice = (num % q) * 2n;
      if (twice > q || (twice === q && consumed % 2n === 1n)) consumed += 1n;
      c -= consumed;
      q -= 70_000n;
    }
    const text = (u: bigint): string =>
      `${(u / 100_000_000n).toString()}.${(u % 100_000_000n).toString().padStart(8, '0')}`;
    expect(q).toBe(20_000n); // 0.0002 left
    expect(await lotsOf(a, btc.id)).toEqual([
      { qtyOpen: '0.0002', costRemaining: dec(text(c)), closed: false },
    ]);
    expect(await positionOf(a, btc.id)).toMatchObject({ qty: '0.0002' });
    expect((await balances(a)).POSITION_COST).toBe(dec(text(c)));
    await clean(a);
  }, 120_000);

  it('(c) 60 mixed parallel stock and crypto BUYs and SELLs on one account: reconcile is clean, nothing goes negative', async () => {
    const a = await createFundedAccount(big, '10000');
    filled(await run(big, command(a, stock, { qty: '5' })));
    filled(await run(big, cryptoCommand(a, btc, { qty: '0.01' })));
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const jobs = Array.from({ length: 60 }, () => {
      const kind = rnd(4);
      if (kind === 0) return run(big, command(a, stock, { side: 'BUY', qty: String(1 + rnd(3)) }));
      if (kind === 1) return run(big, command(a, stock, { side: 'SELL', qty: String(1 + rnd(2)) }));
      if (kind === 2)
        return run(big, cryptoCommand(a, btc, { side: 'BUY', qty: `0.00${String(1 + rnd(3))}` }));
      return run(big, cryptoCommand(a, btc, { side: 'SELL', qty: `0.000${String(1 + rnd(5))}` }));
    });
    const results = await Promise.all(jobs);
    expect(results).toHaveLength(60);
    for (const r of results) {
      if (r.outcome === 'REJECTED')
        expect(['INSUFFICIENT_POSITION', 'INSUFFICIENT_BUYING_POWER']).toContain(r.rejectCode);
    }
    const bal = await balances(a);
    expect(parse(bal.CASH ?? '0').sign()).toBeGreaterThanOrEqual(0);
    for (const inst of [stock, btc]) {
      const p = await positionOf(a, inst.id);
      expect(p === null || parse(p.qty).sign() >= 0).toBe(true);
    }
    await clean(a);
  }, 120_000);

  it('(d) two accounts in parallel do not block each other: an order on B completes while A is locked; a second order on A waits (control)', async () => {
    const accA = await createFundedAccount(big);
    const accB = await createFundedAccount(big);
    const holder = await big.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT lock_account_for_order($1::uuid)', [accA]);
      let aDone = false;
      const orderA = run(big, cryptoCommand(accA, btc, { qty: '0.001' })).then((r) => {
        aDone = true;
        return r;
      });
      const orderB = await Promise.race([
        run(big, cryptoCommand(accB, btc, { qty: '0.001' })),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000)),
      ]);
      expect(orderB).not.toBe('timeout');
      expect(aDone).toBe(false); // A is still waiting for its lock (the control)
      await holder.query('COMMIT');
      const ra = await orderA;
      expect(ra.outcome).toBe('FILLED');
    } finally {
      holder.release();
    }
    await clean(accA);
    await clean(accB);
  }, 60_000);
});

describe('replay and atomicity for fractional orders', () => {
  it('100 parallel identical requests (one client order id) make exactly one execution and one ledger transaction', async () => {
    const a = await createFundedAccount(big);
    const clientOrderId = `fr-${newId()}`;
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        run(big, cryptoCommand(a, btc, { qty: '0.0025', clientOrderId, orderId: newId() })),
      ),
    );
    expect(results.every((r) => r.outcome === 'FILLED')).toBe(true);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const st = await accountState(db, a);
    expect(st.counts).toMatchObject({ orders: 1, executions: 1, lots: 1 });
    expect(st.counts.ledgerTransactions).toBe(2); // the grant and the fill
    expect((await balances(a)).CASH).toBe('9774.63733748'); // vector A, once
    await clean(a);
  }, 120_000);

  it('a failure after the ledger post leaves nothing behind (orders, events, executions, lots, positions, ledger)', async () => {
    const a = await createFundedAccount(db.app);
    const before = await accountState(db, a);
    await expect(
      run(db.app, cryptoCommand(a, btc, { qty: '0.0025' }), {
        afterLedgerPost: () => {
          throw new Error('injected failure');
        },
      }),
    ).rejects.toThrow('injected failure');
    expect(await accountState(db, a)).toEqual(before);
    expect((await balances(a)).CASH).toBe('10000');
    await clean(a);
    // control: the same order without the failure fills
    filled(await run(db.app, cryptoCommand(a, btc, { qty: '0.0025' })));
  });

  it('a partial consumption that fails half-way restores every lot (injected failure on the second statement of a sell)', async () => {
    const a = await createFundedAccount(db.app);
    filled(await run(db.app, cryptoCommand(a, btc, { qty: '0.003' })));
    const before = await accountState(db, a);
    const lotsBefore = await lotsOf(a, btc.id);
    await expect(
      run(db.app, cryptoCommand(a, btc, { side: 'SELL', qty: '0.001' }), {
        afterLedgerPost: () => {
          throw new Error('injected failure');
        },
      }),
    ).rejects.toThrow('injected failure');
    expect(await accountState(db, a)).toEqual(before);
    expect(await lotsOf(a, btc.id)).toEqual(lotsBefore);
    await clean(a);
  });
});

describe('database protection for cost_remaining, as vantage_app', () => {
  async function accountWithLot(): Promise<string> {
    const a = await createFundedAccount(db.app);
    filled(await run(db.app, cryptoCommand(a, btc, { qty: '0.0025' }))); // lot 0.0025, cost_remaining 225.137525
    return a;
  }
  async function tryTx(
    body: (c: pg.PoolClient) => Promise<void>,
  ): Promise<{ error?: Error; statementsOk: boolean }> {
    const c = await db.app.connect();
    let statementsOk = false;
    try {
      await c.query('BEGIN');
      await body(c);
      statementsOk = true;
      await c.query('COMMIT');
      return { statementsOk };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      return { error: e as Error, statementsOk };
    } finally {
      c.release();
    }
  }

  it('cost_local_per_unit and qty_initial cannot be changed (permission denied); cost_remaining, qty_open and closed_at can (control)', async () => {
    const a = await accountWithLot();
    for (const col of ['cost_local_per_unit = 1', 'qty_initial = 1', 'cost_usd_per_unit = 1']) {
      await expect(
        db.app.query(`UPDATE position_lots SET ${col} WHERE account_id = $1::uuid`, [a]),
      ).rejects.toMatchObject({ code: '42501' });
    }
    // control: the three allowed columns are updatable, in a state that stays consistent (position 0.0015, cost 135.082515)
    const r = await tryTx(async (c) => {
      const u = await c.query(
        `UPDATE position_lots SET qty_open = 0.0015, cost_remaining = 135.082515 WHERE account_id = $1::uuid`,
        [a],
      );
      expect(u.rowCount).toBe(1);
      await c.query(`UPDATE positions SET qty = 0.0015 WHERE account_id = $1::uuid`, [a]);
    });
    expect(r.error).toBeUndefined();
  });

  it('I4 at commit: cost_remaining of 0 with quantity left, or cost left with no quantity, fails AT COMMIT (the statements succeed)', async () => {
    const a = await accountWithLot();
    const zeroCost = await tryTx(async (c) => {
      await c.query(`UPDATE position_lots SET cost_remaining = 0 WHERE account_id = $1::uuid`, [a]);
    });
    expect(zeroCost.statementsOk).toBe(true);
    expect(zeroCost.error?.message).toMatch(
      /I4: cost_remaining must be non-negative and zero if and only if qty_open = 0/,
    );

    const noQty = await tryTx(async (c) => {
      await c.query(
        `UPDATE position_lots SET qty_open = 0, closed_at = now() WHERE account_id = $1::uuid`,
        [a],
      );
      await c.query(`UPDATE positions SET qty = 0 WHERE account_id = $1::uuid`, [a]);
    });
    expect(noQty.statementsOk).toBe(true); // qty 0 but cost_remaining still 225.137525
    expect(noQty.error?.message).toMatch(
      /I4: cost_remaining must be non-negative and zero if and only if qty_open = 0/,
    );
    expect(await lotsOf(a, btc.id)).toEqual([
      { qtyOpen: '0.0025', costRemaining: '225.137525', closed: false },
    ]); // both rolled back
  });

  it('a negative cost_remaining is refused by the table CHECK', async () => {
    const a = await accountWithLot();
    await expect(
      db.app.query(`UPDATE position_lots SET cost_remaining = -1 WHERE account_id = $1::uuid`, [a]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a transaction that leaves POSITION_COST different from the sum of cost_remaining commits (the database cannot know) and reconcile catches it', async () => {
    const a = await accountWithLot();
    expect(await reconcileAccount(db.migrator, a)).toEqual([]); // control: clean before
    const r = await tryTx(async (c) => {
      // consistent for I4 (qty and cost move together) but the ledger POSITION_COST is untouched
      await c.query(
        `UPDATE position_lots SET qty_open = 0.0015, cost_remaining = 100 WHERE account_id = $1::uuid`,
        [a],
      );
      await c.query(`UPDATE positions SET qty = 0.0015 WHERE account_id = $1::uuid`, [a]);
    });
    expect(r.error).toBeUndefined();
    const v = await reconcileAccount(db.migrator, a);
    expect(v.map((x) => x.invariant)).toEqual(['POSITION_COST']);
    expect(v[0]?.message).toContain('225.137525');
    expect(v[0]?.message).toContain('100');
  });

  it('every earlier protection still holds: lots and closures cannot be deleted, executions are append-only', async () => {
    const a = await accountWithLot();
    await expect(
      db.app.query(`DELETE FROM position_lots WHERE account_id = $1::uuid`, [a]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(db.app.query(`DELETE FROM lot_closures`)).rejects.toMatchObject({ code: '42501' });
    await expect(db.app.query(`UPDATE executions SET qty = 1`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(db.migrator.query(`UPDATE executions SET qty = 1`)).rejects.toThrow(/append-only/);
    await expect(db.migrator.query(`UPDATE lot_closures SET qty = 1`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.migrator.query(`DELETE FROM position_lots`)).rejects.toThrow(/append-only/);
  });
});

// keep the unused-import guard honest: executeMarketOrder is the function under test through run(); it is imported so a
// signature change breaks this file at compile time.
void executeMarketOrder;
void NOW;
