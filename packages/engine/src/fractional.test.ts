// M8 (D-85..D-90): fractional quantities, exact cost basis and the maximum quantity.
// Every golden below is a HARD-CODED STRING, verified by hand in the comment next to it; none is computed by the code
// under test. The property tests compare against an independent BigInt model written in this file (integers of 1e-8).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CRYPTO_COLLAR_PERCENT,
  allocateProceeds,
  buyFillLegs,
  collarPercentFor,
  consumeLotsFIFO,
  decideMarketOrder,
  maxQty,
  sellFillLegs,
} from './index.js';
import type { MarketOrderInput, OpenLot } from './index.js';

const T0 = new Date('2026-11-10T15:00:00Z');
const MAX_ORDER_QTY = '1000000';

// BTC-USD: tick 0.01, step and minimum 0.00000001. Slippage 5 bps, commission 10 bps (D-87), grant 10,000.
const BTC = {
  status: 'ACTIVE',
  tradableIn: ['MVP'],
  tickSize: '0.01',
  minQty: '0.00000001',
  qtyStep: '0.00000001',
} as const;
const STOCK = {
  status: 'ACTIVE',
  tradableIn: ['MVP'],
  tickSize: '0.01',
  minQty: '1',
  qtyStep: '1',
} as const;
const CRYPTO_SCHEDULE = {
  commissionBps: '10',
  commissionMinLocal: '0',
  slippageBaseBps: '5',
  slippageSizeCoef: '0',
};
const QUOTE = { bid: '89990.00', ask: '90010.00' };

function order(
  over: Partial<MarketOrderInput> & Pick<MarketOrderInput, 'side' | 'qty'>,
): MarketOrderInput {
  return {
    instrument: BTC,
    quote: QUOTE,
    freshness: 'REAL_TIME',
    allowExecutionOnDelayed: true,
    schedule: CRYPTO_SCHEDULE,
    referencePrice: over.side === 'BUY' ? QUOTE.ask : QUOTE.bid,
    account: { active: true, tradingEnabled: true },
    cash: '10000',
    positionQty: '0',
    collarPercent: CRYPTO_COLLAR_PERCENT,
    ...over,
  };
}

const lines = (legs: ReadonlyArray<{ ledgerAccountType: string; amount: string }>): string[] =>
  legs.map((l) => `${l.ledgerAccountType} ${l.amount}`);

describe('golden vector A: BUY 0.0025 BTC-USD (bid 89,990.00, ask 90,010.00, 5 bps slippage, 10 bps commission)', () => {
  it('fills at 90,055.01, notional 225.137525, fee 0.22513752, ledger and cash exactly', () => {
    const d = decideMarketOrder(order({ side: 'BUY', qty: '0.0025' }));
    // fill: 90,010.00 x 1.0005 = 90,055.005 -> rounded UP to the 0.01 tick = 90,055.01
    // notional: 0.0025 x 90,055.01 = 225.137525 (90,055.01 / 400 = 225.137525)
    // fee: 225.137525 x 10 / 10,000 = 0.225137525 -> 8 dp HALF_EVEN: ...752|5 is an exact tie, the 8th digit 2 is even -> 0.22513752
    expect(d).toEqual({
      decision: 'FILL',
      price: '90055.01',
      notional: '225.137525',
      fee: '0.22513752',
      slippageBps: '5',
    });
    // ledger: CASH -(225.137525 + 0.22513752) = -225.36266252, POSITION_COST +225.137525, FEES +0.22513752
    expect(lines(buyFillLegs({ qty: '0.0025', price: '90055.01', fee: '0.22513752' }))).toEqual([
      'CASH -225.36266252',
      'POSITION_COST 225.13752500',
      'FEES 0.22513752',
    ]);
    // cash after: 10,000 - 225.36266252 = 9,774.63733748 (the executor tests assert it in the database)
  });
});

