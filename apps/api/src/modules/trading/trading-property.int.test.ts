// Property test on Postgres against an INDEPENDENT reference model written here: plain arrays, FIFO by hand,
// all money in scaled integers (BigInt). It shares no code with the engine or the repository.
//
// Units: 1 cent = 1_000_000 units of 1e-8. A price is an integer number of cents; whole shares.
//   BUY  fill price = ceil(ask x 10002 / 10000) cents        (2 bps slippage, rounded UP to the tick)
//   SELL fill price = floor(bid x 9998 / 10000) cents        (2 bps slippage, rounded DOWN to the tick)
//   notional = qty x price; fee = round-half-even(notional x bps / 10000); lots hold the price (no fee)
import fc from 'fast-check';
import { parse } from '@vantage/money';
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
import { reconcileAccount } from '../ledger/reconcile.js';

let db: TestDatabase;
let instruments: TestInstrument[];
beforeAll(async () => {
  db = await createTestDatabase();
  instruments = [
    await createInstrument(db, 'AAA'),
    await createInstrument(db, 'BBB'),
    await createInstrument(db, 'CCC'),
  ];
});
afterAll(async () => {
  await db.dispose();
});

const CENT = 1_000_000n;
const UNIT = 100_000_000n;
const fmt = (u: bigint): string => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  return `${neg ? '-' : ''}${(a / UNIT).toString()}.${(a % UNIT).toString().padStart(8, '0')}00`;
};
/** round half even of n / d for positive d */
function divRoundEven(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  const twice = r * 2n;
  if (twice > d) return q + 1n;
  if (twice < d) return q;
  return q % 2n === 0n ? q : q + 1n;
}

interface Op {
  side: 'BUY' | 'SELL';
  inst: number;
  qty: number;
  bidC: number;
  spreadC: number;
  refMode: 'exact' | 'adverse';
  bps: 0 | 10;
}

class Model {
  cash = 10_000n * UNIT;
  fees = 0n;
  realised = 0n; // sum of (proceeds - basis)
  lots: Array<Array<{ qty: bigint; costC: bigint }>> = [[], [], []];

  shares(i: number): bigint {
    return (this.lots[i] ?? []).reduce((n, l) => n + l.qty, 0n);
  }
  positionCost(): bigint {
    return this.lots.flat().reduce((n, l) => n + l.qty * l.costC * CENT, 0n);
  }

  /** Applies an order; returns the expected outcome ('FILLED' or the reject code). */
  apply(op: Op): string {
    const bidC = BigInt(op.bidC);
    const askC = bidC + BigInt(op.spreadC);
    const qty = BigInt(op.qty);
    const refC =
      op.side === 'BUY'
        ? op.refMode === 'exact'
          ? askC
          : (askC * 100n) / 103n
        : op.refMode === 'exact'
          ? bidC
          : (bidC * 103n) / 100n + 1n;
    // PRICE_MOVED: BUY when ask x 100 > ref x 101; SELL when bid x 100 < ref x 99
    if (op.side === 'BUY' && askC * 100n > refC * 101n) return 'PRICE_MOVED';
    if (op.side === 'SELL' && bidC * 100n < refC * 99n) return 'PRICE_MOVED';
    const priceC = op.side === 'BUY' ? (askC * 10002n + 9999n) / 10000n : (bidC * 9998n) / 10000n;
    const notional = qty * priceC * CENT;
    const fee = divRoundEven(notional * BigInt(op.bps), 10000n);
    if (op.side === 'BUY') {
      if (this.cash < notional + fee) return 'INSUFFICIENT_BUYING_POWER';
      this.cash -= notional + fee;
      this.fees += fee;
      this.lots[op.inst]?.push({ qty, costC: priceC });
      return 'FILLED';
    }
    if (this.shares(op.inst) < qty) return 'INSUFFICIENT_POSITION';
    let left = qty;
    let basis = 0n;
    for (const lot of this.lots[op.inst] ?? []) {
      if (left === 0n) break;
      const take = lot.qty < left ? lot.qty : left;
      basis += take * lot.costC * CENT;
      lot.qty -= take;
      left -= take;
    }
    this.lots[op.inst] = (this.lots[op.inst] ?? []).filter((l) => l.qty > 0n);
    this.cash += notional - fee;
    this.fees += fee;
    this.realised += notional - basis;
    return 'FILLED';
  }
}

const opArb: fc.Arbitrary<Op> = fc.record({
  side: fc.constantFrom<'BUY' | 'SELL'>('BUY', 'BUY', 'SELL'), // a bit more buying so there is something to sell
  inst: fc.integer({ min: 0, max: 2 }),
  qty: fc.integer({ min: 1, max: 8 }),
  bidC: fc.integer({ min: 100, max: 120_000 }), // $1.00 to $1,200.00
  spreadC: fc.integer({ min: 1, max: 5 }),
  refMode: fc.constantFrom<'exact' | 'adverse'>('exact', 'exact', 'exact', 'adverse'),
  bps: fc.constantFrom<0 | 10>(0, 10),
});

