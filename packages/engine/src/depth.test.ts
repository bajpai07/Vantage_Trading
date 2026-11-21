// M8b-2 T1: simulated depth. Golden vectors J, K, L are HARD-CODED strings with the arithmetic in comments; they are not
// computed by the code under test (L is computed by an independent BigInt reimplementation of the size recipe written
// below in this file; it shares only the seeded hash of the SIM feed, which has its own tests).
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hash4, hashText } from '@vantage/market-model';
import {
  DEPTH_MAX_LEVELS,
  EngineInputError,
  buildDepth,
  depthBucket,
  depthStepMultiple,
  samePrice,
  spreadAndMid,
} from './index.js';
import type { DepthInstrument } from './index.js';

const BTC: DepthInstrument = {
  symbol: 'BTC-USD',
  assetClass: 'CRYPTO',
  tickSize: '0.01',
  qtyStep: '0.00000001',
  minQty: '0.00000001',
};
const AAPL: DepthInstrument = {
  symbol: 'AAPL',
  assetClass: 'EQUITY',
  tickSize: '0.01',
  qtyStep: '1',
  minQty: '1',
};
const SEED = 'vantage-sim-seed';
const BUCKET = 1_234_567;

describe('J. BTC-USD price ladder (hand-verified)', () => {
  // quote bid 89,990.00 / ask 90,010.00, tick 0.01, crypto span 15 bps over 14 steps.
  // stepMultiple = floor((89,990.00 + 90,010.00) x 15 / (2 x 10,000 x 14 x 0.01)) = floor(180,000 x 15 / 2,800)
  //              = floor(2,700,000 / 2,800) = floor(964.2857) = 964, so levelStep = 0.01 x 964 = 9.64.
  // asks: L1 90,010.00; L2 90,010.00 + 9.64 = 90,019.64; L3 90,019.64 + 9.64 = 90,029.28;
  //       L15 90,010.00 + 14 x 9.64 = 90,010.00 + 134.96 = 90,144.96.
  // bids: L1 89,990.00; L2 89,990.00 - 9.64 = 89,980.36; L3 89,980.36 - 9.64 = 89,970.72;
  //       L15 89,990.00 - 134.96 = 89,855.04.
  const quote = { bid: '89990.00', ask: '90010.00' };
  const book = buildDepth(quote, BTC, SEED, 15, BUCKET);
  it('stepMultiple is 964', () => {
    expect(depthStepMultiple(quote, BTC)).toBe(964n);
  });
  it('asks', () => {
    expect(book.asks).toHaveLength(15);
    expect(book.asks.slice(0, 3).map((l) => l.price)).toEqual(['90010.00', '90019.64', '90029.28']);
    expect(book.asks[14]?.price).toBe('90144.96');
  });
  it('bids', () => {
    expect(book.bids).toHaveLength(15);
    expect(book.bids.slice(0, 3).map((l) => l.price)).toEqual(['89990.00', '89980.36', '89970.72']);
    expect(book.bids[14]?.price).toBe('89855.04');
  });
  it('the best bid and ask are exactly the quote', () => {
    expect(book.bids[0]?.price).toBe('89990.00');
    expect(book.asks[0]?.price).toBe('90010.00');
  });
});

describe('K. AAPL price ladder (hand-verified)', () => {
  // quote bid 189.95 / ask 190.00, tick 0.01, equity span 30 bps over 14 steps.
  // stepMultiple = floor((189.95 + 190.00) x 30 / (2 x 10,000 x 14 x 0.01)) = floor(379.95 x 30 / 2,800)
  //              = floor(11,398.5 / 2,800) = floor(4.0709) = 4, so levelStep = 0.04.
  // asks: L1 190.00; L2 190.04; L3 190.08; L15 190.00 + 14 x 0.04 = 190.56.
  // bids: L1 189.95; L2 189.91; L3 189.87; L15 189.95 - 0.56 = 189.39.
  const quote = { bid: '189.95', ask: '190.00' };
  const book = buildDepth(quote, AAPL, SEED, 15, BUCKET);
  it('stepMultiple is 4', () => {
    expect(depthStepMultiple(quote, AAPL)).toBe(4n);
  });
  it('asks', () => {
    expect(book.asks.slice(0, 3).map((l) => l.price)).toEqual(['190.00', '190.04', '190.08']);
    expect(book.asks[14]?.price).toBe('190.56');
  });
  it('bids', () => {
    expect(book.bids.slice(0, 3).map((l) => l.price)).toEqual(['189.95', '189.91', '189.87']);
    expect(book.bids[14]?.price).toBe('189.39');
  });
  it('sizes are whole shares', () => {
    for (const l of [...book.bids, ...book.asks]) expect(l.size).toMatch(/^[1-9][0-9]*$/);
  });
});

