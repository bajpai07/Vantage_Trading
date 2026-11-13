// The independent reference model of the M4a property tests (shared with the M5 portfolio tests): plain arrays, FIFO by
// hand, all money in scaled integers (BigInt). It shares no code with the engine or the repository.
//
// Units: 1 cent = 1_000_000 units of 1e-8. A price is an integer number of cents; whole shares.
//   BUY  fill price = ceil(ask x 10002 / 10000) cents        (2 bps slippage, rounded UP to the tick)
//   SELL fill price = floor(bid x 9998 / 10000) cents        (2 bps slippage, rounded DOWN to the tick)
//   notional = qty x price; fee = round-half-even(notional x bps / 10000); lots hold the price (no fee)
import fc from 'fast-check';

export const CENT = 1_000_000n;
export const UNIT = 100_000_000n;
export const fmt = (u: bigint): string => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  return `${neg ? '-' : ''}${(a / UNIT).toString()}.${(a % UNIT).toString().padStart(8, '0')}00`;
};
/** round half even of n / d for positive d */
export function divRoundEven(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  const twice = r * 2n;
  if (twice > d) return q + 1n;
  if (twice < d) return q;
  return q % 2n === 0n ? q : q + 1n;
}

export interface Op {
  side: 'BUY' | 'SELL';
  inst: number;
  qty: number;
  bidC: number;
  spreadC: number;
  refMode: 'exact' | 'adverse';
  bps: 0 | 10;
}

export class Model {
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

export const opArb: fc.Arbitrary<Op> = fc.record({
  side: fc.constantFrom<'BUY' | 'SELL'>('BUY', 'BUY', 'SELL'), // a bit more buying so there is something to sell
  inst: fc.integer({ min: 0, max: 2 }),
  qty: fc.integer({ min: 1, max: 8 }),
  bidC: fc.integer({ min: 100, max: 120_000 }), // $1.00 to $1,200.00
  spreadC: fc.integer({ min: 1, max: 5 }),
  refMode: fc.constantFrom<'exact' | 'adverse'>('exact', 'exact', 'exact', 'adverse'),
  bps: fc.constantFrom<0 | 10>(0, 10),
});

export const priceStr = (c: bigint): string =>
  `${(c / 100n).toString()}.${(c % 100n).toString().padStart(2, '0')}`;
