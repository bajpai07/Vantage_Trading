// Simulated market depth (M8b-2, D-98 to D-100). PURE: a function of its arguments and nothing else: no clock, no IO,
// no floats, no randomness except the SIM feed's own seeded hash (`hash4`, the generator the price walk and the candles
// use). The depth is INFORMATIONAL: its best bid and best ask are exactly the validated quote's bid and ask, the levels
// beyond are synthetic, and nothing here is read by an order, a reservation, the matcher or the ledger (D-98).
//
// PRICES (D-99). Asks start at the quote ask and go up, bids start at the quote bid and go down, in steps of
//   levelStep = tick x stepMultiple.
// stepMultiple is an integer >= 1 derived from a documented per-asset-class constant, the SPAN (the width of a 15-level
// book as a share of the mid price): CRYPTO 15 bps (0.15%), EQUITY and ETF 30 bps (0.30%). A fixed tick multiple cannot
// give those spans for instruments whose prices differ by a factor of 600,000 (BTC 90,000 at tick 0.01; DOGE 0.15 at tick
// 0.00001), so the multiple is
//   stepMultiple = max(1, floor((bid + ask) x spanBps / (2 x 10,000 x 14 x tick)))      (14 = steps in a 15-level book)
// It does NOT depend on the number of levels requested, so level k is the same price in a 5-level and a 25-level book.
// Bids stop at the last price that is still positive.
//
// SIZES (D-99). For (seed, symbol, bucket, side, level) one 32-bit value r = hash4(hash(seed), hash(symbol), bucket,
// side x 64 + level) gives a noise factor in permille; the size of a level is the level's target notional divided by
// its price, rounded DOWN to the instrument's qty_step and never below max(min_qty, qty_step):
//   notional(level) = BASE_NOTIONAL(class) x shape(level) x noise(r) / 1,000,000
//   stocks (EQUITY, ETF): shape = 2000 x 4 / (level + 3)  permille (larger near the top), noise = 500 + r mod 1001
//   crypto:               shape = 1500 x 94^(level-1) / 100^(level-1) permille (noisy decay),
//                                                           noise = 200 + r mod 1801
// BASE_NOTIONAL is USD 40,000 for stocks and ETFs and USD 30,000 for crypto. The top level's size is its "displayed size":
// it is NEVER used for execution.
import { add, compare, div, isZero, parse, sign, sub } from '@vantage/money';
import { hash4, hashText } from '@vantage/market-model';
import { EngineInputError } from './errors.js';

export const DEPTH_DEFAULT_LEVELS = 15;
export const DEPTH_MAX_LEVELS = 25;
/** Quote-time bucket: the sizes of a book change once per bucket, not on every request (milliseconds). */
export const DEPTH_BUCKET_MS = 5000;
/** Steps in a 15-level book. */
const REFERENCE_STEPS = 14n;

export type DepthAssetClass = 'EQUITY' | 'ETF' | 'CRYPTO';

/** The documented per-asset-class constants (D-99). */
export const DEPTH_PARAMS: Readonly<
  Record<DepthAssetClass, { readonly spanBps: bigint; readonly baseNotionalUsd: bigint }>
> = {
  CRYPTO: { spanBps: 15n, baseNotionalUsd: 30_000n },
  EQUITY: { spanBps: 30n, baseNotionalUsd: 40_000n },
  ETF: { spanBps: 30n, baseNotionalUsd: 40_000n },
};

export interface DepthQuote {
  readonly bid: string;
  readonly ask: string;
}
export interface DepthInstrument {
  readonly symbol: string;
  readonly assetClass: DepthAssetClass;
  readonly tickSize: string;
  readonly qtyStep: string;
  readonly minQty: string;
}
export interface DepthLevel {
  /** An exact canonical decimal string (at least two decimals) on the tick grid. */
  readonly price: string;
  /** An exact decimal string, a positive multiple of qty_step, at least min_qty. */
  readonly size: string;
  /** Cumulative size from the top of this side down to this level, as an integer percent (0 to 100) of the larger side's total. */
  readonly cumPct: number;
}
export interface Depth {
  /** Best (highest) bid first. */
  readonly bids: readonly DepthLevel[];
  /** Best (lowest) ask first. */
  readonly asks: readonly DepthLevel[];
}

const UNIT = 100_000_000n; // 1e-8

function units(name: string, s: string): bigint {
  let d;
  try {
    d = parse(s);
  } catch {
    throw new EngineInputError(`${name} must be a plain decimal string`);
  }
  const text = d.toScaleString(8);
  return BigInt(text.replace('.', ''));
}