// ---- L. sizes: an INDEPENDENT BigInt reimplementation of the documented recipe --------------------------------------------
// notional(level) = BASE x shape x noise / 1,000,000 (USD in 1e-8), qty = notional x 1e8 / price rounded down to the step,
// never below max(min_qty, step). Crypto: BASE 30,000, shape = 1500 x 0.94^(level-1) permille, noise = 200 + r mod 1801.
// r = hash4(hash(seed), hash(symbol), bucket, side x 64 + level), side 0 = bids, 1 = asks.
function independentSize(
  seed: string,
  symbol: string,
  bucket: number,
  side: 0 | 1,
  level: number,
  priceTicks: bigint, // price in ticks of 0.01
): string {
  const r = BigInt(hash4(hashText(seed), hashText(symbol), bucket, side * 64 + level));
  const noise = 200n + (r % 1801n);
  const k = BigInt(level - 1);
  const shape = (1500n * 94n ** k) / 100n ** k;
  const E8 = 100_000_000n;
  const notional = (30_000n * E8 * shape * noise) / 1_000_000n; // USD, 1e-8 units
  const priceE8 = priceTicks * 1_000_000n;
  const qtyE8 = (notional * E8) / priceE8; // 1e-8 units of the coin (the step is 1e-8: no further rounding)
  const q = qtyE8 < 1n ? 1n : qtyE8;
  const whole = q / E8;
  const frac = (q % E8).toString().padStart(8, '0').replace(/0+$/, '');
  return `${whole}${frac === '' ? '' : `.${frac}`}`;
}

describe('L. sizes are reproducible', () => {
  const quote = { bid: '89990.00', ask: '90010.00' };
  // ladder in ticks (hand-verified in J): asks 90,010.00 = 9,001,000 ticks, then + 964 ticks per level; bids 8,999,000 - 964 x (level-1).
  const askTicks = (lvl: number): bigint => 9_001_000n + 964n * BigInt(lvl - 1);
  const bidTicks = (lvl: number): bigint => 8_999_000n - 964n * BigInt(lvl - 1);
  // Hand check of bid level 1: r = 37,648,640; 37,648,640 mod 1801 = 536, so noise = 200 + 536 = 736 permille; shape(1) = 1500;
  // notional = 30,000 x 1500 x 736 / 1,000,000 = 33,120 USD; qty = 33,120 / 89,990.00 = 0.36804089... -> 0.36804089 (step 1e-8, rounded down).
  const GOLD_BIDS = ['0.36804089', '0.77848988', '0.76654104', '0.76932769', '0.36828304'];
  const GOLD_ASKS = ['0.89690034', '0.78472875', '0.14923478', '0.30862653', '0.33472539'];

  it('the first five sizes per side equal the hard-coded strings and the independent reimplementation', () => {
    const book = buildDepth(quote, BTC, SEED, 15, BUCKET);
    const indepBids = [1, 2, 3, 4, 5].map((l) =>
      independentSize(SEED, 'BTC-USD', BUCKET, 0, l, bidTicks(l)),
    );
    const indepAsks = [1, 2, 3, 4, 5].map((l) =>
      independentSize(SEED, 'BTC-USD', BUCKET, 1, l, askTicks(l)),
    );
    expect(book.bids.slice(0, 5).map((l) => l.size)).toEqual(indepBids);
    expect(book.asks.slice(0, 5).map((l) => l.size)).toEqual(indepAsks);
    expect(indepBids).toEqual(GOLD_BIDS);
    expect(indepAsks).toEqual(GOLD_ASKS);
  });
  it('the same inputs twice give byte-identical output; another bucket or seed gives another book', () => {
    const a = JSON.stringify(buildDepth(quote, BTC, SEED, 15, BUCKET));
    expect(JSON.stringify(buildDepth(quote, BTC, SEED, 15, BUCKET))).toBe(a);
    expect(JSON.stringify(buildDepth(quote, BTC, SEED, 15, BUCKET + 1))).not.toBe(a);
    expect(JSON.stringify(buildDepth(quote, BTC, 'another-seed', 15, BUCKET))).not.toBe(a);
  });
  it('a smaller book is a prefix of a larger one (the same level is the same price and size)', () => {
    const big = buildDepth(quote, BTC, SEED, 25, BUCKET);
    const small = buildDepth(quote, BTC, SEED, 7, BUCKET);
    expect(small.asks.map((l) => [l.price, l.size])).toEqual(
      big.asks.slice(0, 7).map((l) => [l.price, l.size]),
    );
    expect(small.bids.map((l) => [l.price, l.size])).toEqual(
      big.bids.slice(0, 7).map((l) => [l.price, l.size]),
    );
  });
});