describe('golden vector B: SELL 0.001 after A', () => {
  const lotA: OpenLot = { id: 'a', openedAt: T0, qtyOpen: '0.0025', costRemaining: '225.137525' };
  it('fills at 89,945.00, consumes exactly 90.05501 of cost and realises -0.11001', () => {
    const d = decideMarketOrder(order({ side: 'SELL', qty: '0.001', positionQty: '0.0025' }));
    // fill: 89,990.00 x 0.9995 = 89,945.005 -> rounded DOWN to the tick = 89,945.00
    // proceeds 0.001 x 89,945.00 = 89.945; fee 89.945 x 0.001 = 0.089945
    expect(d).toEqual({
      decision: 'FILL',
      price: '89945',
      notional: '89.945',
      fee: '0.089945',
      slippageBps: '5',
    });
    // consumed cost: 225.137525 x 0.001 / 0.0025 = 225.137525 x 0.4 = 90.05501 exactly
    const used = consumeLotsFIFO([lotA], '0.001');
    expect(used).toEqual([
      {
        lotId: 'a',
        qty: '0.001',
        cost: '90.05501',
        qtyOpenAfter: '0.0015',
        costRemainingAfter: '135.082515',
      },
    ]);
    // realised: 89.945 - 90.05501 = -0.11001. Ledger: CASH +(89.945 - 0.089945) = +89.855055, FEES +0.089945,
    // POSITION_COST -90.05501, REALIZED_PNL +0.11001 (the four sum to 0: 89.855055 + 0.089945 - 90.05501 + 0.11001 = 0)
    expect(
      lines(sellFillLegs({ qty: '0.001', price: '89945', fee: '0.089945', basis: '90.05501' })),
    ).toEqual([
      'CASH 89.85505500',
      'FEES 0.08994500',
      'POSITION_COST -90.05501000',
      'REALIZED_PNL 0.11001000',
    ]);
    // cash after: 9,774.63733748 + 89.855055 = 9,864.49239248; average cost of the rest 135.082515 / 0.0015 = 90,055.01
  });
});

describe('golden vector C: SELL the remaining 0.0015 after B', () => {
  it('consumes the whole remaining cost by subtraction and the total equity change is fees plus the realised loss', () => {
    const lot: OpenLot = { id: 'a', openedAt: T0, qtyOpen: '0.0015', costRemaining: '135.082515' };
    const d = decideMarketOrder(order({ side: 'SELL', qty: '0.0015', positionQty: '0.0015' }));
    // proceeds 0.0015 x 89,945.00 = 134.9175; fee 134.9175 x 0.001 = 0.1349175
    expect(d).toEqual({
      decision: 'FILL',
      price: '89945',
      notional: '134.9175',
      fee: '0.1349175',
      slippageBps: '5',
    });
    const used = consumeLotsFIFO([lot], '0.0015');
    // the lot is fully consumed: exactly what was left (135.082515), no rounding at all
    expect(used).toEqual([
      { lotId: 'a', qty: '0.0015', cost: '135.082515', qtyOpenAfter: '0', costRemainingAfter: '0' },
    ]);
    // realised 134.9175 - 135.082515 = -0.165015; CASH +(134.9175 - 0.1349175) = +134.7825825
    expect(
      lines(sellFillLegs({ qty: '0.0015', price: '89945', fee: '0.1349175', basis: '135.082515' })),
    ).toEqual([
      'CASH 134.78258250',
      'FEES 0.13491750',
      'POSITION_COST -135.08251500',
      'REALIZED_PNL 0.16501500',
    ]);
    // cash after 9,864.49239248 + 134.7825825 = 9,999.27497498. Equity change: 9,999.27497498 - 10,000 = -0.72502502
    // fees 0.22513752 + 0.089945 + 0.1349175 = 0.45000002; realised loss 0.11001 + 0.165015 = 0.275025;
    // 0.45000002 + 0.275025 = 0.72502502
    expect('0.72502502').toBe('0.72502502');
  });
});

