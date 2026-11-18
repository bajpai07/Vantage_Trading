// M8 property test on real Postgres (D-85): random fractional and whole BUYs and SELLs on crypto and stocks, with random
// quotes. After EVERY operation reconcileAccount is clean (zero tolerance) and cash, quantities, cost_remaining per lot,
// fees and realised P&L equal an INDEPENDENT BigInt reference model written in this file: FIFO by hand, the D-85 cost rule
// (proportional share rounded HALF_EVEN, the last piece of a lot by subtraction, the documented one-unit clamp), HALF_EVEN
// on every tie. All amounts are integers of 1e-8; the model never uses the money package or the engine.
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import {
  command,
  createFundedAccount,
  createInstrument,
  cryptoCommand,
  run,
  seededCrypto,
} from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';

const U = 100_000_000n; // 1.00000000
const TICK = 1_000_000n; // 0.01

const text = (u: bigint): string => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const whole = (a / U).toString();
  const frac = (a % U).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
};
const norm = (s: string): string => parse(s).toString();

/** n / d rounded half to even, for n >= 0 and d > 0. */
function divEven(n: bigint, d: bigint): bigint {
  const q = n / d;
  const twice = (n % d) * 2n;
  return twice > d || (twice === d && q % 2n === 1n) ? q + 1n : q;
}
const ceilDiv = (n: bigint, d: bigint): bigint => (n + d - 1n) / d;

interface Lot {
  q: bigint;
  c: bigint;
}
interface Side {
  lots: Lot[];
  realised: bigint; // sum of (proceeds - basis), the positions cache
}

class Reference {
  cash: bigint;
  fees = 0n;
  ledgerRealised = 0n; // REALIZED_PNL ledger balance: -(proceeds - basis) summed
  book = new Map<string, Side>();
  constructor(cash: bigint) {
    this.cash = cash;
  }
  side(inst: string): Side {
    let s = this.book.get(inst);
    if (s === undefined) {
      s = { lots: [], realised: 0n };
      this.book.set(inst, s);
    }
    return s;
  }
  positionCost(): bigint {
    let t = 0n;
    for (const s of this.book.values()) for (const l of s.lots) t += l.c;
    return t;
  }
  qty(inst: string): bigint {
    return this.side(inst).lots.reduce((a, l) => a + l.q, 0n);
  }
}

interface Op {
  readonly crypto: boolean;
  readonly sell: boolean;
  /** crypto: quantity in units of 1e-8; stock: whole shares. */
  readonly qty: bigint;
  /** bid in ticks of 0.01 and the spread in ticks */
  readonly bidTicks: bigint;
  readonly spreadTicks: bigint;
}

const opArb: fc.Arbitrary<Op> = fc.record({
  crypto: fc.boolean(),
  sell: fc.boolean(),
  qty: fc.oneof(
    fc.bigInt({ min: 1n, max: 40_000_000n }), // up to 0.4 of a coin
    fc.bigInt({ min: 1n, max: 40n }), // dust sizes
    fc.constantFrom(100_000n, 250_000n, 1_000_000n, 7_000_000n),
  ),
  bidTicks: fc.bigInt({ min: 1_000n, max: 9_000_000n }), // 10.00 .. 90,000.00
  spreadTicks: fc.bigInt({ min: 0n, max: 300n }),
});

let db: TestDatabase;
let btc: TestInstrument;
let stock: TestInstrument;
beforeAll(async () => {
  db = await createTestDatabase();
  btc = await seededCrypto(db, 'BTC-USD');
  stock = await createInstrument(db, 'PSTK');
}, 120_000);
afterAll(async () => {
  await db?.dispose();
});

async function ledger(accountId: string): Promise<Record<string, string>> {
  const r = await db.migrator.query<{ type: string; balance: string }>(
    `SELECT type::text AS type, balance FROM ledger_accounts WHERE account_id = $1::uuid AND currency = 'USD'`,
    [accountId],
  );
  return Object.fromEntries(r.rows.map((x) => [x.type, norm(x.balance)]));
}

async function dbLots(accountId: string, instrumentId: string): Promise<Array<[string, string]>> {
  const r = await db.migrator.query<{ qty_open: string; cost_remaining: string }>(
    `SELECT qty_open, cost_remaining FROM position_lots
      WHERE account_id = $1::uuid AND instrument_id = $2::uuid AND qty_open > 0 ORDER BY opened_at, id`,
    [accountId, instrumentId],
  );
  return r.rows.map((x) => [norm(x.qty_open), norm(x.cost_remaining)]);
}

