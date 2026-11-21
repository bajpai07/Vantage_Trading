// M8b-1 T7 + M8b-2 T0 property test on real Postgres: random LIMIT and MARKET orders on a crypto (BTC-USD, fractional) AND a
// stock (whole shares), quote moves (every open order of the instrument is offered the new quote, oldest first), STALE moves
// (a satisfied limit on a stale quote must not fill), cancels and expiries. After EVERY operation the database equals an
// INDEPENDENT BigInt model written in this file (it never uses the money package or the engine):
//   CASH, RESERVED, FEES, POSITION_COST and REALIZED_PNL ledger balances; per instrument the position quantity, qty_reserved,
//   the realised cache (positions.realized_trading_pnl_usd) and cost_remaining of every open lot (FIFO, D-85); the status of
//   every order; and reconcileAccount is clean with zero tolerance (I3-I7, I10).
// The model: R = ceil8(qty x limit) + commission(that) (D-92); the fill price is the slipped quote capped by the limit; a BUY
// fill gives back R - (cost + fee) from RESERVED to CASH; a SELL reserves quantity only (D-96); a lot's consumed cost is
// round8 HALF_EVEN(cost x take / qty) with the last piece by subtraction (D-85).
// Controls: (1) a reserve that forgets the commission, (2) a model that rounds the consumed cost DOWN instead of HALF_EVEN:
// the same comparisons must catch each.
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import {
  SCHEDULE_V1,
  accept,
  cancel,
  createFundedAccount,
  createInstrument,
  cryptoCommand,
  expire,
  fillResting,
  freshQuote,
  limitCommand,
  run,
  seededCrypto,
} from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';

const U = 100_000_000n;
const TICK = 1_000_000n; // 0.01