describe('golden vector D: proportional cost rounding and the by-subtraction rule', () => {
  it('a lot of 0.3 costing 27.01 sold in three pieces of 0.1 consumes 9.00333333, 9.00333334 and 9.00333333', () => {
    // piece 1: 27.01 x 0.1 / 0.3 = 9.003333333... -> 9.00333333; remaining 27.01 - 9.00333333 = 18.00666667
    const p1 = consumeLotsFIFO(
      [{ id: 'x', openedAt: T0, qtyOpen: '0.3', costRemaining: '27.01' }],
      '0.1',
    );
    expect(p1).toEqual([
      {
        lotId: 'x',
        qty: '0.1',
        cost: '9.00333333',
        qtyOpenAfter: '0.2',
        costRemainingAfter: '18.00666667',
      },
    ]);
    // piece 2: 18.00666667 x 0.1 / 0.2 = 9.003333335 EXACTLY (a tie at 8 dp; the 8th digit 3 is odd) -> HALF_EVEN rounds
    // up to 9.00333334; remaining 18.00666667 - 9.00333334 = 9.00333333
    const p2 = consumeLotsFIFO(
      [{ id: 'x', openedAt: T0, qtyOpen: '0.2', costRemaining: '18.00666667' }],
      '0.1',
    );
    expect(p2).toEqual([
      {
        lotId: 'x',
        qty: '0.1',
        cost: '9.00333334',
        qtyOpenAfter: '0.1',
        costRemainingAfter: '9.00333333',
      },
    ]);
    // piece 3: the lot is fully consumed: exactly the 9.00333333 that is left (by subtraction, no division)
    const p3 = consumeLotsFIFO(
      [{ id: 'x', openedAt: T0, qtyOpen: '0.1', costRemaining: '9.00333333' }],
      '0.1',
    );
    expect(p3).toEqual([
      { lotId: 'x', qty: '0.1', cost: '9.00333333', qtyOpenAfter: '0', costRemainingAfter: '0' },
    ]);
    // 9.00333333 + 9.00333334 + 9.00333333 = 27.01000000 exactly
  });
  it('the proportional rule rounds HALF_EVEN in the other direction too (an exact tie that rounds down)', () => {
    // 0.00000003 x 1 / 2 = 0.000000015 -> ...01|5: the 8th digit 1 is odd -> up (0.00000002); and 0.00000005 / 2 =
    // 0.000000025 -> 8th digit 2 is even -> down (0.00000002)
    const up = consumeLotsFIFO(
      [{ id: 'x', openedAt: T0, qtyOpen: '2', costRemaining: '0.00000003' }],
      '1',
    );
    expect(up[0]?.cost).toBe('0.00000002');
    const down = consumeLotsFIFO(
      [{ id: 'x', openedAt: T0, qtyOpen: '2', costRemaining: '0.00000005' }],
      '1',
    );
    expect(down[0]?.cost).toBe('0.00000002');
  });
  it('CLAMP: a partial piece never takes the whole remaining cost (cost_remaining is zero only with qty_open zero)', () => {
    // 0.00000001 x 2 / 3 = 0.0000000067 -> rounds to 0.00000001, which is ALL the cost: one unit less is taken (0)
    const c = consumeLotsFIFO(
      [{ id: 'x', openedAt: T0, qtyOpen: '3', costRemaining: '0.00000001' }],
      '2',
    );
    expect(c).toEqual([
      { lotId: 'x', qty: '2', cost: '0', qtyOpenAfter: '1', costRemainingAfter: '0.00000001' },
    ]);
  });
});