const priceStr = (c: bigint): string =>
  `${(c / 100n).toString()}.${(c % 100n).toString().padStart(2, '0')}`;

async function runOps(acct: string, ops: Op[], model: Model, check: boolean): Promise<void> {
  let n = 0;
  for (const op of ops) {
    n += 1;
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
    const inst = instruments[op.inst] as TestInstrument;
    const expected = model.apply(op);
    const result = await run(
      db.app,
      command(acct, inst, {
        clientOrderId: `op-${String(n)}`,
        side: op.side,
        qty: String(op.qty),
        bid: priceStr(bidC),
        ask: priceStr(askC),
        referencePrice: priceStr(refC),
        now: new Date(NOW.getTime() + n * 1000),
        feeSchedule: {
          commissionBps: String(op.bps),
          commissionMinLocal: '0',
          slippageBaseBps: '2',
          slippageSizeCoef: '0',
          modelVersion: 'QBX-1/r8he',
        },
      }),
    );
    const got = result.outcome === 'FILLED' ? 'FILLED' : result.rejectCode;
    expect(got, `op ${String(n)} ${JSON.stringify(op)}`).toBe(expected);
    if (!check) continue;
    expect(await reconcileAccount(db.app, acct, { trading: true })).toEqual([]);
    const state = await accountState(db, acct);
    expect(state.balances.CASH).toBe(fmt(model.cash));
    expect(state.balances.FEES).toBe(fmt(model.fees));
    expect(state.balances.POSITION_COST).toBe(fmt(model.positionCost()));
    expect(state.balances.REALIZED_PNL).toBe(fmt(-model.realised)); // REALIZED_PNL = -(sum of P - B)
  }
}

async function finalChecks(acct: string, model: Model): Promise<void> {
  // shares per instrument and the open lots equal the model
  for (const [i, inst] of instruments.entries()) {
    const pos = await db.migrator.query<{ qty: string }>(
      `SELECT qty FROM positions WHERE account_id = $1::uuid AND instrument_id = $2::uuid`,
      [acct, inst.id],
    );
    expect(pos.rows[0]?.qty ?? '0.0000000000').toBe(`${model.shares(i).toString()}.0000000000`);
    const lots = await db.migrator.query<{ qty_open: string; cost_local_per_unit: string }>(
      `SELECT qty_open, cost_local_per_unit FROM position_lots WHERE account_id = $1::uuid AND instrument_id = $2::uuid AND qty_open > 0 ORDER BY opened_at, id`,
      [acct, inst.id],
    );
    expect(lots.rows.map((l) => [l.qty_open, l.cost_local_per_unit])).toEqual(
      (model.lots[i] ?? []).map((l) => [
        `${l.qty.toString()}.0000000000`,
        `${priceStr(l.costC)}00000000`,
      ]),
    );
  }
  // D-52 exactness: sum(qty_open x cost) equals POSITION_COST, zero tolerance, in the database itself
  const exact = await db.migrator.query<{ lots: string; ledger: string }>(
    `SELECT COALESCE((SELECT SUM(qty_open * cost_local_per_unit) FROM position_lots WHERE account_id = $1::uuid), 0) AS lots,
            (SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'POSITION_COST') AS ledger`,
    [acct],
  );
  // exact decimal comparison (the product has scale 20, the balance scale 10): no tolerance
  expect(parse(exact.rows[0]?.lots ?? 'x').equals(parse(exact.rows[0]?.ledger ?? 'y'))).toBe(true);
}

describe('6. property test on Postgres: reconcile clean after every step and equal to the reference model', () => {
  it('30 runs of up to 20 random BUY and SELL orders on 3 instruments', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 20 }), async (ops) => {
        const acct = await createFundedAccount(db.app);
        const model = new Model();
        await runOps(acct, ops, model, true);
        await finalChecks(acct, model);
      }),
      { numRuns: 30 },
    );
  }, 600_000);
});

describe('8. exactness (D-52): position cost equals the sum of lot costs exactly after a long random sequence', () => {
  it('400 random orders on one account, then ledger and lots agree to the last digit', async () => {
    const [ops] = fc.sample(fc.array(opArb, { minLength: 400, maxLength: 400 }), {
      numRuns: 1,
      seed: 20261111,
    });
    const acct = await createFundedAccount(db.app, '1000000'); // a large balance so most buys fill
    const model = new Model();
    model.cash = 1_000_000n * UNIT;
    await runOps(acct, ops ?? [], model, false);
    await finalChecks(acct, model);
    expect(await reconcileAccount(db.app, acct, { trading: true })).toEqual([]);
    const state = await accountState(db, acct);
    expect(state.balances.CASH).toBe(fmt(model.cash));
    expect(state.balances.POSITION_COST).toBe(fmt(model.positionCost()));
    expect(model.lots.flat().length).toBeGreaterThan(5); // the sequence really built positions
    expect(state.counts.orders).toBe(400);
  }, 600_000);
});
