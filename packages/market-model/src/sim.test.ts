import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compare, parse, sub } from '@vantage/money';
import {
  GAP_AT_UTC_SECONDS,
  SIM_CRYPTO,
  SIM_STOCKS,
  SIM_UNIVERSE,
  SIM_UNIVERSE_AS_OF,
  SIM_UNIVERSE_NOTE,
  SIM_UNIVERSE_VERSION,
  expPpbToString,
  hash4,
  hashText,
  logOffsetPpb,
  simMid,
  simQuoteAt,
  tickString,
  validateQuote,
} from './index.js';
import type { Quote, RawQuote } from './index.js';

const by = new Map(SIM_UNIVERSE.map((c) => [c.symbol, c]));
const cfg = (symbol: string) => {
  const c = by.get(symbol);
  if (c === undefined) throw new Error(`no ${symbol}`);
  return c;
};
const sec = (iso: string) => Date.parse(iso) / 1000;

// ---- hashing: checked against an independent BigInt implementation of the same algorithm -------------------------------

const M = 0xffffffffn;
const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (32n - r))) & M;
function refMix(h: bigint, k: bigint): bigint {
  let kk = (k * 0xcc9e2d51n) & M;
  kk = rotl(kk, 15n);
  kk = (kk * 0x1b873593n) & M;
  let r = (h ^ kk) & M;
  r = rotl(r, 13n);
  return (r * 5n + 0xe6546b64n) & M;
}
function refFinish(h: bigint): bigint {
  let r = (h ^ 4n) & M;
  r ^= r >> 16n;
  r = (r * 0x85ebca6bn) & M;
  r ^= r >> 13n;
  r = (r * 0xc2b2ae35n) & M;
  r ^= r >> 16n;
  return r & M;
}
const refHash4 = (a: number, b: number, c: number, d: number): number => {
  const lo = BigInt(c) & M;
  const hi = BigInt(c) >> 32n;
  let h = 0n;
  for (const w of [BigInt(a) & M, BigInt(b) & M, lo, hi, BigInt(d) & M]) h = refMix(h, w);
  return Number(refFinish(h));
};
function refFnv(text: string): number {
  let h = 0x811c9dc5n;
  for (const ch of text) h = ((h ^ BigInt(ch.charCodeAt(0))) * 0x01000193n) & M;
  return Number(h);
}