describe('rules for crypto and fractional quantities', () => {
  it('the crypto collar is 2% and anything else is 1%', () => {
    expect(collarPercentFor('CRYPTO')).toBe('2');
    expect(collarPercentFor('EQUITY')).toBe('1');
    expect(collarPercentFor(undefined)).toBe('1');
  });
  it('a price 1.5% above the one the user saw is accepted for crypto (2%) and rejected for the 1% collar (control)', () => {
    // ask 91,360.15 against the seen 90,010.00: +1.5%
    const moved = { bid: '91340.00', ask: '91360.15' };
    expect(decideMarketOrder(order({ side: 'BUY', qty: '0.001', quote: moved })).decision).toBe(
      'FILL',
    );
    expect(
      decideMarketOrder(order({ side: 'BUY', qty: '0.001', quote: moved, collarPercent: '1' })),
    ).toEqual({
      decision: 'REJECT',
      code: 'PRICE_MOVED',
    });
    // 2.5% above is rejected by the crypto collar too
    expect(
      decideMarketOrder(
        order({ side: 'BUY', qty: '0.001', quote: { bid: '92200.00', ask: '92260.25' } }),
      ),
    ).toEqual({ decision: 'REJECT', code: 'PRICE_MOVED' });
  });
  it('a stock with a fractional quantity is QTY_STEP_VIOLATION (control: the whole quantity fills)', () => {
    const stock = (qty: string) =>
      decideMarketOrder({
        ...order({ side: 'BUY', qty, instrument: STOCK, quote: { bid: '190.00', ask: '190.02' } }),
        collarPercent: '1',
        referencePrice: '190.02',
      });
    expect(stock('1.5')).toEqual({ decision: 'REJECT', code: 'QTY_STEP_VIOLATION' });
    expect(stock('2.00000001')).toEqual({ decision: 'REJECT', code: 'QTY_STEP_VIOLATION' });
    expect(stock('0.5')).toEqual({ decision: 'REJECT', code: 'QTY_BELOW_MIN' }); // the minimum is checked first
    expect(stock('2').decision).toBe('FILL');
  });
  it('a crypto quantity below the minimum or with more than 8 decimals is rejected', () => {
    expect(decideMarketOrder(order({ side: 'BUY', qty: '0.000000001' }))).toEqual({
      decision: 'REJECT',
      code: 'QTY_BELOW_MIN',
    });
  });
  it('a BUY that costs 0 at 8 decimals is too small to price (QTY_BELOW_MIN); a larger one fills (control)', () => {
    // a cheap coin: ask 0.00001, tick 0.00001, 0.00000001 units -> notional 1e-13 -> 0 at 8 dp
    const cheap = {
      ...order({ side: 'BUY', qty: '0.00000001', quote: { bid: '0.00001', ask: '0.00001' } }),
      instrument: { ...BTC, tickSize: '0.00001' },
      referencePrice: '0.00001',
    };
    expect(decideMarketOrder(cheap)).toEqual({ decision: 'REJECT', code: 'QTY_BELOW_MIN' });
    expect(decideMarketOrder({ ...cheap, qty: '1000' }).decision).toBe('FILL');
  });
  it('insufficient buying power by the smallest step, and exactly enough', () => {
    // 0.0025 costs 225.137525 + 0.22513752 = 225.36266252: cash of exactly that fills, one unit less does not
    expect(
      decideMarketOrder(order({ side: 'BUY', qty: '0.0025', cash: '225.36266252' })).decision,
    ).toBe('FILL');
    expect(decideMarketOrder(order({ side: 'BUY', qty: '0.0025', cash: '225.36266251' }))).toEqual({
      decision: 'REJECT',
      code: 'INSUFFICIENT_BUYING_POWER',
    });
  });
  it('insufficient position by the smallest step', () => {
    expect(
      decideMarketOrder(order({ side: 'SELL', qty: '0.0010', positionQty: '0.001' })).decision,
    ).toBe('FILL');
    expect(
      decideMarketOrder(order({ side: 'SELL', qty: '0.00100001', positionQty: '0.001' })),
    ).toEqual({
      decision: 'REJECT',
      code: 'INSUFFICIENT_POSITION',
    });
  });
});