const text = (u: bigint): string => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const frac = (a % U).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${(a / U).toString()}${frac === '' ? '' : `.${frac}`}`;
};
const norm = (s: string): string => parse(s).toString();
const ceilDiv = (n: bigint, d: bigint): bigint => (n + d - 1n) / d;
function divEven(n: bigint, d: bigint): bigint {
  const q = n / d;
  const twice = (n % d) * 2n;
  return twice > d || (twice === d && q % 2n === 1n) ? q + 1n : q;
}

/** Per-instrument parameters of the model (the crypto and the stock schedules of the seeded database). */
interface Param {
  readonly key: 'BTC' | 'STK';
  readonly slipBps: bigint;
  readonly feeBps: bigint;
}
const PARAMS: Record<'BTC' | 'STK', Param> = {
  BTC: { key: 'BTC', slipBps: 5n, feeBps: 10n },
  STK: { key: 'STK', slipBps: 2n, feeBps: 0n },
};

interface MOrder {
  id: string;
  p: Param;
  buy: boolean;
  qty: bigint;
  limit: bigint;
  reserve: bigint; // BUY only
  expiresAt: number; // ms
  status: 'ACCEPTED' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
}
interface MLot {
  q: bigint;
  c: bigint;
}

interface Mutations {
  /** the reserve forgets the commission */
  readonly forgetCommission?: boolean;
  /** the consumed cost of a partial lot is rounded DOWN instead of HALF_EVEN */
  readonly floorCost?: boolean;
}

class Model {
  cash: bigint; // the CASH ledger balance (reservations already removed)
  reserved = 0n;
  fees = 0n;
  ledgerRealised = 0n; // the REALIZED_PNL ledger balance: -(proceeds - basis) summed
  lots: Record<'BTC' | 'STK', MLot[]> = { BTC: [], STK: [] };
  realised: Record<'BTC' | 'STK', bigint> = { BTC: 0n, STK: 0n }; // the positions cache: +(proceeds - basis)
  orders: MOrder[] = [];
  partialCloses = 0;
  constructor(
    cash: bigint,
    private readonly mut: Mutations = {},
  ) {
    this.cash = cash;
  }
  commission(p: Param, notional: bigint): bigint {
    return divEven(notional * p.feeBps, 10_000n);
  }
  reserveFor(p: Param, qty: bigint, limit: bigint): bigint {
    const c = ceilDiv(qty * limit, U);
    return this.mut.forgetCommission === true ? c : c + this.commission(p, c);
  }
  open(): MOrder[] {
    return this.orders.filter((o) => o.status === 'ACCEPTED');
  }
  qty(k: 'BTC' | 'STK'): bigint {
    return this.lots[k].reduce((a, l) => a + l.q, 0n);
  }
  reservedQty(k: 'BTC' | 'STK'): bigint {
    return this.open()
      .filter((o) => !o.buy && o.p.key === k)
      .reduce((a, o) => a + o.qty, 0n);
  }
  freeQty(k: 'BTC' | 'STK'): bigint {
    return this.qty(k) - this.reservedQty(k);
  }
  positionCost(): bigint {
    let t = 0n;
    for (const k of ['BTC', 'STK'] as const) for (const l of this.lots[k]) t += l.c;
    return t;
  }
  fillPrice(p: Param, buy: boolean, bid: bigint, ask: bigint, limit: bigint | null): bigint {
    const slipped = buy
      ? ceilDiv(ask * (10_000n + p.slipBps), 10_000n * TICK) * TICK
      : ((bid * (10_000n - p.slipBps)) / (10_000n * TICK)) * TICK;
    if (limit === null) return slipped;
    return buy ? (slipped < limit ? slipped : limit) : slipped > limit ? slipped : limit;
  }
  marketable(o: MOrder, bid: bigint, ask: bigint): boolean {
    return o.buy ? ask <= o.limit : bid >= o.limit;
  }
  /** a BUY opens a lot (cost = the posted notional); a SELL consumes the lots FIFO and realises proceeds - basis */
  private settle(p: Param, buy: boolean, qty: bigint, notional: bigint): void {
    const lots = this.lots[p.key];
    if (buy) {
      lots.push({ q: qty, c: notional });
      return;
    }
    let remaining = qty;
    let basis = 0n;
    for (const lot of lots) {
      if (remaining === 0n) break;
      if (lot.q === 0n) continue;
      const take = lot.q < remaining ? lot.q : remaining;
      let cost: bigint;
      if (take === lot.q)
        cost = lot.c; // the last piece of a lot: by subtraction
      else {
        this.partialCloses += 1;
        cost = this.mut.floorCost === true ? (lot.c * take) / lot.q : divEven(lot.c * take, lot.q);
        if (cost >= lot.c) cost = lot.c - 1n; // the documented clamp
        if (cost < 0n) cost = 0n;
      }
      lot.q -= take;
      lot.c -= cost;
      basis += cost;
      remaining -= take;
    }
    this.lots[p.key] = lots.filter((l) => l.q > 0n);
    this.ledgerRealised -= notional - basis;
    this.realised[p.key] += notional - basis;
  }
  /** a MARKET order's effects (the decision was made by the caller) */
  market(p: Param, buy: boolean, qty: bigint, notional: bigint, fee: bigint): void {
    if (buy) this.cash -= notional + fee;
    else this.cash += notional - fee;
    this.fees += fee;
    this.settle(p, buy, qty, notional);
  }
  /** fill an ACCEPTED (already reserved) order at the quote */
  fill(o: MOrder, bid: bigint, ask: bigint): void {
    const price = this.fillPrice(o.p, o.buy, bid, ask, o.limit);
    const notional = divEven(o.qty * price, U);
    const fee = this.commission(o.p, notional);
    if (o.buy) {
      this.reserved -= o.reserve;
      this.cash += o.reserve - (notional + fee);
    } else this.cash += notional - fee;
    this.fees += fee;
    this.settle(o.p, o.buy, o.qty, notional);
    o.status = 'FILLED';
  }
  release(o: MOrder, to: 'CANCELLED' | 'EXPIRED'): void {
    if (o.buy) {
      this.reserved -= o.reserve;
      this.cash += o.reserve;
    }
    o.status = to;
  }
}

type Kind = 'LB' | 'LS' | 'MB' | 'MS' | 'CANCEL' | 'EXPIRE' | 'MOVE' | 'STALE';
interface Op {
  readonly kind: Kind;
  readonly stock: boolean;
  readonly qty: bigint; // crypto: units of 1e-8; stock: a count that maps to 1..20 whole shares
  readonly bidTicks: bigint;
  readonly spreadTicks: bigint;
  readonly limitOffset: bigint; // ticks away from the bid (can be negative)
  readonly short: boolean; // expires within the run's clock
  readonly pick: number;
}
const opArb: fc.Arbitrary<Op> = fc
  .record({
    kind: fc.constantFrom<Kind>(
      'LB',
      'LB',
      'LB',
      'LS',
      'LS',
      'MB',
      'MB',
      'MB',
      'MS',
      'MS',
      'CANCEL',
      'EXPIRE',
      'MOVE',
      'MOVE',
      'MOVE',
      'STALE',
      'STALE',
    ),
    stock: fc.boolean(),
    qty: fc.oneof(
      fc.bigInt({ min: 1n, max: 30_000_000n }),
      fc.bigInt({ min: 1n, max: 40n }),
      fc.constantFrom(100_000n, 250_000n, 1_000_000n),
    ),
    bidTicks: fc.bigInt({ min: 8_995_000n, max: 9_005_000n }), // 89,950.00 .. 90,050.00: quotes cross the limits often
    spreadTicks: fc.bigInt({ min: 0n, max: 300n }),
    limitOffset: fc.bigInt({ min: -3_000n, max: 3_000n }),
    short: fc.boolean(),
    pick: fc.nat(1000),
  })
  .map((o) =>
    // a stock lives around 189.00 .. 191.00 (the bid is rebased; the offsets are in ticks for both)
    o.stock
      ? { ...o, bidTicks: 18_900n + (o.bidTicks % 201n), limitOffset: o.limitOffset % 200n }
      : o,
  );

let db: TestDatabase;
let btc: TestInstrument;
let stk: TestInstrument;
beforeAll(async () => {
  db = await createTestDatabase();
  btc = await seededCrypto(db, 'BTC-USD');
  stk = await createInstrument(db, 'LPSTK');
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

const zeroSeen = () => ({
  steps: 0,
  stockSteps: 0,
  rests: 0,
  acceptFills: 0,
  rejects: 0,
  moveFills: 0,
  cancels: 0,
  expiries: 0,
  staleHeld: 0, // a satisfied limit on a STALE quote that did NOT fill
  staleThenFill: 0, // a fill on a fresh move for an order that had been held by a stale quote
  stockFills: 0,
  cryptoFills: 0,
  partialCloses: 0,
});
let seen = zeroSeen();
const T0 = Date.UTC(2026, 10, 10, 15, 0, 0);

/** Runs the ops against the database and the model; returns the first difference as a message, or null. */
async function play(ops: readonly Op[], mut: Mutations = {}): Promise<string | null> {
  const capital = 20_000n * U;
  const accountId = await createFundedAccount(db.app, text(capital));
  const model = new Model(capital, mut);
  const heldByStale = new Set<string>();
  let n = 0;
  try {
    for (const op of ops) {
      n += 1;
      seen.steps += 1;
      if (op.stock) seen.stockSteps += 1;
      const p = op.stock ? PARAMS.STK : PARAMS.BTC;
      const inst = op.stock ? stk : btc;
      const now = new Date(T0 + n * 60_000); // one minute per operation
      const bidU = op.bidTicks * TICK;
      const askU = (op.bidTicks + op.spreadTicks) * TICK;
      const q = { bid: text(bidU), ask: text(askU) };
      const side = op.kind === 'LB' || op.kind === 'MB' ? ('BUY' as const) : ('SELL' as const);
      const qtyU = op.stock ? (op.qty % 20n === 0n ? 20n : op.qty % 20n) * U : op.qty;
      const stockBits = op.stock
        ? {
            feeSchedule: SCHEDULE_V1,
            instrument: { minQty: '1', qtyStep: '1', assetClass: 'EQUITY' as const },
          }
        : {};

      if (op.kind === 'LB' || op.kind === 'LS') {
        const buy = op.kind === 'LB';
        const limitTicks = op.bidTicks + op.limitOffset;
        if (limitTicks < 1n) continue;
        const limit = limitTicks * TICK;
        const expiresAt = now.getTime() + (op.short ? 3 * 60_000 : 86_400_000);
        const cmd = limitCommand(accountId, inst, {
          side,
          qty: text(qtyU),
          limitPrice: text(limit),
          tif: 'GTC',
          expiresAt: new Date(expiresAt),
          now,
          ...q,
          ...stockBits,
        });
        const reserve = buy ? model.reserveFor(p, qtyU, limit) : 0n;
        let expectCode: string | null = null;
        if (buy && ceilDiv(qtyU * limit, U) === 0n) expectCode = 'QTY_BELOW_MIN';
        else if (buy && model.cash < reserve) expectCode = 'INSUFFICIENT_BUYING_POWER';
        else if (!buy && model.freeQty(p.key) < qtyU) expectCode = 'INSUFFICIENT_POSITION';
        const r = await accept(db.app, cmd);
        const mo: MOrder = {
          id: cmd.orderId,
          p,
          buy,
          qty: qtyU,
          limit,
          reserve,
          expiresAt,
          status: 'ACCEPTED',
        };
        if (expectCode !== null) {
          if (r.outcome !== 'REJECTED' || r.rejectCode !== expectCode)
            return `step ${n} ${op.kind}: expected reject ${expectCode}, got ${JSON.stringify(r.outcome)}`;
          seen.rejects += 1;
          continue;
        }
        if (r.outcome === 'REJECTED')
          return `step ${n} ${op.kind}: unexpected reject ${r.rejectCode}`;
        model.orders.push(mo);
        if (buy) {
          model.cash -= reserve;
          model.reserved += reserve;
        }
        if (model.marketable(mo, bidU, askU)) {
          if (r.outcome !== 'FILLED') return `step ${n} ${op.kind}: expected a fill at accept`;
          seen.acceptFills += 1;
          if (op.stock) seen.stockFills += 1;
          else seen.cryptoFills += 1;
          model.fill(mo, bidU, askU);
        } else if (r.outcome !== 'ACCEPTED') return `step ${n} ${op.kind}: expected to rest`;
        else seen.rests += 1;
      } else if (op.kind === 'MB' || op.kind === 'MS') {
        const buy = op.kind === 'MB';
        const price = model.fillPrice(p, buy, bidU, askU, null);
        const notional = divEven(qtyU * price, U);
        const fee = model.commission(p, notional);
        let expectCode: string | null = null;
        if (buy && notional === 0n) expectCode = 'QTY_BELOW_MIN';
        else if (buy && model.cash < notional + fee) expectCode = 'INSUFFICIENT_BUYING_POWER';
        else if (!buy && model.freeQty(p.key) < qtyU) expectCode = 'INSUFFICIENT_POSITION';
        else if (!buy && fee > notional) expectCode = 'FEE_EXCEEDS_PROCEEDS';
        const cmd = cryptoCommand(accountId, inst, {
          side,
          qty: text(qtyU),
          now,
          ...q,
          ...stockBits,
        });
        const r = await run(db.app, cmd);
        if (expectCode !== null) {
          if (r.outcome !== 'REJECTED' || r.rejectCode !== expectCode)
            return `step ${n} ${op.kind}: expected reject ${expectCode}, got ${r.outcome}`;
        } else {
          if (r.outcome !== 'FILLED') return `step ${n} ${op.kind}: expected a fill`;
          if (op.stock) seen.stockFills += 1;
          else seen.cryptoFills += 1;
          model.market(p, buy, qtyU, notional, fee);
        }
      } else if (op.kind === 'CANCEL') {
        const open = model.open();
        const target = open.length === 0 ? undefined : open[op.pick % open.length];
        if (target !== undefined) {
          const r = await cancel(db.app, target.id, accountId, now);
          if (target.expiresAt <= now.getTime()) {
            // D-94: a cancel that finds the order past its expiry commits the expiry (lazy) and answers NOT_OPEN
            if (r.outcome !== 'NOT_OPEN')
              return `step ${n} CANCEL: expected NOT_OPEN, got ${r.outcome}`;
            model.release(target, 'EXPIRED');
            seen.expiries += 1;
          } else {
            if (r.outcome !== 'CANCELLED') return `step ${n} CANCEL: ${r.outcome}`;
            model.release(target, 'CANCELLED');
            seen.cancels += 1;
          }
        }
      } else if (op.kind === 'EXPIRE') {
        const open = model.open();
        const target = open.length === 0 ? undefined : open[op.pick % open.length];
        if (target !== undefined) {
          const r = await expire(db.app, target.id, now);
          if (target.expiresAt <= now.getTime()) {
            if (r.outcome !== 'EXPIRED')
              return `step ${n} EXPIRE: expected EXPIRED, got ${r.outcome}`;
            model.release(target, 'EXPIRED');
            seen.expiries += 1;
          } else if (r.outcome !== 'SKIPPED') return `step ${n} EXPIRE: expected SKIPPED`;
        }
      } else {
        // MOVE (fresh) or STALE: offer the quote to every open order OF THIS INSTRUMENT, oldest first. Each call gets its own
        // millisecond so that lots opened in one move keep a strict FIFO order.
        const stale = op.kind === 'STALE';
        let i = 0;
        for (const o of model.open().filter((x) => x.p.key === p.key)) {
          const at = new Date(now.getTime() + i);
          i += 1;
          const r = await fillResting(db.app, o.id, inst, freshQuote(q.bid, q.ask, at), {
            now: at,
            ...(stale ? { freshness: 'STALE' as const } : {}),
            ...(op.stock ? { feeSchedule: SCHEDULE_V1 } : {}),
          });
          if (o.expiresAt <= at.getTime()) {
            if (r.outcome !== 'EXPIRED')
              return `step ${n} ${op.kind}: expected EXPIRED, got ${r.outcome}`;
            model.release(o, 'EXPIRED');
          } else if (stale) {
            // a STALE quote never fills, even when it satisfies the limit
            if (r.outcome !== 'NOT_MARKETABLE')
              return `step ${n} STALE: expected NOT_MARKETABLE, got ${r.outcome}`;
            if (model.marketable(o, bidU, askU)) {
              seen.staleHeld += 1;
              heldByStale.add(o.id);
            }
          } else if (model.marketable(o, bidU, askU)) {
            if (r.outcome !== 'FILLED') return `step ${n} MOVE: expected FILLED, got ${r.outcome}`;
            model.fill(o, bidU, askU); // at THIS fresh quote
            seen.moveFills += 1;
            if (heldByStale.has(o.id)) seen.staleThenFill += 1;
            if (op.stock) seen.stockFills += 1;
            else seen.cryptoFills += 1;
          } else if (r.outcome !== 'NOT_MARKETABLE')
            return `step ${n} MOVE: expected NOT_MARKETABLE`;
        }
      }

      // ---- compare the database with the model after EVERY operation ----
      const bal = await ledger(accountId);
      const mism: string[] = [];
      const cmp = (name: string, got: string | undefined, want: bigint): void => {
        if ((got ?? '0') !== text(want)) mism.push(`${name} ${got} vs ${text(want)}`);
      };
      cmp('CASH', bal.CASH, model.cash);
      cmp('RESERVED', bal.RESERVED, model.reserved);
      cmp('FEES', bal.FEES, model.fees);
      cmp('POSITION_COST', bal.POSITION_COST, model.positionCost());
      cmp('REALIZED_PNL', bal.REALIZED_PNL, model.ledgerRealised);
      for (const [k, instr] of [
        ['BTC', btc],
        ['STK', stk],
      ] as const) {
        const pos = await db.migrator.query<{
          qty: string;
          qty_reserved: string;
          realised: string;
        }>(
          `SELECT qty, qty_reserved, realized_trading_pnl_usd AS realised FROM positions
            WHERE account_id = $1::uuid AND instrument_id = $2::uuid`,
          [accountId, instr.id],
        );
        const row = pos.rows[0];
        cmp(`${k} qty`, row === undefined ? '0' : norm(row.qty), model.qty(k));
        cmp(
          `${k} qty_reserved`,
          row === undefined ? '0' : norm(row.qty_reserved),
          model.reservedQty(k),
        );
        cmp(`${k} realised cache`, row === undefined ? '0' : norm(row.realised), model.realised[k]);
        const want = model.lots[k].map((l): [string, string] => [text(l.q), text(l.c)]);
        const got = await dbLots(accountId, instr.id);
        if (JSON.stringify(got) !== JSON.stringify(want))
          mism.push(
            `${k} lots (qty_open, cost_remaining) ${JSON.stringify(got)} vs ${JSON.stringify(want)}`,
          );
      }
      const st = await db.migrator.query<{ id: string; status: string }>(
        `SELECT id, status::text AS status FROM orders WHERE account_id = $1::uuid`,
        [accountId],
      );
      const dbStatus = new Map(st.rows.map((x) => [x.id, x.status]));
      for (const o of model.orders)
        if (dbStatus.get(o.id) !== o.status)
          mism.push(`order status ${dbStatus.get(o.id)} vs ${o.status}`);
      if (mism.length > 0) return `step ${n} ${op.kind}: ${mism.join('; ')}`;
      const violations = await reconcileAccount(db.migrator, accountId);
      if (violations.length > 0)
        return `step ${n} ${op.kind}: reconcile ${JSON.stringify(violations)}`;
    }
    return null;
  } finally {
    seen.partialCloses += model.partialCloses;
  }
}

const base = { stock: false, spreadTicks: 10n, short: false, pick: 0, limitOffset: 0n };

describe('M8b-1/M8b-2 property: limit and market orders on a crypto and a stock, moves, stale moves, cancels and expiries equal the independent BigInt model (cash, reserved, fees, lots, realised P&L)', () => {
  it('30 runs of up to 30 random operations: every step is model-equal and reconciles with zero tolerance', async () => {
    seen = zeroSeen();
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 12, maxLength: 30 }), async (ops) => {
        runs += 1;
        expect(await play(ops)).toBeNull();
      }),
      { numRuns: 30, endOnFailure: true, seed: Number(process.env.M8B2_SEED ?? '20261121') },
    );
    expect(runs).toBe(30);
    process.stdout.write(`M8B2_PROPERTY ${JSON.stringify(seen)}
