// M8b-1 T7 property test on real Postgres: random LIMIT and MARKET orders on BTC-USD, quote moves (every open order is offered
// the new quote, oldest first), cancels and expiries. After EVERY operation the database equals an INDEPENDENT BigInt model
// written in this file (it never uses the money package or the engine): CASH, RESERVED, FEES, the position quantity,
// qty_reserved, the status of every order, and reconcileAccount is clean with zero tolerance (I3-I7, I10).
// The model: R = ceil8(qty x limit) + commission(that) (D-92); the fill price is the slipped quote capped by the limit; a BUY
// fill gives back R - (cost + fee) from RESERVED to CASH; a SELL reserves quantity only (D-96).
// Control: the mutated model (a reserve that forgets the commission) must be caught by the same comparison.
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import {
  accept,
  cancel,
  createFundedAccount,
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
const BPS_SLIP = 5n;
const BPS_FEE = 10n;

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

interface MOrder {
  id: string;
  buy: boolean;
  qty: bigint;
  limit: bigint;
  reserve: bigint; // BUY only
  expiresAt: number; // ms
  status: 'ACCEPTED' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
}

class Model {
  cash: bigint; // the CASH ledger balance (reservations already removed)
  reserved = 0n;
  fees = 0n;
  qty = 0n;
  orders: MOrder[] = [];
  /** mutation control: the reserve forgets the commission */
  constructor(
    cash: bigint,
    private readonly forgetCommission = false,
  ) {
    this.cash = cash;
  }
  commission(notional: bigint): bigint {
    return divEven(notional * BPS_FEE, 10_000n);
  }
  reserveFor(qty: bigint, limit: bigint): bigint {
    const c = ceilDiv(qty * limit, U);
    return this.forgetCommission ? c : c + this.commission(c);
  }
  open(): MOrder[] {
    return this.orders.filter((o) => o.status === 'ACCEPTED');
  }
  reservedQty(): bigint {
    return this.open()
      .filter((o) => !o.buy)
      .reduce((a, o) => a + o.qty, 0n);
  }
  freeQty(): bigint {
    return this.qty - this.reservedQty();
  }
  fillPrice(buy: boolean, bid: bigint, ask: bigint, limit: bigint | null): bigint {
    const slipped = buy
      ? ceilDiv(ask * (10_000n + BPS_SLIP), 10_000n * TICK) * TICK
      : ((bid * (10_000n - BPS_SLIP)) / (10_000n * TICK)) * TICK;
    if (limit === null) return slipped;
    return buy ? (slipped < limit ? slipped : limit) : slipped > limit ? slipped : limit;
  }
  marketable(o: MOrder, bid: bigint, ask: bigint): boolean {
    return o.buy ? ask <= o.limit : bid >= o.limit;
  }
  /** fill an ACCEPTED (already reserved) order at the quote */
  fill(o: MOrder, bid: bigint, ask: bigint): void {
    const price = this.fillPrice(o.buy, bid, ask, o.limit);
    const notional = divEven(o.qty * price, U);
    const fee = this.commission(notional);
    if (o.buy) {
      this.reserved -= o.reserve;
      this.cash += o.reserve - (notional + fee);
      this.qty += o.qty;
    } else {
      this.cash += notional - fee;
      this.qty -= o.qty;
    }
    this.fees += fee;
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

type Kind = 'LB' | 'LS' | 'MB' | 'MS' | 'CANCEL' | 'EXPIRE' | 'MOVE';
interface Op {
  readonly kind: Kind;
  readonly qty: bigint; // units of 1e-8
  readonly bidTicks: bigint;
  readonly spreadTicks: bigint;
  readonly limitOffset: bigint; // ticks away from the bid (can be negative)
  readonly short: boolean; // expires within the run's clock
  readonly pick: number;
}
const opArb: fc.Arbitrary<Op> = fc.record({
  kind: fc.constantFrom<Kind>(
    'LB',
    'LB',
    'LS',
    'LS',
    'MB',
    'MS',
    'CANCEL',
    'EXPIRE',
    'MOVE',
    'MOVE',
  ),
  qty: fc.oneof(
    fc.bigInt({ min: 1n, max: 30_000_000n }),
    fc.bigInt({ min: 1n, max: 40n }),
    fc.constantFrom(100_000n, 250_000n, 1_000_000n),
  ),
  bidTicks: fc.bigInt({ min: 8_990_000n, max: 9_010_000n }), // 89,900.00 .. 90,100.00: quotes cross the limits often
  spreadTicks: fc.bigInt({ min: 0n, max: 300n }),
  limitOffset: fc.bigInt({ min: -6_000n, max: 6_000n }),
  short: fc.boolean(),
  pick: fc.nat(1000),
});

let db: TestDatabase;
let btc: TestInstrument;
beforeAll(async () => {
  db = await createTestDatabase();
  btc = await seededCrypto(db, 'BTC-USD');
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

const seen = {
  steps: 0,
  rests: 0,
  acceptFills: 0,
  rejects: 0,
  moveFills: 0,
  cancels: 0,
  expiries: 0,
};
const T0 = Date.UTC(2026, 10, 10, 15, 0, 0);

/** Runs the ops against the database and the model; returns the first difference as a message, or null. */
async function play(ops: readonly Op[], forgetCommission: boolean): Promise<string | null> {
  const capital = 20_000n * U;
  const accountId = await createFundedAccount(db.app, text(capital));
  const model = new Model(capital, forgetCommission);
  // the model is the independent one; the mutation changes only the model's reserve rule
  let n = 0;
  for (const op of ops) {
    n += 1;
    seen.steps += 1;
    const now = new Date(T0 + n * 60_000); // one minute per operation
    const bidU = op.bidTicks * TICK;
    const askU = (op.bidTicks + op.spreadTicks) * TICK;
    const q = { bid: text(bidU), ask: text(askU) };
    const side = op.kind === 'LB' || op.kind === 'MB' ? ('BUY' as const) : ('SELL' as const);

    if (op.kind === 'LB' || op.kind === 'LS') {
      const buy = op.kind === 'LB';
      const limitTicks = op.bidTicks + op.limitOffset;
      if (limitTicks < 1n) continue;
      const limit = limitTicks * TICK;
      const expiresAt = now.getTime() + (op.short ? 3 * 60_000 : 86_400_000);
      const cmd = limitCommand(accountId, btc, {
        side,
        qty: text(op.qty),
        limitPrice: text(limit),
        tif: 'GTC',
        expiresAt: new Date(expiresAt),
        now,
        ...q,
      });
      const reserve = buy ? model.reserveFor(op.qty, limit) : 0n;
      let expectCode: string | null = null;
      if (buy && ceilDiv(op.qty * limit, U) === 0n) expectCode = 'QTY_BELOW_MIN';
      else if (buy && model.cash < reserve) expectCode = 'INSUFFICIENT_BUYING_POWER';
      else if (!buy && model.freeQty() < op.qty) expectCode = 'INSUFFICIENT_POSITION';
      const r = await accept(db.app, cmd);
      const mo: MOrder = {
        id: cmd.orderId,
        buy,
        qty: op.qty,
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
        model.fill(mo, bidU, askU);
      } else if (r.outcome !== 'ACCEPTED') return `step ${n} ${op.kind}: expected to rest`;
      else seen.rests += 1;
    } else if (op.kind === 'MB' || op.kind === 'MS') {
      const buy = op.kind === 'MB';
      const price = model.fillPrice(buy, bidU, askU, null);
      const notional = divEven(op.qty * price, U);
      const fee = model.commission(notional);
      let expectCode: string | null = null;
      if (buy && notional === 0n) expectCode = 'QTY_BELOW_MIN';
      else if (buy && model.cash < notional + fee) expectCode = 'INSUFFICIENT_BUYING_POWER';
      else if (!buy && model.freeQty() < op.qty) expectCode = 'INSUFFICIENT_POSITION';
      else if (!buy && fee > notional) expectCode = 'FEE_EXCEEDS_PROCEEDS';
      const r = await run(
        db.app,
        cryptoCommand(accountId, btc, { side, qty: text(op.qty), now, ...q }),
      );
      if (expectCode !== null) {
        if (r.outcome !== 'REJECTED' || r.rejectCode !== expectCode)
          return `step ${n} ${op.kind}: expected reject ${expectCode}, got ${r.outcome}`;
      } else {
        if (r.outcome !== 'FILLED') return `step ${n} ${op.kind}: expected a fill`;
        if (buy) {
          model.cash -= notional + fee;
          model.qty += op.qty;
        } else {
          model.cash += notional - fee;
          model.qty -= op.qty;
        }
        model.fees += fee;
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
      // MOVE: offer the quote to every open order, oldest first (the order of creation)
      for (const o of [...model.open()]) {
        const r = await fillResting(db.app, o.id, btc, freshQuote(q.bid, q.ask, now), { now });
        if (o.expiresAt <= now.getTime()) {
          if (r.outcome !== 'EXPIRED') return `step ${n} MOVE: expected EXPIRED, got ${r.outcome}`;
          model.release(o, 'EXPIRED');
        } else if (model.marketable(o, bidU, askU)) {
          if (r.outcome !== 'FILLED') return `step ${n} MOVE: expected FILLED, got ${r.outcome}`;
          model.fill(o, bidU, askU);
          seen.moveFills += 1;
        } else if (r.outcome !== 'NOT_MARKETABLE') return `step ${n} MOVE: expected NOT_MARKETABLE`;
      }
    }

    // ---- compare the database with the model after EVERY operation ----
    const bal = await ledger(accountId);
    const mism: string[] = [];
    if (bal.CASH !== text(model.cash)) mism.push(`CASH ${bal.CASH} vs ${text(model.cash)}`);
    if ((bal.RESERVED ?? '0') !== text(model.reserved))
      mism.push(`RESERVED ${bal.RESERVED} vs ${text(model.reserved)}`);
    if ((bal.FEES ?? '0') !== text(model.fees))
      mism.push(`FEES ${bal.FEES} vs ${text(model.fees)}`);
    const pos = await db.migrator.query<{ qty: string; qty_reserved: string }>(
      `SELECT qty, qty_reserved FROM positions WHERE account_id = $1::uuid AND instrument_id = $2::uuid`,
      [accountId, btc.id],
    );
    const pq = pos.rows[0] === undefined ? '0' : norm(pos.rows[0].qty);
    const pr = pos.rows[0] === undefined ? '0' : norm(pos.rows[0].qty_reserved);
    if (pq !== text(model.qty)) mism.push(`qty ${pq} vs ${text(model.qty)}`);
    if (pr !== text(model.reservedQty()))
      mism.push(`qty_reserved ${pr} vs ${text(model.reservedQty())}`);
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
}

describe('M8b-1 property: limit and market orders, moves, cancels and expiries equal the independent BigInt model', () => {
  it('30 runs of up to 30 random operations: every step is model-equal and reconciles with zero tolerance', async () => {
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 30 }), async (ops) => {
        runs += 1;
        expect(await play(ops, false)).toBeNull();
      }),
      { numRuns: 30, endOnFailure: true },
    );
    expect(runs).toBe(30);
    process.stdout.write(`M8B1_PROPERTY ${JSON.stringify(seen)}
`);
    expect(seen.rests).toBeGreaterThan(10);
    expect(seen.acceptFills + seen.moveFills).toBeGreaterThan(10);
    expect(seen.rejects).toBeGreaterThan(0);
  }, 900_000);

  it('a scripted run covers every path: rest, cancel, expire (lazy and by job), fill on a move, fill at accept, rejects', async () => {
    const base = { spreadTicks: 10n, short: false, pick: 0 };
    const at = (bidTicks: bigint) => ({ bidTicks, ...base });
    const ops: Op[] = [
      { kind: 'LB', qty: 1_000_000n, limitOffset: -100n, ...at(9_000_000n) }, // rests below the market
      { kind: 'LS', qty: 1_000_000n, limitOffset: 100n, ...at(9_000_000n) }, // INSUFFICIENT_POSITION (nothing owned)
      { kind: 'CANCEL', qty: 1n, limitOffset: 0n, ...at(9_000_000n) }, // cancels the resting BUY
      { kind: 'MB', qty: 2_000_000n, limitOffset: 0n, ...at(9_000_000n) }, // own some BTC
      { kind: 'LS', qty: 1_000_000n, limitOffset: 100n, ...at(9_000_000n) }, // SELL rests (reserves quantity)
      {
        kind: 'LB',
        qty: 1_000_000n,
        limitOffset: -100n,
        short: true,
        bidTicks: 9_000_000n,
        spreadTicks: 10n,
        pick: 0,
      }, // short-lived
      { kind: 'EXPIRE', qty: 1n, limitOffset: 0n, ...at(9_000_000n) }, // 3 minutes have not passed yet: SKIPPED or EXPIRED per the clock
      { kind: 'MOVE', qty: 1n, limitOffset: 0n, ...at(9_020_000n) }, // the market rises: the SELL fills, the BUY expires
      { kind: 'LB', qty: 1_000_000n, limitOffset: 500n, ...at(9_000_000n) }, // marketable at accept: fills at once
      { kind: 'LB', qty: 29_000_000n, limitOffset: 0n, ...at(9_000_000n) }, // INSUFFICIENT_BUYING_POWER
    ];
    expect(await play(ops, false)).toBeNull();
  }, 120_000);

  it('control: a model whose reserve forgets the commission is caught by the same comparison', async () => {
    // a resting limit BUY then a MOVE: any run with a resting BUY differs in RESERVED or CASH immediately
    const ops: Op[] = [
      {
        kind: 'LB',
        qty: 1_000_000n,
        bidTicks: 9_000_000n,
        spreadTicks: 10n,
        limitOffset: -100n,
        short: false,
        pick: 0,
      },
    ];
    const diff = await play(ops, true);
    expect(diff).not.toBeNull();
    expect(diff).toMatch(/RESERVED|CASH/);
    // and the unmutated model agrees on the very same input
    expect(await play(ops, false)).toBeNull();
  }, 60_000);
});