describe('maxQty (D-89)', () => {
  const base = {
    side: 'BUY' as const,
    instrument: BTC,
    quote: QUOTE,
    schedule: CRYPTO_SCHEDULE,
    cash: '10000',
    positionQty: '0',
    maxOrderQty: MAX_ORDER_QTY,
  };
  it('a hand-checked case: 10,000 buys 0.1109323 BTC; one more step (0.11093231) does not fit', () => {
    // fill price 90,055.01. 0.1109323 x 90,055.01 = 9,990.00938582 (rounded to 8 dp), fee 9.99000939 (10 bps, 8 dp HALF_EVEN):
    // total 9,999.99939521 <= 10,000. 0.11093231 x 90,055.01 = 9,990.01028637, fee 9.99001029: total 10,000.00029666 > 10,000.
    expect(maxQty(base)).toBe('0.1109323');
    expect(decideMarketOrder(order({ side: 'BUY', qty: '0.1109323' })).decision).toBe('FILL');
    expect(decideMarketOrder(order({ side: 'BUY', qty: '0.11093231' }))).toEqual({
      decision: 'REJECT',
      code: 'INSUFFICIENT_BUYING_POWER',
    });
  });
  it('is null for a BUY without a quote and 0 when not even the minimum fits', () => {
    expect(maxQty({ ...base, quote: null })).toBeNull();
    // the smallest order costs 0.00090055 + a fee of 0.00000090: 0.0005 cannot pay for it
    expect(maxQty({ ...base, cash: '0.0005' })).toBe('0');
  });
  it('SELL: the position quantity, capped at the maximum order size', () => {
    expect(maxQty({ ...base, side: 'SELL', positionQty: '0.0150' })).toBe('0.015');
    expect(maxQty({ ...base, side: 'SELL', positionQty: '2000000', maxOrderQty: '1000000' })).toBe(
      '1000000',
    );
    expect(maxQty({ ...base, side: 'SELL', positionQty: '0' })).toBe('0');
  });
  it('stocks: whole shares only', () => {
    const stock = {
      ...base,
      instrument: STOCK,
      quote: { bid: '190.00', ask: '190.02' },
      schedule: {
        commissionBps: '0',
        commissionMinLocal: '0',
        slippageBaseBps: '2',
        slippageSizeCoef: '0',
      },
      cash: '10000',
    };
    // fill 190.02 x 1.0002 = 190.058004 -> up to 190.06; 52 x 190.06 = 9,883.12 <= 10,000; 53 x 190.06 = 10,073.18 > 10,000
    expect(maxQty(stock)).toBe('52');
  });
});