describe('helpers', () => {
  it('depthBucket is the quote time in whole 5-second buckets', () => {
    expect(depthBucket(0)).toBe(0);
    expect(depthBucket(4_999)).toBe(0);
    expect(depthBucket(5_000)).toBe(1);
    expect(depthBucket(1_700_000_004_999)).toBe(340_000_000);
  });
  it('spreadAndMid: exact decimals', () => {
    expect(spreadAndMid({ bid: '89990.00', ask: '90010.00' })).toEqual({
      spread: '20.00',
      mid: '90000.00',
    });
    expect(spreadAndMid({ bid: '189.95', ask: '190.00' })).toEqual({
      spread: '0.05',
      mid: '189.975',
    });
  });
  it('samePrice compares numbers, not spellings', () => {
    expect(samePrice('89990', '89990.00')).toBe(true);
    expect(samePrice('89990.01', '89990')).toBe(false);
    expect(samePrice('0', '0.00')).toBe(true);
  });
  it('rejects a crossed or locked quote, an off-grid price and a bad level count', () => {
    expect(() => buildDepth({ bid: '10.00', ask: '10.00' }, AAPL, SEED, 5, 1)).toThrow(
      EngineInputError,
    );
    expect(() => buildDepth({ bid: '10.01', ask: '10.00' }, AAPL, SEED, 5, 1)).toThrow(
      EngineInputError,
    );
    expect(() => buildDepth({ bid: '10.001', ask: '10.01' }, AAPL, SEED, 5, 1)).toThrow(
      EngineInputError,
    );
    for (const n of [0, 26, 1.5, -1])
      expect(() => buildDepth({ bid: '10.00', ask: '10.01' }, AAPL, SEED, n, 1)).toThrow(
        EngineInputError,
      );
    // controls: the boundaries are accepted
    expect(buildDepth({ bid: '10.00', ask: '10.01' }, AAPL, SEED, 1, 1).asks).toHaveLength(1);
    expect(
      buildDepth({ bid: '10.00', ask: '10.01' }, AAPL, SEED, DEPTH_MAX_LEVELS, 1).asks,
    ).toHaveLength(25);
  });
});