function text(u: bigint): string {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const frac = (a % UNIT).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${(a / UNIT).toString()}${frac === '' ? '' : `.${frac}`}`;
}

/** The bucket of a quote time (integer, epoch milliseconds / DEPTH_BUCKET_MS rounded down). */
export function depthBucket(quoteAtMs: number): number {
  return (quoteAtMs - (quoteAtMs % DEPTH_BUCKET_MS)) / DEPTH_BUCKET_MS;
}

/** stepMultiple of a quote (see the header): an integer >= 1. */
export function depthStepMultiple(
  quote: DepthQuote,
  instrument: Pick<DepthInstrument, 'assetClass' | 'tickSize'>,
): bigint {
  const tick = units('tickSize', instrument.tickSize);
  const bid = units('bid', quote.bid);
  const ask = units('ask', quote.ask);
  const span = DEPTH_PARAMS[instrument.assetClass].spanBps;
  const m = ((bid + ask) * span) / (2n * 10_000n * REFERENCE_STEPS * tick);
  return m < 1n ? 1n : m;
}

/** The recipe's noise and shape (permille) for one level. Exported for tests only through the book itself. */
function noisePermille(crypto: boolean, r: bigint): bigint {
  return crypto ? 200n + (r % 1801n) : 500n + (r % 1001n);
}
function shapePermille(crypto: boolean, level: bigint): bigint {
  if (!crypto) return (2000n * 4n) / (level + 3n);
  const k = level - 1n;
  return (1500n * 94n ** k) / 100n ** k;
}

function sizeOf(
  inst: DepthInstrument,
  priceU: bigint,
  stepU: bigint,
  minU: bigint,
  r: bigint,
  level: bigint,
): bigint {
  const crypto = inst.assetClass === 'CRYPTO';
  const notionalU =
    (DEPTH_PARAMS[inst.assetClass].baseNotionalUsd *
      UNIT *
      shapePermille(crypto, level) *
      noisePermille(crypto, r)) /
    1_000_000n;
  const qtyU = (notionalU * UNIT) / priceU;
  const floor = minU > stepU ? minU : stepU;
  const floorSteps = (floor + stepU - 1n) / stepU; // at least min_qty, in whole steps
  let steps = qtyU / stepU;
  if (steps < floorSteps) steps = floorSteps;
  return steps * stepU;
}

/**
 * buildDepth: see the header. `bucket` is the integer quote-time bucket (`depthBucket`), `seed` is the SIM seed.
 * Throws EngineInputError for a crossed or locked quote, an off-grid price or a level count outside 1..25.
 */
export function buildDepth(
  quote: DepthQuote,
  instrument: DepthInstrument,
  seed: string,
  levels: number,
  bucket: number,
): Depth {
  if (!Number.isInteger(levels) || levels < 1 || levels > DEPTH_MAX_LEVELS)
    throw new EngineInputError(`levels must be an integer from 1 to ${DEPTH_MAX_LEVELS}`);
  if (!Number.isSafeInteger(bucket) || bucket < 0)
    throw new EngineInputError('bucket must be a non-negative safe integer');
  const tick = units('tickSize', instrument.tickSize);
  const stepU = units('qtyStep', instrument.qtyStep);
  const minU = units('minQty', instrument.minQty);
  const bid = units('bid', quote.bid);
  const ask = units('ask', quote.ask);
  if (tick <= 0n || stepU <= 0n || minU <= 0n)
    throw new EngineInputError('tickSize, qtyStep and minQty must be positive');
  if (bid <= 0n || bid >= ask) throw new EngineInputError('the quote must have 0 < bid < ask');
  if (bid % tick !== 0n || ask % tick !== 0n)
    throw new EngineInputError('bid and ask must be multiples of the tick');

  const levelStep = tick * depthStepMultiple(quote, instrument);
  const seedH = hashText(seed);
  const symH = hashText(instrument.symbol);

  const side = (first: bigint, direction: 1n | -1n, sideCode: number): DepthLevel[] => {
    const raw: Array<{ price: bigint; size: bigint }> = [];
    for (let i = 0; i < levels; i += 1) {
      const price = first + direction * BigInt(i) * levelStep;
      if (price < tick) break; // bids stop at the last positive price
      const r = BigInt(hash4(seedH, symH, bucket, sideCode * 64 + i + 1));
      raw.push({ price, size: sizeOf(instrument, price, stepU, minU, r, BigInt(i + 1)) });
    }
    return raw.map((l) => ({
      price: parse(text(l.price)).toCanonicalString(),
      size: text(l.size),
      cumPct: 0,
    }));
  };
  const bids = side(bid, -1n, 0);
  const asks = side(ask, 1n, 1);

  // Bars: cumulative size from the top, as an integer percent of the larger side's total (integer arithmetic only).
  const cum = (ls: readonly DepthLevel[]): bigint[] => {
    let acc = 0n;
    return ls.map((l) => (acc += units('size', l.size)));
  };
  const cb = cum(bids);
  const ca = cum(asks);
  const totalB = cb[cb.length - 1] ?? 0n;
  const totalA = ca[ca.length - 1] ?? 0n;
  const denom = totalB > totalA ? totalB : totalA;
  const pct = (c: bigint): number => (denom === 0n ? 0 : +((c * 100n) / denom).toString());
  return {
    bids: bids.map((l, i) => ({ ...l, cumPct: pct(cb[i] as bigint) })),
    asks: asks.map((l, i) => ({ ...l, cumPct: pct(ca[i] as bigint) })),
  };
}

/** Exact spread (ask - bid) and mid ((bid + ask) / 2, one decimal more than the tick if needed) of a quote, as strings. */
export function spreadAndMid(quote: DepthQuote): { spread: string; mid: string } {
  const bid = parse(quote.bid);
  const ask = parse(quote.ask);
  if (compare(bid, ask) >= 0) throw new EngineInputError('the quote must have bid < ask');
  const mid = div(add(bid, ask), parse('2'), 9, 'HALF_EVEN');
  return { spread: sub(ask, bid).toCanonicalString(), mid: mid.toCanonicalString() };
}

/** True when two price strings are the same number (the order's limit against a ladder price). No rounding. */
export function samePrice(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  return compare(x, y) === 0 && !(isZero(x) && sign(y) !== 0);
}