describe('hashing (integer only)', () => {
  it('FNV-1a matches the published empty-string value and an independent BigInt version', () => {
    expect(hashText('')).toBe(2166136261); // the FNV-1a 32-bit offset basis
    for (const s of ['AAPL', 'vantage-demo-1', 'BTC-USD', 'x']) expect(hashText(s)).toBe(refFnv(s));
  });

  it('hash4 equals an independent BigInt implementation for random inputs (the 32-bit multiply is right)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 0, max: 5_000_000_000 }),
        fc.integer({ min: 0, max: 100 }),
        (a, b, c, d) => {
          expect(hash4(a, b, c, d)).toBe(refHash4(a, b, c, d));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('hard-coded hash values (a change here changes every simulated price)', () => {
    expect(hashText('vantage-demo-1')).toBe(341851261);
    expect(hashText('AAPL')).toBe(1489842955);
    expect(hash4(1, 2, 3, 4)).toBe(3366946716);
    expect(hash4(4294967295, 0, 5000000000, 23)).toBe(2028505653);
    expect(hash4(0, 0, 0, 0)).toBe(1576052596);
  });
});

describe('exp in fixed point', () => {
  it('matches known values to 12 decimals (truncated)', () => {
    expect(expPpbToString(0)).toBe('1.000000000000');
    expect(expPpbToString(1_000_000_000)).toBe('2.718281828458'); // e = 2.71828182845904...
    expect(expPpbToString(-500_000_000)).toBe('0.606530659712'); // e^-0.5 = 0.60653065971263...
    expect(expPpbToString(693_147_181)).toBe('2.000000000880'); // ln 2 = 0.693147180559945...
  });
});

// ---- goldens ---------------------------------------------------------------------------------------------------------
// Fixed (seed, symbol, time) -> exact strings. These were produced by this implementation and reviewed for plausibility
// (levels near the illustrative base, spreads of one to three ticks); they lock the model so a restart, a new machine or
// a refactor can never change what a given instant looked like.
const T_TUE = sec('2026-11-10T15:00:00Z');
const T_SUN = sec('2026-11-15T12:00:00Z');
const T_2027 = sec('2027-03-01T00:00:00Z');

const GOLDEN: Array<[string, string, number, boolean, string, string, string]> = [
  ['vantage-demo-1', 'AAPL', T_TUE, true, '187.05', '187.06', '187.05'],
  ['vantage-demo-1', 'AAPL', T_SUN, true, '189.66', '189.68', '189.67'],
  ['vantage-demo-1', 'AAPL', T_2027, true, '167.52', '167.53', '167.52'],
  ['vantage-demo-1', 'BTC-USD', T_TUE, false, '75459.99', '75460.00', '75459.99'],
  ['vantage-demo-1', 'BTC-USD', T_SUN, false, '74683.69', '74683.70', '74683.69'],
  ['vantage-demo-1', 'BTC-USD', T_2027, false, '62906.09', '62906.10', '62906.09'],
  ['vantage-demo-1', 'DOGE-USD', T_TUE, false, '0.19618', '0.19620', '0.19619'],
  ['vantage-demo-1', 'DOGE-USD', T_SUN, false, '0.18570', '0.18572', '0.18571'],
  ['vantage-demo-1', 'XRP-USD', T_TUE, false, '0.6270', '0.6272', '0.6271'],
  ['vantage-demo-1', 'XRP-USD', T_2027, false, '0.8019', '0.8021', '0.8020'],
  ['golden-seed-2', 'AAPL', T_TUE, true, '186.01', '186.02', '186.01'],
  ['golden-seed-2', 'AAPL', T_SUN, true, '195.75', '195.76', '195.75'],
  ['golden-seed-2', 'BTC-USD', T_TUE, false, '61290.10', '61290.11', '61290.10'],
  ['golden-seed-2', 'BTC-USD', T_SUN, false, '51644.17', '51644.18', '51644.17'],
  ['golden-seed-2', 'DOGE-USD', T_2027, false, '0.18126', '0.18128', '0.18127'],
  ['golden-seed-2', 'XRP-USD', T_SUN, false, '0.6797', '0.6800', '0.6798'],
];

describe('golden values: (seed, symbol, time) -> exact price strings', () => {
  it.each(GOLDEN)(
    '%s %s t=%s gaps=%s -> bid %s ask %s last %s',
    (seed, sym, t, gaps, bid, ask, last) => {
      expect(simQuoteAt(seed, cfg(sym), t, { gaps })).toEqual({ bid, ask, last });
    },
  );

  it('the same inputs give the same output every time, in any order (no hidden state)', () => {
    const first = GOLDEN.map(([seed, sym, t, gaps]) => simQuoteAt(seed, cfg(sym), t, { gaps }));
    const reversed = [...GOLDEN]
      .reverse()
      .map(([seed, sym, t, gaps]) => simQuoteAt(seed, cfg(sym), t, { gaps }))
      .reverse();
    expect(reversed).toEqual(first);
    // a price far in the future does not depend on having computed the earlier ones
    const direct = simQuoteAt('vantage-demo-1', cfg('AAPL'), T_2027, { gaps: true });
    for (let i = 0; i < 50; i += 1)
      simQuoteAt('vantage-demo-1', cfg('AAPL'), T_TUE + i, { gaps: true });
    expect(simQuoteAt('vantage-demo-1', cfg('AAPL'), T_2027, { gaps: true })).toEqual(direct);
  });

  it('a different seed or symbol gives a different path (control: the seed is used)', () => {
    const a = simMid('seed-a', cfg('AAPL'), T_TUE, { gaps: false });
    const b = simMid('seed-b', cfg('AAPL'), T_TUE, { gaps: false });
    expect(a).not.toBe(b);
    const pa = simMid('seed-a', cfg('MSFT'), T_TUE, { gaps: false });
    expect(logOffsetPpb('seed-a', cfg('AAPL'), T_TUE, { gaps: false })).not.toBe(
      logOffsetPpb('seed-a', cfg('MSFT'), T_TUE, { gaps: false }),
    );
    expect(pa).toBeTruthy();
  });
});

// ---- properties ------------------------------------------------------------------------------------------------------

describe('properties over many instants', () => {
  it('every price is a multiple of the tick, positive, with bid below ask and last between them (all instruments)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SIM_UNIVERSE),
        fc.integer({ min: 1_700_000_000, max: 2_000_000_000 }),
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /^[A-Za-z0-9._-]+$/.test(s)),
        (c, t, gaps, seed) => {
          const q = simQuoteAt(seed, c, t, { gaps });
          const tick = parse(tickString(c.tickDp));
          for (const p of [q.bid, q.ask, q.last]) {
            expect(parse(p).sign()).toBe(1);
            expect(p.split('.')[1]?.length ?? 0).toBe(c.tickDp); // exactly tickDp decimals
            // a multiple of the tick: dividing leaves no remainder at the tick's own scale
            const scaled = parse(p).div(tick, 0, 'HALF_EVEN');
            expect(scaled.mul(tick).equals(parse(p))).toBe(true);
          }
          expect(compare(parse(q.bid), parse(q.ask))).toBe(-1);
          const spreadTicks = sub(parse(q.ask), parse(q.bid)).div(tick, 0, 'HALF_EVEN').toString();
          expect(['1', '2', '3']).toContain(spreadTicks);
          expect(compare(parse(q.last), parse(q.bid))).toBeGreaterThanOrEqual(0);
          expect(compare(parse(q.last), parse(q.ask))).toBeLessThanOrEqual(0);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('a tick-sized spread never exceeds three ticks and the usual spread is the symbol configured one', () => {
    let widened = 0;
    for (let i = 0; i < 2000; i += 1) {
      const q = simQuoteAt('vantage-demo-1', cfg('TSLA'), T_TUE + i, { gaps: false });
      const w = sub(parse(q.ask), parse(q.bid)).toString();
      expect(['0.02', '0.03']).toContain(w); // TSLA: base 2 ticks, one tick wider about one second in four
      if (w === '0.03') widened += 1;
    }
    expect(widened).toBeGreaterThan(300);
    expect(widened).toBeLessThan(700);
  });

  it('movement is realistic in size: one second moves a fraction of a percent, a day a few percent', () => {
    for (const c of SIM_UNIVERSE) {
      let maxStep = 0;
      let prev = parse(simMid('vantage-demo-1', c, T_TUE, { gaps: false }));
      for (let i = 1; i <= 600; i += 1) {
        const m = parse(simMid('vantage-demo-1', c, T_TUE + i, { gaps: false }));
        const step = sub(m, prev).div(prev, 8, 'HALF_EVEN');
        const a = step.sign() < 0 ? step.negate() : step;
        if (compare(a, parse(String(maxStep))) > 0) maxStep = Number(a.toString());
        prev = m;
      }
      expect(maxStep, c.symbol).toBeLessThan(0.002); // no 0.2% jump in a second
    }
  });
});

// ---- validator over a simulated 24 hours -----------------------------------------------------------------------------

describe('the existing validator accepts every simulated quote over 24 hours (no second validation path)', () => {
  const DAY = 86400;
  const symbols = ['AAPL', 'TSLA', 'SPY', 'BTC-USD', 'DOGE-USD', 'XRP-USD'];
  it.each(symbols)(
    '%s: one quote per second for 24 h, none rejected, no warning, no held outlier',
    (symbol) => {
      const c = cfg(symbol);
      const start = sec('2026-11-10T00:00:00Z'); // includes the NYSE-mode gap time of day
      let last: Quote | null = null;
      let rejected = 0;
      let warnings = 0;
      let pending = false;
      for (let i = 0; i < DAY; i += 1) {
        const t = start + i;
        const q = simQuoteAt('vantage-demo-1', c, t, { gaps: true });
        const raw: RawQuote = {
          symbol,
          bid: q.bid,
          ask: q.ask,
          last: q.last,
          providerTs: new Date(t * 1000),
          receivedAt: new Date(t * 1000),
          source: 'SIM',
          entitlement: 'REAL_TIME',
          delaySeconds: 0,
        };
        const r = validateQuote(raw, last, null, new Date(t * 1000), {
          tickSize: tickString(c.tickDp),
        });
        if (!r.accepted) rejected += 1;
        else {
          warnings += r.warnings.length;
          if (r.nextPending !== null) pending = true;
          last = r.quote;
        }
      }
      expect({ rejected, warnings, pending }).toEqual({ rejected: 0, warnings: 0, pending: false });
    },
  );

  it('control: the same validator does reject a crossed or a 12% jump quote (the check can fail)', () => {
    const c = cfg('AAPL');
    const base = simQuoteAt('vantage-demo-1', c, T_TUE, { gaps: false });
    const mk = (bid: string, ask: string, t: number): RawQuote => ({
      symbol: 'AAPL',
      bid,
      ask,
      providerTs: new Date(t * 1000),
      receivedAt: new Date(t * 1000),
      source: 'SIM',
      entitlement: 'REAL_TIME',
      delaySeconds: 0,
    });
    const first = validateQuote(
      mk(base.bid, base.ask, T_TUE),
      null,
      null,
      new Date(T_TUE * 1000),
      {},
    );
    expect(first.accepted).toBe(true);
    const lastQ = first.accepted ? first.quote : null;
    const crossed = validateQuote(
      mk('190.00', '189.00', T_TUE + 1),
      lastQ,
      null,
      new Date((T_TUE + 1) * 1000),
      {},
    );
    expect(crossed).toMatchObject({ accepted: false, reason: 'CROSSED' });
    const jump = validateQuote(
      mk('210.00', '210.01', T_TUE + 2),
      lastQ,
      null,
      new Date((T_TUE + 2) * 1000),
      {},
    );
    expect(jump).toMatchObject({ accepted: false, reason: 'OUTLIER_UNCONFIRMED' });
  });
});

describe('the gap (NYSE session mode only)', () => {
  it('is bounded by the configured size, appears only with gaps on, and never on crypto', () => {
    const aapl = cfg('AAPL');
    let withGapDays = 0;
    for (let d = 0; d < 60; d += 1) {
      const before = sec('2026-11-01T00:00:00Z') + d * 86400 + GAP_AT_UTC_SECONDS - 1;
      const after = before + 1;
      const on = Math.abs(
        logOffsetPpb('vantage-demo-1', aapl, after, { gaps: true }) -
          logOffsetPpb('vantage-demo-1', aapl, before, { gaps: true }),
      );
      const off = Math.abs(
        logOffsetPpb('vantage-demo-1', aapl, after, { gaps: false }) -
          logOffsetPpb('vantage-demo-1', aapl, before, { gaps: false }),
      );
      expect(on).toBeLessThanOrEqual(2 * aapl.gapBps * 100000 + off); // at most two gap sizes (one day's value to the next)
      if (on > off + 100000) withGapDays += 1;
      const btc = cfg('BTC-USD');
      expect(logOffsetPpb('vantage-demo-1', btc, after, { gaps: true })).toBe(
        logOffsetPpb('vantage-demo-1', btc, after, { gaps: false }),
      );
    }
    expect(withGapDays).toBeGreaterThan(5); // "occasional": some days have one
    expect(withGapDays).toBeLessThan(45); // but not every day
  });
});

describe('the universe config (versioned, illustrative)', () => {
  it('is versioned, dated and says it is illustrative', () => {
    expect(SIM_UNIVERSE_VERSION).toBe(1);
    expect(SIM_UNIVERSE_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SIM_UNIVERSE_NOTE).toMatch(/illustrative/i);
  });
  it('has the default twelve stocks and ETFs and six crypto pairs, with unique symbols', () => {
    expect(SIM_STOCKS.map((s) => s.symbol)).toEqual([
      'AAPL',
      'MSFT',
      'NVDA',
      'TSLA',
      'AMZN',
      'GOOGL',
      'META',
      'SPY',
      'QQQ',
      'VOO',
      'JPM',
      'KO',
    ]);
    expect(SIM_CRYPTO.map((s) => s.symbol)).toEqual([
      'BTC-USD',
      'ETH-USD',
      'SOL-USD',
      'XRP-USD',
      'DOGE-USD',
      'BNB-USD',
    ]);
    expect(new Set(SIM_UNIVERSE.map((s) => s.symbol)).size).toBe(SIM_UNIVERSE.length);
  });
  it('every base price sits on its own tick grid and every spread setting is 1 to 3 ticks', () => {
    for (const c of SIM_UNIVERSE) {
      expect(c.basePrice.split('.')[1]?.length ?? 0, c.symbol).toBeLessThanOrEqual(c.tickDp);
      expect([1, 2, 3]).toContain(c.baseSpreadTicks);
      expect(c.exchange === 'CRYPTO').toBe(c.assetClass === 'CRYPTO');
      expect(c.gapBps === 0).toBe(c.assetClass === 'CRYPTO');
    }
  });
});