// ---- properties ----------------------------------------------------------------------------------------------------------------
const instArb: fc.Arbitrary<{ inst: DepthInstrument; tickU: bigint }> = fc.constantFrom(
  { inst: BTC, tickU: 1_000_000n },
  { inst: AAPL, tickU: 1_000_000n },
  {
    inst: {
      symbol: 'XRP-USD',
      assetClass: 'CRYPTO',
      tickSize: '0.0001',
      qtyStep: '0.00000001',
      minQty: '0.00000001',
    },
    tickU: 10_000n,
  },
  {
    inst: {
      symbol: 'DOGE-USD',
      assetClass: 'CRYPTO',
      tickSize: '0.00001',
      qtyStep: '0.00000001',
      minQty: '0.00000001',
    },
    tickU: 1_000n,
  },
  {
    inst: {
      symbol: 'SPY',
      assetClass: 'ETF',
      tickSize: '0.01',
      qtyStep: '1',
      minQty: '1',
    },
    tickU: 1_000_000n,
  },
);
const toText = (u: bigint): string => {
  const frac = (u % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${u / 100_000_000n}${frac === '' ? '' : `.${frac}`}`;
};
const toU = (s: string): bigint => {
  const [w, f = ''] = s.split('.');
  return BigInt(w as string) * 100_000_000n + BigInt(f.padEnd(8, '0'));
};

describe('depth properties (fast-check)', () => {
  it('ordering, tick grid, never crossed, sizes, level count, span, JSON-safe', () => {
    fc.assert(
      fc.property(
        instArb,
        fc.bigInt({ min: 1n, max: 200_000_000n }), // bid in ticks
        fc.bigInt({ min: 1n, max: 500n }), // spread in ticks
        fc.integer({ min: 1, max: 25 }),
        fc.nat(2_000_000_000),
        fc.string({ minLength: 1, maxLength: 12 }),
        ({ inst, tickU }, bidTicks, spreadTicks, levels, bucket, seed) => {
          const quote = {
            bid: toText(bidTicks * tickU),
            ask: toText((bidTicks + spreadTicks) * tickU),
          };
          const book = buildDepth(quote, inst, seed, levels, bucket);
          const step = toU(inst.qtyStep);
          const min = toU(inst.minQty);
          // asks strictly increasing from the quote ask; bids strictly decreasing from the quote bid
          expect(toU(book.asks[0]?.price as string)).toBe(toU(quote.ask));
          expect(toU(book.bids[0]?.price as string)).toBe(toU(quote.bid));
          for (let i = 1; i < book.asks.length; i += 1)
            expect(toU(book.asks[i]?.price as string)).toBeGreaterThan(
              toU(book.asks[i - 1]?.price as string),
            );
          for (let i = 1; i < book.bids.length; i += 1)
            expect(toU(book.bids[i]?.price as string)).toBeLessThan(
              toU(book.bids[i - 1]?.price as string),
            );
          // every price a positive multiple of the tick; never crossed
          for (const l of [...book.bids, ...book.asks]) {
            expect(toU(l.price) % tickU).toBe(0n);
            expect(toU(l.price)).toBeGreaterThan(0n);
            // every size > 0, a multiple of qty_step, >= min_qty, an exact string
            expect(toU(l.size)).toBeGreaterThan(0n);
            expect(toU(l.size) % step).toBe(0n);
            expect(toU(l.size)).toBeGreaterThanOrEqual(min);
            expect(l.cumPct).toBeGreaterThanOrEqual(0);
            expect(l.cumPct).toBeLessThanOrEqual(100);
            expect(Number.isInteger(l.cumPct)).toBe(true);
          }
          expect(toU(book.bids[0]?.price as string)).toBeLessThan(
            toU(book.asks[0]?.price as string),
          );
          // level count honoured (bids may stop early only when the next price would not be positive)
          expect(book.asks).toHaveLength(levels);
          const stepU = tickU * depthStepMultiple(quote, inst);
          const wantBids = Number(bigMin(BigInt(levels), (bidTicks * tickU - 1n) / stepU + 1n));
          expect(book.bids).toHaveLength(wantBids);
          // cumulative bars never decrease
          for (const side of [book.bids, book.asks])
            for (let i = 1; i < side.length; i += 1)
              expect(side[i]?.cumPct).toBeGreaterThanOrEqual(side[i - 1]?.cumPct as number);
          // span: the 15-level book is at most spanBps of the mid (when the step was not clamped up to one tick)
          const spanBps = inst.assetClass === 'CRYPTO' ? 15n : 30n;
          const sumU = toU(quote.bid) + toU(quote.ask);
          const unclamped = (sumU * spanBps) / (2n * 10_000n * 14n * tickU) >= 1n;
          if (unclamped) expect(stepU * 14n * 2n * 10_000n).toBeLessThanOrEqual(sumU * spanBps);
          // JSON-safe: only strings and an integer percent
          expect(JSON.parse(JSON.stringify(book))).toEqual(book);
          for (const l of [...book.bids, ...book.asks]) {
            expect(typeof l.price).toBe('string');
            expect(typeof l.size).toBe('string');
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a frozen inputs object gives the same book (the function reads only its arguments)', () => {
    const quote = Object.freeze({ bid: '89990.00', ask: '90010.00' });
    const inst = Object.freeze({ ...BTC });
    const a = buildDepth(quote, inst, SEED, 25, BUCKET);
    const b = buildDepth({ ...quote }, { ...inst }, SEED, 25, BUCKET);
    expect(a).toEqual(b);
  });

  it('the engine package still has no IO imports and the depth module imports only money, the market model and errors', () => {
    const src = readFileSync(new URL('./depth.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./errors.js', '@vantage/market-model', '@vantage/money']);
    expect(src).not.toMatch(/Date|Math\.|process\.|performance|fetch|setTimeout/);
  });
});

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
