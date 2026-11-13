import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { add, mul, parse, sub } from '@vantage/money';
import { capitalIdentity, roundDisplay, summarisePortfolio, valuePosition } from './index.js';
import type { PositionInput, PositionValuation } from './index.js';

// Every expected value below is a hard-coded string worked out by hand, never computed by the code under test.

const TS = new Date('2026-11-10T14:45:00.000Z');
const quote = (bid: string | null, last: string | null = null) => ({
  bid,
  last,
  providerTs: TS,
  source: 'FIXTURE',
});
const aapl = (over: Partial<PositionInput> = {}): PositionInput => ({
  symbol: 'AAPL',
  qty: '10',
  costBasis: '1900.40',
  quote: quote('195.00'),
  freshness: 'DELAYED',
  ...over,
});

describe('golden vectors (M4a vector 1 position, marked at 195.00)', () => {
  it('V1: cash 8,099.60 + 10 AAPL (cost 1,900.40) at bid 195.00: value 1,950.00, unrealised +49.60, equity 10,049.60, return +49.60', () => {
    // 10 x 195.00 = 1950.00; 1950.00 - 1900.40 = 49.60; equity = 8099.60 + 1950.00 = 10049.60; 10049.60 - 10000 = 49.60
    const v = valuePosition(aapl());
    expect(v).toEqual({
      valuation: 'VALUED',
      symbol: 'AAPL',
      qty: '10',
      costBasis: '1900.40',
      mark: '195',
      markBasis: 'BID',
      marketValue: '1950',
      unrealisedPnl: '49.6',
      freshness: 'DELAYED',
      quoteAsOf: TS,
      source: 'FIXTURE',
    });
    const s = summarisePortfolio({
      cash: '8099.60',
      positions: [v],
      realisedPnl: '0',
      fees: '0',
      initialCapital: '10000',
    });
    expect(s).toMatchObject({
      cash: '8099.6',
      positionsValue: '1950',
      unrealisedPnl: '49.6',
      costBasis: '1900.4',
      equity: '10049.6',
      incomplete: false,
      totalReturn: '49.6',
      unvaluedCount: 0,
      oldestQuoteAsOf: TS,
    });
    // ledger identity: 8099.60 + 1900.40 + 0 - 0 = 10000
    expect(
      capitalIdentity({ cash: '8099.60', costBasis: '1900.40', fees: '0', realisedPnl: '0' }),
    ).toBe('10000');
  });

  it('V2: after the M4a SELL (10 at 194.96, realised +49.20) there is no position: equity 10,049.20, return +49.20, identity holds', () => {
    // cash 10049.20, no positions; REALIZED_PNL balance -49.20 so realised = +49.20; 10049.20 + 0 + 0 - 49.20 = 10000
    const s = summarisePortfolio({
      cash: '10049.20',
      positions: [],
      realisedPnl: '49.20',
      fees: '0',
      initialCapital: '10000',
    });
    expect(s).toMatchObject({
      equity: '10049.2',
      totalReturn: '49.2',
      incomplete: false,
      realisedPnl: '49.2',
      positionsValue: '0',
      oldestQuoteAsOf: null,
    });
    expect(
      capitalIdentity({ cash: '10049.20', costBasis: '0', fees: '0', realisedPnl: '49.20' }),
    ).toBe('10000');
  });

  it('V3: no usable quote: the position is excluded from the totals with an explicit flag; return is null (never zero-valued, never at cost)', () => {
    for (const p of [
      aapl({ quote: null, freshness: 'UNAVAILABLE' }),
      aapl({ freshness: 'UNAVAILABLE' }), // a quote object but the shared function says UNAVAILABLE
    ]) {
      const v = valuePosition(p);
      expect(v).toEqual({
        valuation: 'UNAVAILABLE',
        symbol: 'AAPL',
        qty: '10',
        costBasis: '1900.40',
        freshness: 'UNAVAILABLE',
        reason: 'NO_QUOTE',
      });
      const s = summarisePortfolio({
        cash: '8099.60',
        positions: [v],
        realisedPnl: '0',
        fees: '0',
        initialCapital: '10000',
      });
      expect(s).toMatchObject({
        positionsValue: '0',
        equity: '8099.6', // cash only: the position is excluded, not valued at zero or at cost
        incomplete: true,
        totalReturn: null,
        unvaluedCount: 1,
        unvaluedCostBasis: '1900.4',
        costBasis: '1900.4', // still part of the books
        unrealisedPnl: '0',
        oldestQuoteAsOf: null,
      });
    }
  });

  it('V3b: a quote with neither a positive bid nor a positive last is UNAVAILABLE (NO_USABLE_PRICE)', () => {
    for (const q of [quote(null, null), quote('0', null), quote(null, '0'), quote('0', '0')]) {
      expect(valuePosition(aapl({ quote: q }))).toMatchObject({
        valuation: 'UNAVAILABLE',
        reason: 'NO_USABLE_PRICE',
        freshness: 'DELAYED',
      });
    }
  });

  it('V4: a STALE quote is valued but labelled STALE; CLOSED is valued with the last close and labelled CLOSED', () => {
    expect(valuePosition(aapl({ freshness: 'STALE' }))).toMatchObject({
      valuation: 'VALUED',
      freshness: 'STALE',
      marketValue: '1950',
    });
    expect(valuePosition(aapl({ freshness: 'CLOSED' }))).toMatchObject({
      valuation: 'VALUED',
      freshness: 'CLOSED',
      quoteAsOf: TS,
    });
    // control: a fresh one keeps its own label
    expect(valuePosition(aapl({ freshness: 'REAL_TIME' }))).toMatchObject({
      freshness: 'REAL_TIME',
    });
  });

  it('V5: the bid is the mark; last only when there is no bid (labelled LAST); the ask is not an input at all', () => {
    expect(valuePosition(aapl({ quote: quote('195.00', '199.00') }))).toMatchObject({
      mark: '195',
      markBasis: 'BID',
      marketValue: '1950',
    });
    // 10 x 196.50 = 1965.00; 1965.00 - 1900.40 = 64.60
    expect(valuePosition(aapl({ quote: quote(null, '196.50') }))).toMatchObject({
      mark: '196.5',
      markBasis: 'LAST',
      marketValue: '1965',
      unrealisedPnl: '64.6',
    });
  });

  it('V6: two positions: values add up exactly, the oldest quote time is reported', () => {
    // AAPL 10 @ cost 1900.40, bid 195.00 -> 1950.00 (+49.60); MSFT 3 @ cost 300.06 (3 x 100.02), bid 101.00 -> 303.00 (+2.94)
    // positions value 2253.00; cost 2200.46; unrealised 52.54; cash 10000 - 2200.46 = 7799.54; equity 10052.54
    const older = new Date('2026-11-10T14:40:00.000Z');
    const msft: PositionInput = {
      symbol: 'MSFT',
      qty: '3',
      costBasis: '300.06',
      quote: { bid: '101.00', providerTs: older, source: 'FIXTURE' },
      freshness: 'DELAYED',
    };
    const s = summarisePortfolio({
      cash: '7799.54',
      positions: [valuePosition(aapl()), valuePosition(msft)],
      realisedPnl: '0',
      fees: '0',
      initialCapital: '10000',
    });
    expect(s).toMatchObject({
      positionsValue: '2253',
      costBasis: '2200.46',
      unrealisedPnl: '52.54',
      equity: '10052.54',
      totalReturn: '52.54',
      incomplete: false,
    });
    expect(s.oldestQuoteAsOf).toEqual(older);
  });

  it('V7: one valued and one unavailable position: only the valued one is in the totals, flagged incomplete', () => {
    const msft: PositionInput = {
      symbol: 'MSFT',
      qty: '3',
      costBasis: '300.06',
      quote: null,
      freshness: 'UNAVAILABLE',
    };
    const s = summarisePortfolio({
      cash: '7799.54',
      positions: [valuePosition(aapl()), valuePosition(msft)],
      realisedPnl: '0',
      fees: '0',
      initialCapital: '10000',
    });
    expect(s).toMatchObject({
      positionsValue: '1950',
      equity: '9749.54', // 7799.54 + 1950.00; MSFT excluded
      unrealisedPnl: '49.6',
      valuedCostBasis: '1900.4',
      unvaluedCostBasis: '300.06',
      costBasis: '2200.46',
      unvaluedCount: 1,
      incomplete: true,
      totalReturn: null,
    });
  });

  it('V8: market value is rounded once, at 8 decimal places HALF_EVEN (3 x 33.333333335 = 100.000000005 -> 100)', () => {
    const v = valuePosition({
      symbol: 'X',
      qty: '3',
      costBasis: '100',
      quote: quote('33.333333335'),
      freshness: 'DELAYED',
    });
    expect(v).toMatchObject({ marketValue: '100', unrealisedPnl: '0' });
    // and a tie that rounds up to the even neighbour: 3 x 33.333333345 = 100.000000035 -> 100.00000004
    expect(
      valuePosition({
        symbol: 'X',
        qty: '3',
        costBasis: '100',
        quote: quote('33.333333345'),
        freshness: 'DELAYED',
      }),
    ).toMatchObject({ marketValue: '100.00000004' });
  });

  it('fees are reported as given and do not enter equity separately (they are already out of cash)', () => {
    // buy 10 with a 1.9004 fee: cash 8097.6996, cost 1900.40, fees 1.9004: 8097.6996 + 1900.40 + 1.9004 = 10000
    expect(
      capitalIdentity({
        cash: '8097.6996',
        costBasis: '1900.40',
        fees: '1.9004',
        realisedPnl: '0',
      }),
    ).toBe('10000');
    const s = summarisePortfolio({
      cash: '8097.6996',
      positions: [valuePosition(aapl())],
      realisedPnl: '0',
      fees: '1.9004',
      initialCapital: '10000',
    });
    // equity 8097.6996 + 1950 = 10047.6996; return 47.6996 = unrealised 49.60 - fees 1.9004
    expect(s).toMatchObject({ equity: '10047.6996', totalReturn: '47.6996', fees: '1.9004' });
  });

  it('rejects malformed input instead of guessing (a non-decimal quantity or cost)', () => {
    expect(() => valuePosition(aapl({ qty: '1e3' }))).toThrow();
    expect(() => valuePosition(aapl({ costBasis: 'abc' }))).toThrow();
    expect(() =>
      summarisePortfolio({
        cash: 'x',
        positions: [],
        realisedPnl: '0',
        fees: '0',
        initialCapital: '10000',
      }),
    ).toThrow();
  });
});