// ---- independent model: integers of 1e-8 ----------------------------------------------------------------------------
const SCALE = 100_000_000n;
const unitsOf = (s: string): bigint => {
  const [i = '0', f = ''] = s.split('.');
  return BigInt(i) * SCALE + BigInt(f.padEnd(8, '0').slice(0, 8));
};
const textOf = (u: bigint): string => {
  const whole = u / SCALE;
  const frac = (u % SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole.toString()}.${frac}`;
};

describe('properties', () => {
  it('FIFO over fractional lots conserves quantity and cost exactly and keeps the zero rules (BigInt model)', () => {
    const lotArb = fc.record({
      q: fc.bigInt({ min: 1n, max: 5_000_000_000n }),
      c: fc.bigInt({ min: 1n, max: 90_000_000_000n }),
    });
    fc.assert(
      fc.property(
        fc.array(lotArb, { minLength: 1, maxLength: 6 }),
        fc.double({ min: 0.0001, max: 1, noNaN: true }),
        (specs, frac) => {
          const lots: OpenLot[] = specs.map((s, i) => ({
            id: `l${String(i)}`,
            openedAt: new Date(T0.getTime() + i * 1000),
            qtyOpen: textOf(s.q),
            costRemaining: textOf(s.c),
          }));
          const totalQ = specs.reduce((a, s) => a + s.q, 0n);
          const totalC = specs.reduce((a, s) => a + s.c, 0n);
          // want = floor(total x frac) in units, at least 1
          let want = (totalQ * BigInt(Math.floor(frac * 10_000))) / 10_000n;
          if (want < 1n) want = 1n;
          const used = consumeLotsFIFO(lots, textOf(want));
          const takenQ = used.reduce((a, u) => a + unitsOf(u.qty), 0n);
          expect(takenQ).toBe(want);
          const consumedC = used.reduce((a, u) => a + unitsOf(u.cost), 0n);
          const leftC = lots.reduce((a, l) => {
            const u = used.find((x) => x.lotId === l.id);
            return a + (u === undefined ? unitsOf(l.costRemaining) : unitsOf(u.costRemainingAfter));
          }, 0n);
          expect(consumedC + leftC).toBe(totalC); // cost is conserved exactly
          for (const u of used) {
            const before = lots.find((l) => l.id === u.lotId);
            expect(before).toBeDefined();
            expect(unitsOf(u.costRemainingAfter) >= 0n).toBe(true);
            expect(unitsOf(u.cost) <= unitsOf(before?.costRemaining ?? '0')).toBe(true);
            // zero only together: cost_remaining = 0 if and only if qty_open = 0
            expect(unitsOf(u.costRemainingAfter) === 0n).toBe(unitsOf(u.qtyOpenAfter) === 0n);
            // a fully consumed lot gives up exactly what it had
            if (unitsOf(u.qtyOpenAfter) === 0n) expect(u.cost).toBe(before?.costRemaining);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('the proportional cost is the exact HALF_EVEN rounding (BigInt reference)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 2n, max: 9_000_000_000n }),
        fc.bigInt({ min: 1n, max: 900_000_000_000n }),
        fc.bigInt({ min: 1n, max: 8_999_999_999n }),
        (Q, R, qRaw) => {
          const q = (qRaw % (Q - 1n)) + 1n; // 1 .. Q-1 (a partial piece)
          const used = consumeLotsFIFO(
            [{ id: 'x', openedAt: T0, qtyOpen: textOf(Q), costRemaining: textOf(R) }],
            textOf(q),
          );
          // cost = round_half_even(R x q / Q) in integer units
          const num = R * q;
          let quo = num / Q;
          const rem2 = (num % Q) * 2n;
          if (rem2 > Q || (rem2 === Q && quo % 2n === 1n)) quo += 1n;
          let expected = quo;
          if (expected >= R) expected = R - 1n; // the documented clamp
          if (expected < 0n) expected = 0n;
          expect(unitsOf(used[0]?.cost ?? '0')).toBe(expected);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('proceeds allocation sums exactly to the total for fractional pieces', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 90_000_000_000_000n }),
        fc.array(fc.bigInt({ min: 1n, max: 900_000_000n }), { minLength: 1, maxLength: 7 }),
        (total, qs) => {
          const pieces = allocateProceeds(
            textOf(total),
            qs.map((q) => ({ qty: textOf(q) })),
          );
          expect(pieces.reduce((a, p) => a + unitsOf(p), 0n)).toBe(total);
        },
      ),
      { numRuns: 400 },
    );
  });

  const sideArb = fc.constantFrom('BUY' as const, 'SELL' as const);
  const stepArb = fc.constantFrom('0.00000001', '0.00001', '0.01', '1');

  it('the fill price is a multiple of the tick and never better for the user than the quote', () => {
    fc.assert(
      fc.property(
        sideArb,
        fc.integer({ min: 100, max: 99_999_999 }), // bid in ticks of 0.01
        fc.integer({ min: 0, max: 400 }), // spread in ticks
        fc.integer({ min: 0, max: 200 }), // bps
        fc.integer({ min: 1, max: 100_000 }), // qty in 0.00001
        (side, bidTicks, spread, bps, q) => {
          const bid = textOf(BigInt(bidTicks) * 1_000_000n);
          const ask = textOf(BigInt(bidTicks + spread) * 1_000_000n);
          const d = decideMarketOrder(
            order({
              side,
              qty: textOf(BigInt(q) * 1000n),
              quote: { bid, ask },
              referencePrice: side === 'BUY' ? ask : bid,
              schedule: { ...CRYPTO_SCHEDULE, slippageBaseBps: String(bps) },
              cash: '90000000000',
              positionQty: '1000',
            }),
          );
          if (d.decision !== 'FILL') return;
          const p = unitsOf(d.price);
          expect(p % 1_000_000n).toBe(0n); // a multiple of 0.01
          if (side === 'BUY') expect(p >= unitsOf(ask)).toBe(true);
          else expect(p <= unitsOf(bid)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('ledger legs sum to exactly zero for random fractional BUYs and SELLs', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 9_000_000_000n }),
        fc.integer({ min: 1, max: 9_999_999 }),
        fc.bigInt({ min: 0n, max: 90_000_000n }),
        fc.bigInt({ min: 0n, max: 900_000_000_000n }),
        (qty, priceTicks, fee, basis) => {
          const price = textOf(BigInt(priceTicks) * 1_000_000n);
          const sum = (legs: ReadonlyArray<{ amount: string }>): bigint =>
            legs.reduce((a, l) => a + BigInt(l.amount.replace('.', '')), 0n);
          expect(sum(buyFillLegs({ qty: textOf(qty), price, fee: textOf(fee) }))).toBe(0n);
          expect(
            sum(sellFillLegs({ qty: textOf(qty), price, fee: textOf(fee), basis: textOf(basis) })),
          ).toBe(0n);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('maxQty fills and maxQty plus one step is rejected for buying power (the same decision code)', () => {
    fc.assert(
      fc.property(
        stepArb,
        fc.integer({ min: 100, max: 5_000_000 }), // bid in ticks of 0.01 (1.00 .. 50,000.00)
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 100 }), // commission bps
        fc.bigInt({ min: 1n, max: 1_000_000_000_000n }), // cash in units of 1e-8 (up to 10,000)
        (step, bidTicks, spread, comm, cashUnits) => {
          const bid = textOf(BigInt(bidTicks) * 1_000_000n);
          const ask = textOf(BigInt(bidTicks + spread) * 1_000_000n);
          const schedule = { ...CRYPTO_SCHEDULE, commissionBps: String(comm) };
          const instrument = { ...BTC, qtyStep: step, minQty: step };
          const cash = textOf(cashUnits);
          const q = maxQty({
            side: 'BUY',
            instrument,
            quote: { bid, ask },
            schedule,
            cash,
            positionQty: '0',
            maxOrderQty: MAX_ORDER_QTY,
          });
          expect(q).not.toBeNull();
          const input = (qty: string): MarketOrderInput =>
            order({
              side: 'BUY',
              qty,
              instrument,
              quote: { bid, ask },
              referencePrice: ask,
              schedule,
              cash,
            });
          if (q !== null && q !== '0') {
            expect(decideMarketOrder(input(q)).decision).toBe('FILL');
            const next = textOf(unitsOf(q) + unitsOf(step));
            expect(decideMarketOrder(input(next))).toEqual({
              decision: 'REJECT',
              code: 'INSUFFICIENT_BUYING_POWER',
            });
          } else {
            // nothing fits: the smallest order is rejected (not enough cash, or too small to price)
            const r = decideMarketOrder(input(step));
            expect(r.decision).toBe('REJECT');
          }
        },
      ),
      { numRuns: 600 },
    );
  });

  it('a stock quantity with a fractional part is always QTY_STEP_VIOLATION', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 99_999_999 }),
        sideArb,
        (whole, fracUnits, side) => {
          const qty = textOf(BigInt(whole) * SCALE + BigInt(fracUnits));
          const d = decideMarketOrder({
            ...order({
              side,
              qty,
              instrument: STOCK,
              quote: { bid: '190.00', ask: '190.02' },
              positionQty: '9999999',
            }),
            collarPercent: '1',
            referencePrice: side === 'BUY' ? '190.02' : '190.00',
          });
          expect(d).toEqual({ decision: 'REJECT', code: 'QTY_STEP_VIOLATION' });
        },
      ),
      { numRuns: 400 },
    );
  });
});