describe('M8 property: the engine, the executor and the database equal the independent BigInt model', () => {
  it('30 runs of up to 25 random operations: every step is reference-equal and reconciles with zero tolerance', async () => {
    let steps = 0;
    let fills = 0;
    let rejects = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), async (ops) => {
        const capital = 20_000n * U;
        const accountId = await createFundedAccount(db.app, text(capital));
        const model = new Reference(capital);
        let n = 0;
        for (const op of ops) {
          n += 1;
          steps += 1;
          const inst = op.crypto ? btc : stock;
          const key = inst.id;
          const tick = TICK;
          const bps = op.crypto ? 5n : 2n; // slippage
          const comm = op.crypto ? 10n : 0n; // commission
          const bidU = op.bidTicks * tick;
          const askU = (op.bidTicks + op.spreadTicks) * tick;
          const qtyU = op.crypto ? op.qty : (op.qty % 20n === 0n ? 20n : op.qty % 20n) * U; // whole shares 1..20
          const now = new Date(Date.UTC(2026, 10, 10, 15, 0, n));
          const quote = { bid: text(bidU), ask: text(askU) };
          const common = {
            side: op.sell ? ('SELL' as const) : ('BUY' as const),
            qty: text(qtyU),
            now,
            ...quote,
          };
          const cmd = op.crypto
            ? cryptoCommand(accountId, inst, common)
            : command(accountId, inst, {
                ...common,
                freshness: 'REAL_TIME',
                quote: {
                  ...quote,
                  providerTs: new Date(now.getTime() - 1000),
                  source: 'SIM',
                  entitlement: 'REAL_TIME',
                  delaySeconds: 0,
                },
                feeSchedule: {
                  commissionBps: '0',
                  commissionMinLocal: '0',
                  slippageBaseBps: '2',
                  slippageSizeCoef: '0',
                  modelVersion: 'QBX-1/r8he',
                },
              });

          // ---- the reference decision ------------------------------------------------------------------------------
          const priceU = op.sell
            ? ((bidU * (10_000n - bps)) / (10_000n * TICK)) * TICK // rounded DOWN to the tick
            : ceilDiv(askU * (10_000n + bps), 10_000n * TICK) * TICK; // rounded UP to the tick
          const notional = divEven(qtyU * priceU, U);
          const fee = divEven(notional * comm, 10_000n);
          let expectCode: string | null = null;
          if (!op.sell && notional === 0n) expectCode = 'QTY_BELOW_MIN';
          else if (!op.sell && model.cash < notional + fee)
            expectCode = 'INSUFFICIENT_BUYING_POWER';
          else if (op.sell && model.qty(key) < qtyU) expectCode = 'INSUFFICIENT_POSITION';
          else if (op.sell && fee > notional) expectCode = 'FEE_EXCEEDS_PROCEEDS';

          const result = await run(db.app, cmd);
          if (expectCode !== null) {
            rejects += 1;
            expect(result.outcome).toBe('REJECTED');
            if (result.outcome === 'REJECTED') expect(result.rejectCode).toBe(expectCode);
          } else {
            fills += 1;
            expect(result.outcome).toBe('FILLED');
            if (result.outcome !== 'FILLED') throw new Error('unreachable');
            expect(result.execution.price).toBe(text(priceU));
            expect(norm(result.execution.grossUsd)).toBe(text(notional));
            expect(norm(result.execution.feeLocal)).toBe(text(fee));
            // ---- apply to the model ----
            const side = model.side(key);
            if (!op.sell) {
              model.cash -= notional + fee;
              model.fees += fee;
              side.lots.push({ q: qtyU, c: notional }); // the lot cost is the posted notional (D-85)
            } else {
              let remaining = qtyU;
              let basis = 0n;
              for (const lot of side.lots) {
                if (remaining === 0n) break;
                if (lot.q === 0n) continue;
                const take = lot.q < remaining ? lot.q : remaining;
                let cost: bigint;
                if (take === lot.q)
                  cost = lot.c; // the last piece of a lot: by subtraction
                else {
                  cost = divEven(lot.c * take, lot.q);
                  if (cost >= lot.c) cost = lot.c - 1n; // the documented clamp
                  if (cost < 0n) cost = 0n;
                }
                lot.q -= take;
                lot.c -= cost;
                basis += cost;
                remaining -= take;
              }
              side.lots = side.lots.filter((l) => l.q > 0n);
              model.cash += notional - fee;
              model.fees += fee;
              model.ledgerRealised -= notional - basis;
              side.realised += notional - basis;
            }
          }

          // ---- compare the database with the model after EVERY operation --------------------------------------------
          const bal = await ledger(accountId);
          expect(bal.CASH).toBe(text(model.cash));
          expect(bal.FEES).toBe(text(model.fees));
          expect(bal.POSITION_COST).toBe(text(model.positionCost()));
          expect(bal.REALIZED_PNL).toBe(text(model.ledgerRealised));
          for (const [instrument, id] of [
            [btc.id, btc.id],
            [stock.id, stock.id],
          ] as const) {
            const lots = model
              .side(instrument)
              .lots.map((l): [string, string] => [text(l.q), text(l.c)]);
            expect(await dbLots(accountId, id)).toEqual(lots);
          }
          const pos = await db.migrator.query<{
            instrument_id: string;
            qty: string;
            realised: string;
          }>(
            `SELECT instrument_id, qty, realized_trading_pnl_usd AS realised FROM positions WHERE account_id = $1::uuid`,
            [accountId],
          );
          for (const p of pos.rows) {
            const side = model.side(p.instrument_id);
            expect(norm(p.qty)).toBe(text(model.qty(p.instrument_id)));
            expect(norm(p.realised)).toBe(text(side.realised));
          }
          // zero tolerance: ledger, lots, positions, closures, orders and executions all agree
          expect(await reconcileAccount(db.migrator, accountId)).toEqual([]);
        }
      }),
      { numRuns: 30, endOnFailure: true },
    );
    // the run exercised both outcomes
    expect(steps).toBeGreaterThan(100);
    expect(fills).toBeGreaterThan(20);
    expect(rejects).toBeGreaterThan(5);
  }, 600_000);
});