describe('display rounding (API edge only)', () => {
  it.each([
    ['1950', '1950.00'],
    ['49.6', '49.60'],
    ['0.125', '0.12'], // HALF_EVEN: tie goes to the even digit
    ['0.135', '0.14'],
    ['0.12500001', '0.13'],
    ['-0.125', '-0.12'],
    ['-0.135', '-0.14'],
    ['10047.6996', '10047.70'],
    ['0', '0.00'],
    ['-0.004', '0.00'],
  ])('%s -> %s', (input, out) => {
    expect(roundDisplay(input)).toBe(out);
  });
});

describe('properties (exact decimals)', () => {
  const price = fc
    .integer({ min: 1, max: 99_999_999 })
    .map((n) => `${String(Math.floor(n / 100))}.${String(n % 100).padStart(2, '0')}`);
  const posArb = fc.record({
    qty: fc.integer({ min: 1, max: 5000 }).map(String),
    cost: price,
    bid: fc.option(price, { nil: null }),
    last: fc.option(price, { nil: null }),
    fresh: fc.constantFrom('REAL_TIME', 'DELAYED', 'STALE', 'CLOSED', 'UNAVAILABLE'),
  });
  interface Row {
    qty: string;
    cost: string;
    bid: string | null;
    last: string | null;
    fresh: string;
  }
  const build = (rows: Row[]): PositionValuation[] =>
    rows.map((r, i) =>
      valuePosition({
        symbol: `S${String(i)}`,
        qty: r.qty,
        costBasis: mul(parse(r.qty), parse(r.cost)).toString(),
        quote: { bid: r.bid, last: r.last, providerTs: TS, source: 'FIXTURE' },
        freshness: r.fresh as PositionInput['freshness'],
      }),
    );

  it('equity = cash + sum of the valued market values; unrealised = value - cost per valued position', () => {
    fc.assert(
      fc.property(fc.array(posArb, { maxLength: 12 }), price, (rows, cash) => {
        const positions = build(rows);
        const s = summarisePortfolio({
          cash,
          positions,
          realisedPnl: '0',
          fees: '0',
          initialCapital: '10000',
        });
        let sum = parse('0');
        let unreal = parse('0');
        for (const p of positions) {
          if (p.valuation === 'VALUED') {
            sum = add(sum, parse(p.marketValue));
            expect(
              parse(p.unrealisedPnl).equals(sub(parse(p.marketValue), parse(p.costBasis))),
            ).toBe(true);
            unreal = add(unreal, parse(p.unrealisedPnl));
          }
        }
        expect(parse(s.equity).equals(add(parse(cash), sum))).toBe(true);
        expect(parse(s.unrealisedPnl).equals(unreal)).toBe(true);
        expect(s.incomplete).toBe(positions.some((p) => p.valuation === 'UNAVAILABLE'));
        expect(s.totalReturn === null).toBe(s.incomplete);
        // all-position cost basis always includes the unvalued ones
        const allCost = positions.reduce((a, p) => add(a, parse(p.costBasis)), parse('0'));
        expect(parse(s.costBasis).equals(allCost)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('the summary does not depend on the order of the positions', () => {
    fc.assert(
      fc.property(
        fc.array(posArb, { minLength: 2, maxLength: 12 }),
        price,
        fc.integer(),
        (rows, cash, seed) => {
          const positions = build(rows);
          const shuffled = [...positions].sort(
            (a, b) =>
              ((a.symbol.charCodeAt(1) * 31 + seed) % 7) -
              ((b.symbol.charCodeAt(1) * 31 + seed) % 7),
          );
          const reversed = [...positions].reverse();
          const mk = (p: PositionValuation[]) =>
            summarisePortfolio({
              cash,
              positions: p,
              realisedPnl: '0',
              fees: '0',
              initialCapital: '10000',
            });
          const a = mk(positions);
          expect(mk(reversed)).toEqual(a);
          expect(mk(shuffled)).toEqual(a);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a position is never valued at zero or at cost: it is either VALUED at a positive mark or UNAVAILABLE', () => {
    fc.assert(
      fc.property(posArb, (r) => {
        const [p] = build([r]);
        if (p?.valuation === 'VALUED') {
          expect(parse(p.mark).sign()).toBe(1);
          expect(parse(p.marketValue).sign()).toBe(1);
        } else {
          expect(p).toMatchObject({ valuation: 'UNAVAILABLE' });
          expect(p).not.toHaveProperty('marketValue');
        }
      }),
      { numRuns: 200 },
    );
  });
});