`);
    expect(seen.rests).toBeGreaterThan(10);
    expect(seen.acceptFills + seen.moveFills).toBeGreaterThan(10);
    expect(seen.rejects).toBeGreaterThan(0);
    expect(seen.stockSteps).toBeGreaterThan(50); // both instruments are exercised (a coin flip per step)
    // the new comparisons are really exercised (the seed is fixed, so these counts are reproducible)
    expect(seen.stockFills).toBeGreaterThan(0);
    expect(seen.cryptoFills).toBeGreaterThan(0);
    expect(seen.moveFills).toBeGreaterThan(0);
    expect(seen.staleHeld).toBeGreaterThan(0);
    expect(seen.partialCloses).toBeGreaterThan(0);
  }, 900_000);

  it('a scripted run covers every path on the crypto: rest, cancel, expire (lazy and by job), fill on a move, fill at accept, rejects, a stale quote that holds a satisfied limit and a later fresh quote that fills it', async () => {
    seen = zeroSeen();
    const at = (bidTicks: bigint) => ({ ...base, bidTicks });
    const ops: Op[] = [
      { kind: 'LB', qty: 1_000_000n, ...at(9_000_000n), limitOffset: -100n }, // rests below the market
      { kind: 'LS', qty: 1_000_000n, ...at(9_000_000n), limitOffset: 100n }, // INSUFFICIENT_POSITION (nothing owned)
      { kind: 'CANCEL', qty: 1n, ...at(9_000_000n) }, // cancels the resting BUY
      { kind: 'MB', qty: 2_000_000n, ...at(9_000_000n) }, // own some BTC (one lot)
      { kind: 'LS', qty: 1_000_000n, ...at(9_000_000n), limitOffset: 100n }, // SELL rests (reserves quantity)
      { kind: 'LB', qty: 1_000_000n, ...at(9_000_000n), limitOffset: -100n, short: true }, // short-lived
      { kind: 'EXPIRE', qty: 1n, ...at(9_000_000n) }, // 3 minutes have not passed: SKIPPED
      { kind: 'STALE', qty: 1n, ...at(9_020_000n) }, // the market rises, but the quote is STALE: the SELL is held
      { kind: 'MOVE', qty: 1n, ...at(9_020_000n) }, // a fresh quote at the same level: the SELL fills there, the BUY expires
      { kind: 'LB', qty: 1_000_000n, ...at(9_000_000n), limitOffset: 500n }, // marketable at accept: fills at once
      { kind: 'LB', qty: 29_000_000n, ...at(9_000_000n) }, // INSUFFICIENT_BUYING_POWER
    ];
    expect(await play(ops)).toBeNull();
    expect(seen.staleHeld).toBeGreaterThan(0);
    expect(seen.staleThenFill).toBeGreaterThan(0);
    expect(seen.partialCloses).toBeGreaterThan(0);
  }, 120_000);

  it('a scripted run on a stock: whole shares, zero commission, FIFO lots across two buys and a partial sell, a resting SELL, a stale hold then a fresh fill', async () => {
    seen = zeroSeen();
    const st = (bidTicks: bigint) => ({ ...base, stock: true, bidTicks });
    const ops: Op[] = [
      { kind: 'MB', qty: 10n, ...st(19_000n) }, // lot 1: 10 shares
      { kind: 'LB', qty: 5n, ...st(19_000n), limitOffset: 20n }, // marketable at accept: lot 2: 5 shares at the limit-capped price
      { kind: 'MS', qty: 12n, ...st(19_100n) }, // sells lot 1 fully and 2 shares of lot 2 (a partial close)
      { kind: 'LS', qty: 3n, ...st(19_100n), limitOffset: 50n }, // rests: sells at 191.50 or better
      { kind: 'LB', qty: 4n, ...st(19_000n), limitOffset: -50n }, // rests at 189.50
      { kind: 'STALE', qty: 1n, ...st(19_200n) }, // bid 192.00 satisfies the SELL, but the quote is stale: held
      { kind: 'MOVE', qty: 1n, ...st(19_200n) }, // fresh: the SELL fills at the slipped bid
      { kind: 'MOVE', qty: 1n, ...st(18_900n) }, // bid 189.00 / ask 189.10: the resting BUY (limit 189.50) fills
    ];
    expect(await play(ops)).toBeNull();
    expect(seen.stockFills).toBeGreaterThanOrEqual(4);
    expect(seen.staleThenFill).toBeGreaterThan(0);
    expect(seen.partialCloses).toBeGreaterThan(0);
  }, 120_000);

  it('control 1: a model whose reserve forgets the commission is caught by the same comparison', async () => {
    const ops: Op[] = [
      { kind: 'LB', qty: 1_000_000n, ...base, bidTicks: 9_000_000n, limitOffset: -100n },
    ];
    const diff = await play(ops, { forgetCommission: true });
    expect(diff).not.toBeNull();
    expect(diff).toMatch(/RESERVED|CASH/);
    expect(await play(ops)).toBeNull(); // the unmutated model agrees on the very same input
  }, 60_000);

  it('control 2: a model that rounds the consumed lot cost DOWN instead of HALF_EVEN is caught by the cost_remaining and realised comparisons', async () => {
    // BUY 3e-8 BTC at the slipped ask 90,055.67 (ask 90,010.66 x 1.0005 rounded up to the tick): notional
    // 3 x 90,055.67 = 270,167.01 -> 270,167 units. SELL 1e-8: the lot's cost share is 270,167 / 3 = 90,055.667: HALF_EVEN
    // takes 90,056, a floor takes 90,055.
    const ops: Op[] = [
      { kind: 'MB', qty: 3n, ...base, bidTicks: 9_000_000n, spreadTicks: 1066n },
      { kind: 'MS', qty: 1n, ...base, bidTicks: 9_000_000n, spreadTicks: 1066n },
    ];
    expect(await play(ops)).toBeNull(); // the real rounding agrees with the HALF_EVEN model
    const diff = await play(ops, { floorCost: true });
    expect(diff).not.toBeNull();
    expect(diff).toMatch(/lots|realised|REALIZED_PNL|POSITION_COST/);
  }, 60_000);
});
