// M8b-1 (D-91..D-97): LIMIT orders in the pure engine. Every golden below is a HARD-CODED STRING, hand-verified in the comment
// next to it; none is computed by the code under test. Properties compare the engine with an INDEPENDENT BigInt model
// (integers of 1e-8) written in this file.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buyFillFromReserveLegs,
  commission,
  consumeLotsFIFO,
  decideLimitOrder,
  evaluateOpenOrders,
  expiresAt,
  fillResolution,
  isLimitMarketable,
  limitFillPricing,
  limitMaxQty,
  priceFromSlipped,
  priceOrder,
  releaseLegs,
  reserveForLimitBuy,
  reserveLegs,
  sellFillLegs,
} from './index.js';
import type { LimitOrderInput, OpenLimitOrder } from './index.js';

const T0 = new Date('2026-11-10T15:00:00Z');
const BTC = {
  status: 'ACTIVE',
  tradableIn: ['MVP'],
  tickSize: '0.01',
  minQty: '0.00000001',
  qtyStep: '0.00000001',
} as const;
// BTC-USD: slippage 5 bps, commission 10 bps, tick 0.01, grant 10,000; no collar for limits (D-92)
const SCHED = {
  commissionBps: '10',
  commissionMinLocal: '0',
  slippageBaseBps: '5',
  slippageSizeCoef: '0',
};
const lines = (legs: ReadonlyArray<{ ledgerAccountType: string; amount: string }>): string[] =>
  legs.map((l) => `${l.ledgerAccountType} ${l.amount}`);

function limitOrder(over: Partial<LimitOrderInput> = {}): LimitOrderInput {
  return {
    side: 'BUY',
    qty: '0.0025',
    limitPrice: '89900.00',
    instrument: BTC,
    quote: { bid: '89990.00', ask: '90010.00' },
    freshness: 'REAL_TIME',
    allowExecutionOnDelayed: true,
    schedule: SCHED,
    account: { active: true, tradingEnabled: true },
    freeCash: '10000',
    freeQty: '0',
    ...over,
  };
}

describe('golden vector E: a resting BUY, then a fill below the limit', () => {
  it('accept: not marketable, R = 224.97475, CASH -224.97475 and RESERVED +224.97475', () => {
    // 90,010.00 > 89,900.00 so the order is not marketable and rests.
    // R: 0.0025 x 89,900.00 = 224.75; fee on that 224.75 x 10 / 10,000 = 0.22475; R = 224.75 + 0.22475 = 224.97475
    expect(reserveForLimitBuy('0.0025', '89900.00', SCHED)).toEqual({
      maxNotional: '224.75',
      maxFee: '0.22475',
      reserve: '224.97475',
    });
    expect(isLimitMarketable('BUY', '89900.00', { bid: '89990.00', ask: '90010.00' })).toBe(false);
    expect(decideLimitOrder(limitOrder())).toEqual({
      decision: 'ACCEPT',
      reserveUsd: '224.97475',
      reserveQty: '0',
      fill: null,
    });
    expect(lines(reserveLegs({ amount: '224.97475' }))).toEqual([
      'CASH -224.97475000',
      'RESERVED 224.97475000',
    ]);
    // cash after the reserve: 10,000 - 224.97475 = 9,775.02525
  });

  it('later quote 89,830.00 / 89,850.00: marketable, fills at 89,894.93 (below the limit), exact legs', () => {
    const q = { bid: '89830.00', ask: '89850.00' };
    expect(isLimitMarketable('BUY', '89900.00', q)).toBe(true);
    // slipped ask: 89,850.00 x 1.0005 = 89,894.925 -> rounded UP to the 0.01 tick = 89,894.93 < the limit 89,900.00
    // C = 0.0025 x 89,894.93 = 224.737325 (89,894.93 / 400); fee = 224.737325 x 0.001 = 0.224737325: an exact tie at 8 dp,
    // the 8th digit 2 is even -> 0.22473732
    expect(limitFillPricing('BUY', '0.0025', '89900.00', q, SCHED, '0.01')).toEqual({
      price: '89894.93',
      notional: '224.737325',
      fee: '0.22473732',
      slippageBps: '5',
    });
    // R - C - f = 224.97475 - 224.737325 - 0.22473732 = 0.01268768 returns to CASH
    expect(fillResolution('224.97475', '224.737325', '0.22473732')).toEqual({
      ok: true,
      cashBack: '0.01268768',
    });
    const legs = buyFillFromReserveLegs({
      qty: '0.0025',
      price: '89894.93',
      fee: '0.22473732',
      reserved: '224.97475',
    });
    expect(lines(legs)).toEqual([
      'RESERVED -224.97475000',
      'POSITION_COST 224.73732500',
      'FEES 0.22473732',
      'CASH 0.01268768',
    ]);
    // the four legs sum to 0: -224.97475 + 224.737325 + 0.22473732 + 0.01268768 = 0
    // cash after = 9,775.02525 + 0.01268768 = 9,775.03793768 (= 10,000 - 224.96206232), RESERVED 0, lot cost 224.737325
  });
});

describe('golden vector F: the limit caps the slippage', () => {
  it('marketable at accept (89,899.00 <= 89,900.00): fills at the LIMIT 89,900.00, C + f = R exactly, CASH +0', () => {
    const q = { bid: '89880.00', ask: '89899.00' };
    // without the cap: 89,899.00 x 1.0005 = 89,943.9495 -> up to the tick = 89,943.95, worse than the limit
    expect(priceOrder('BUY', '0.0025', q, SCHED, '0.01').price).toBe('89943.95');
    // with the cap the fill price is min(89,900.00, 89,943.95) = 89,900.00: C = 0.0025 x 89,900.00 = 224.75, fee 0.22475
    const d = decideLimitOrder(limitOrder({ quote: q }));
    expect(d).toEqual({
      decision: 'ACCEPT',
      reserveUsd: '224.97475',
      reserveQty: '0',
      fill: { price: '89900', notional: '224.75', fee: '0.22475', slippageBps: '5' },
    });
    // R = 224.97475 = C + f = 224.75 + 0.22475 exactly, so CASH +0 (that leg is omitted) and cash after = 9,775.02525
    expect(fillResolution('224.97475', '224.75', '0.22475')).toEqual({ ok: true, cashBack: '0' });
    expect(
      lines(
        buyFillFromReserveLegs({
          qty: '0.0025',
          price: '89900',
          fee: '0.22475',
          reserved: '224.97475',
        }),
      ),
    ).toEqual(['RESERVED -224.97475000', 'POSITION_COST 224.75000000', 'FEES 0.22475000']);
  });
});

describe('golden vector G: a resting SELL, then a fill above the limit', () => {
  const lot = { id: 'a', openedAt: T0, qtyOpen: '0.0015', costRemaining: '135.082515' };
  it('accept: not marketable (89,990.00 < 90,100.00), reserves 0.001 of the 0.0015 held, no cash moves', () => {
    const d = decideLimitOrder(
      limitOrder({ side: 'SELL', qty: '0.001', limitPrice: '90100.00', freeQty: '0.0015' }),
    );
    expect(d).toEqual({ decision: 'ACCEPT', reserveUsd: '0', reserveQty: '0.001', fill: null });
    // free quantity after: 0.0015 - 0.001 = 0.0005
  });
  it('later bid 90,120.00: fills at the limit 90,100.00; proceeds 90.1, fee 0.0901, cost 90.05501, realised +0.04499', () => {
    const q = { bid: '90120.00', ask: '90140.00' };
    // slipped bid: 90,120.00 x 0.9995 = 90,074.94 (exact) -> down to the tick 90,074.94 < the limit, so the fill is the limit
    expect(priceOrder('SELL', '0.001', q, SCHED, '0.01').price).toBe('90074.94');
    // P = 0.001 x 90,100.00 = 90.1; fee = 90.1 x 0.001 = 0.0901
    expect(limitFillPricing('SELL', '0.001', '90100.00', q, SCHED, '0.01')).toEqual({
      price: '90100',
      notional: '90.1',
      fee: '0.0901',
      slippageBps: '5',
    });
    // consumed cost = round8(135.082515 x 0.001 / 0.0015) = 90.05501 (135.082515 x 2/3 = 90.05501 exactly)
    const used = consumeLotsFIFO([lot], '0.001');
    expect(used).toEqual([
      {
        lotId: 'a',
        qty: '0.001',
        cost: '90.05501',
        qtyOpenAfter: '0.0005',
        costRemainingAfter: '45.027505',
      },
    ]);
    // realised = 90.1 - 90.05501 = 0.04499. Legs: CASH +(90.1 - 0.0901) = +90.0099, FEES +0.0901, POSITION_COST -90.05501,
    // REALIZED_PNL -(90.1 - 90.05501) = -0.04499; sum: 90.0099 + 0.0901 - 90.05501 - 0.04499 = 0
    expect(
      lines(sellFillLegs({ qty: '0.001', price: '90100', fee: '0.0901', basis: '90.05501' })),
    ).toEqual([
      'CASH 90.00990000',
      'FEES 0.09010000',
      'POSITION_COST -90.05501000',
      'REALIZED_PNL -0.04499000',
    ]);
    // the remaining lot: 0.0005 with cost_remaining 135.082515 - 90.05501 = 45.027505
  });
});

describe('golden vector H: cancel and expire release exactly what was reserved', () => {
  it('RESERVED -224.97475 and CASH +224.97475: cash is back to 10,000.00 (the STORED amount, never recomputed)', () => {
    expect(lines(releaseLegs({ amount: '224.97475' }))).toEqual([
      'RESERVED -224.97475000',
      'CASH 224.97475000',
    ]);
    // 9,775.02525 + 224.97475 = 10,000.00000
  });
});

describe('golden vector I: a quote that is not evaluable evaluates nothing, and there is no back-fill', () => {
  const order: OpenLimitOrder = {
    id: 'o1',
    createdAt: T0,
    side: 'BUY',
    qty: '0.0025',
    limitPrice: '89900.00',
    reservedUsd: '224.97475',
  };
  const crossing = { bid: '89830.00', ask: '89850.00' };
  it('a STALE, CLOSED or UNAVAILABLE quote that satisfies the limit fills nothing; a DELAYED one only when allowed', () => {
    for (const f of ['STALE', 'CLOSED', 'UNAVAILABLE'] as const) {
      expect(evaluateOpenOrders(crossing, f, true, [order], SCHED, '0.01')).toEqual({
        fills: [],
        refused: [],
      });
    }
    expect(evaluateOpenOrders(crossing, 'DELAYED', false, [order], SCHED, '0.01').fills).toEqual(
      [],
    );
    expect(evaluateOpenOrders(null, 'REAL_TIME', true, [order], SCHED, '0.01').fills).toEqual([]);
  });
  it('when a FRESH quote satisfies it, the order fills at THAT quote (89,894.93), not at the earlier one', () => {
    const fresh = evaluateOpenOrders(crossing, 'REAL_TIME', true, [order], SCHED, '0.01');
    expect(fresh.fills).toEqual([
      {
        orderId: 'o1',
        pricing: { price: '89894.93', notional: '224.737325', fee: '0.22473732', slippageBps: '5' },
      },
    ]);
    // a different, later fresh quote gives a different price: only the quote passed in is ever looked at
    const later = evaluateOpenOrders(
      { bid: '89700.00', ask: '89710.00' },
      'REAL_TIME',
      true,
      [order],
      SCHED,
      '0.01',
    );
    // 89,710.00 x 1.0005 = 89,754.855 -> up to the tick 89,754.86, which is below the limit 89,900.00: that is the fill price
    expect(later.fills[0]?.pricing.price).toBe('89754.86');
  });
});

describe('rejects at accept (rule order) and their controls', () => {
  it('TICK_VIOLATION: 89,900.005 is not a multiple of 0.01 (control: 89,900.01 is accepted)', () => {
    expect(decideLimitOrder(limitOrder({ limitPrice: '89900.005' }))).toEqual({
      decision: 'REJECT',
      code: 'TICK_VIOLATION',
    });
    expect(decideLimitOrder(limitOrder({ limitPrice: '89900.01' })).decision).toBe('ACCEPT');
  });
  it('insufficient buying power by one smallest unit of money: 224.97474999 rejects, 224.97475 accepts', () => {
    expect(decideLimitOrder(limitOrder({ freeCash: '224.97474999' }))).toEqual({
      decision: 'REJECT',
      code: 'INSUFFICIENT_BUYING_POWER',
    });
    expect(decideLimitOrder(limitOrder({ freeCash: '224.97475' })).decision).toBe('ACCEPT');
  });
  it('insufficient FREE quantity by one step (free = held - reserved): 0.00099999 rejects, 0.001 accepts', () => {
    const sell = { side: 'SELL' as const, qty: '0.001', limitPrice: '90100.00' };
    expect(decideLimitOrder(limitOrder({ ...sell, freeQty: '0.00099999' }))).toEqual({
      decision: 'REJECT',
      code: 'INSUFFICIENT_POSITION',
    });
    expect(decideLimitOrder(limitOrder({ ...sell, freeQty: '0.001' })).decision).toBe('ACCEPT');
  });
  it('earlier rules win: paused, inactive, not tradable, halted, below minimum, step', () => {
    expect(
      decideLimitOrder(limitOrder({ account: { active: true, tradingEnabled: false } })),
    ).toEqual({ decision: 'REJECT', code: 'TRADING_PAUSED' });
    expect(
      decideLimitOrder(limitOrder({ account: { active: false, tradingEnabled: true } })),
    ).toEqual({ decision: 'REJECT', code: 'ACCOUNT_NOT_ACTIVE' });
    expect(decideLimitOrder(limitOrder({ instrument: { ...BTC, tradableIn: [] } }))).toEqual({
      decision: 'REJECT',
      code: 'INSTRUMENT_NOT_TRADABLE',
    });
    expect(decideLimitOrder(limitOrder({ instrument: { ...BTC, status: 'HALTED' } }))).toEqual({
      decision: 'REJECT',
      code: 'INSTRUMENT_HALTED',
    });
    expect(decideLimitOrder(limitOrder({ qty: '0.000000001' }))).toEqual({
      decision: 'REJECT',
      code: 'QTY_BELOW_MIN',
    });
    expect(
      decideLimitOrder(
        limitOrder({ instrument: { ...BTC, qtyStep: '0.001', minQty: '0.001' }, qty: '0.0025' }),
      ),
    ).toEqual({ decision: 'REJECT', code: 'QTY_STEP_VIOLATION' });
  });
  it('a limit order on a STALE, CLOSED or UNAVAILABLE quote is ACCEPTED and rests (it is just not evaluated), even if it would cross', () => {
    for (const f of ['STALE', 'CLOSED', 'UNAVAILABLE'] as const) {
      const d = decideLimitOrder(
        limitOrder({ freshness: f, quote: { bid: '89830.00', ask: '89850.00' } }),
      );
      expect(d).toMatchObject({ decision: 'ACCEPT', fill: null, reserveUsd: '224.97475' });
    }
    expect(decideLimitOrder(limitOrder({ quote: null, freshness: 'UNAVAILABLE' }))).toMatchObject({
      decision: 'ACCEPT',
      fill: null,
    });
  });
  it('a BUY whose largest cost rounds to 0 at 8 decimals is too small (control: a larger one is accepted)', () => {
    const cheap = {
      instrument: { ...BTC, tickSize: '0.00001' },
      limitPrice: '0.00001',
      qty: '0.00000001',
    };
    expect(decideLimitOrder(limitOrder(cheap))).toEqual({
      decision: 'REJECT',
      code: 'QTY_BELOW_MIN',
    });
    expect(decideLimitOrder(limitOrder({ ...cheap, qty: '1000' })).decision).toBe('ACCEPT');
  });
});

describe('expiry (D-94)', () => {
  it('GTC is now + 90 days: 2026-11-10T15:00Z -> 2027-02-08T15:00Z (30 + 30 + 30 days)', () => {
    expect(
      expiresAt({
        tif: 'GTC',
        now: T0,
        gtcDays: 90,
        continuous: false,
        nextSessionClose: null,
      }).toISOString(),
    ).toBe('2027-02-08T15:00:00.000Z');
  });
  it('DAY for a stock is the next session close; for crypto the next 00:00 UTC (strictly after now)', () => {
    const close = new Date('2026-11-10T21:00:00Z');
    expect(
      expiresAt({ tif: 'DAY', now: T0, gtcDays: 90, continuous: false, nextSessionClose: close }),
    ).toEqual(close);
    expect(
      expiresAt({
        tif: 'DAY',
        now: T0,
        gtcDays: 90,
        continuous: true,
        nextSessionClose: close,
      }).toISOString(),
    ).toBe('2026-11-11T00:00:00.000Z');
    // exactly at midnight the next midnight is a day later (strictly after)
    expect(
      expiresAt({
        tif: 'DAY',
        now: new Date('2026-11-11T00:00:00Z'),
        gtcDays: 90,
        continuous: true,
        nextSessionClose: null,
      }).toISOString(),
    ).toBe('2026-11-12T00:00:00.000Z');
    // a stock with no known next close falls back to the crypto rule instead of guessing
    expect(
      expiresAt({
        tif: 'DAY',
        now: T0,
        gtcDays: 90,
        continuous: false,
        nextSessionClose: null,
      }).toISOString(),
    ).toBe('2026-11-11T00:00:00.000Z');
  });
});

// ---- independent model: integers of 1e-8 -----------------------------------------------------------------------------------
const U = 100_000_000n;
const text = (u: bigint): string => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const frac = (a % U).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${(a / U).toString()}${frac === '' ? '' : `.${frac}`}`;
};
const toU = (s: string): bigint => {
  const neg = s.startsWith('-');
  const [i = '0', fr = ''] = (neg ? s.slice(1) : s).split('.');
  const u = BigInt(i) * U + BigInt(fr.padEnd(8, '0').slice(0, 8));
  return neg ? -u : u;
};
function divEven(n: bigint, d: bigint): bigint {
  const q = n / d;
  const twice = (n % d) * 2n;
  return twice > d || (twice === d && q % 2n === 1n) ? q + 1n : q;
}
const ceilDiv = (n: bigint, d: bigint): bigint => (n + d - 1n) / d;

describe('properties', () => {
  it('priceFromSlipped gives exactly the result of priceOrder (one formula), with and without a limit', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.bigInt({ min: 1n, max: 500_000_000n }),
        fc.bigInt({ min: 100n, max: 9_000_000n }),
        fc.bigInt({ min: 0n, max: 300n }),
        fc.integer({ min: 0, max: 100 }),
        fc.option(fc.bigInt({ min: 100n, max: 9_000_000n }), { nil: undefined }),
        (buy, qtyU, bidT, spreadT, slip, limT) => {
          const q = { bid: text(bidT * 1_000_000n), ask: text((bidT + spreadT) * 1_000_000n) };
          const sched = { ...SCHED, slippageBaseBps: String(slip) };
          const side = buy ? 'BUY' : 'SELL';
          const limit = limT === undefined ? undefined : text(limT * 1_000_000n);
          const direct = priceOrder(side, text(qtyU), q, sched, '0.01', limit);
          const slipped = priceOrder(side, '1', q, sched, '0.01').price; // the slipped price (no limit)
          expect(priceFromSlipped(side, text(qtyU), slipped, sched, limit)).toEqual(direct);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('the commission never decreases with the notional (monotone), with and without a minimum fee', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000_000_000n }),
        fc.integer({ min: 0, max: 2000 }),
        fc.bigInt({ min: 0n, max: 100_000_000n }),
        (a, b, bps, minFee) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const sched = { commissionBps: String(bps), commissionMinLocal: text(minFee) };
          const f1 = commission(text(lo), sched);
          const f2 = commission(text(hi), sched);
          expect(toU(f1) >= 0n).toBe(true);
          expect(toU(f1) <= toU(f2)).toBe(true);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('reserve >= C + f at every fill, the price is never worse than the limit, and the engine equals the BigInt model', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.bigInt({ min: 1n, max: 500_000_000n }), // quantity units (up to 5 coins)
        fc.bigInt({ min: 100n, max: 9_000_000n }), // limit in ticks of 0.01
        fc.bigInt({ min: 100n, max: 9_000_000n }), // bid in ticks
        fc.bigInt({ min: 0n, max: 300n }), // spread ticks
        fc.integer({ min: 0, max: 100 }), // slippage bps
        fc.integer({ min: 0, max: 100 }), // commission bps
        (buy, qtyU, limT, bidT, spreadT, slip, comm) => {
          const limit = limT * 1_000_000n;
          const bid = bidT * 1_000_000n;
          const ask = (bidT + spreadT) * 1_000_000n;
          const sched = {
            commissionBps: String(comm),
            commissionMinLocal: '0',
            slippageBaseBps: String(slip),
            slippageSizeCoef: '0',
          };
          const q = { bid: text(bid), ask: text(ask) };
          const side = buy ? 'BUY' : 'SELL';
          const marketable = buy ? ask <= limit : bid >= limit;
          expect(isLimitMarketable(side, text(limit), q)).toBe(marketable);
          if (!marketable) return;
          const p = limitFillPricing(side, text(qtyU), text(limit), q, sched, '0.01');
          // independent model
          const slipped = buy
            ? ceilDiv(ask * (10_000n + BigInt(slip)), 10_000n * 1_000_000n) * 1_000_000n
            : ((bid * (10_000n - BigInt(slip))) / (10_000n * 1_000_000n)) * 1_000_000n;
          const priceU = buy
            ? slipped < limit
              ? slipped
              : limit
            : slipped > limit
              ? slipped
              : limit;
          const notional = divEven(qtyU * priceU, U);
          const fee = divEven(notional * BigInt(comm), 10_000n);
          expect(p).toEqual({
            price: text(priceU),
            notional: text(notional),
            fee: text(fee),
            slippageBps: String(slip),
          });
          if (buy) {
            expect(priceU <= limit).toBe(true); // never worse than the limit for the user
            const r = reserveForLimitBuy(text(qtyU), text(limit), sched);
            // the model's reserve: ceil8(qty x limit) + fee on it
            const maxNotional = ceilDiv(qtyU * limit, U);
            const maxFee = divEven(maxNotional * BigInt(comm), 10_000n);
            expect(r.reserve).toBe(text(maxNotional + maxFee));
            expect(notional + fee <= maxNotional + maxFee).toBe(true); // C + f <= R: a fill never overspends
            expect(fillResolution(r.reserve, p.notional, p.fee).ok).toBe(true);
            const legs = buyFillFromReserveLegs({
              qty: text(qtyU),
              price: p.price,
              fee: p.fee,
              reserved: r.reserve,
            });
            expect(legs.reduce((a, l) => a + BigInt(l.amount.replace('.', '')), 0n)).toBe(0n);
          } else {
            expect(priceU >= limit).toBe(true);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('limitMaxQty: the largest quantity fills (accepted) and one step more is rejected for buying power', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('0.00000001', '0.00001', '0.01'),
        fc.bigInt({ min: 1_000n, max: 5_000_000n }), // limit in ticks
        fc.integer({ min: 0, max: 100 }),
        fc.bigInt({ min: 1n, max: 1_000_000_000_000n }), // free cash units
        (step, limT, comm, cashU) => {
          const instrument = { ...BTC, qtyStep: step, minQty: step };
          const sched = {
            commissionBps: String(comm),
            commissionMinLocal: '0',
            slippageBaseBps: '5',
            slippageSizeCoef: '0',
          };
          const limitPrice = text(limT * 1_000_000n);
          const freeCash = text(cashU);
          const m = limitMaxQty({
            side: 'BUY',
            limitPrice,
            instrument,
            schedule: sched,
            freeCash,
            freeQty: '0',
            maxOrderQty: '1000000',
          });
          const decide = (qty: string) =>
            decideLimitOrder({
              ...limitOrder({ instrument, schedule: sched, limitPrice, freeCash }),
              qty,
              quote: null,
              freshness: 'UNAVAILABLE',
            });
          if (m !== '0') {
            expect(decide(m).decision).toBe('ACCEPT');
            const next = text(toU(m) + toU(step));
            expect(decide(next)).toEqual({ decision: 'REJECT', code: 'INSUFFICIENT_BUYING_POWER' });
          } else {
            expect(decide(step).decision).toBe('REJECT'); // not even the smallest order is accepted
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('evaluateOpenOrders: created_at then id order, at most one fill per order, only marketable ones', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 4 }),
            t: fc.integer({ min: 0, max: 5 }),
            buy: fc.boolean(),
            limT: fc.bigInt({ min: 8_990_000n, max: 9_010_000n }),
          }),
          { maxLength: 30 },
        ),
        (specs) => {
          const seen = new Set<string>();
          const orders: OpenLimitOrder[] = specs
            .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
            .map((s) => ({
              id: s.id,
              createdAt: new Date(T0.getTime() + s.t * 1000),
              side: s.buy ? 'BUY' : 'SELL',
              qty: '0.001',
              limitPrice: text(s.limT * 1_000_000n),
              reservedUsd: s.buy
                ? reserveForLimitBuy('0.001', text(s.limT * 1_000_000n), SCHED).reserve
                : '0',
            }));
          const q = { bid: '90000.00', ask: '90010.00' };
          const ev = evaluateOpenOrders(q, 'REAL_TIME', true, orders, SCHED, '0.01');
          expect(new Set(ev.fills.map((f) => f.orderId)).size).toBe(ev.fills.length);
          const key = (id: string) => orders.find((o) => o.id === id);
          for (let i = 1; i < ev.fills.length; i += 1) {
            const a = key(ev.fills[i - 1]?.orderId ?? '');
            const b = key(ev.fills[i]?.orderId ?? '');
            expect(a !== undefined && b !== undefined).toBe(true);
            if (a !== undefined && b !== undefined) {
              const t = a.createdAt.getTime() - b.createdAt.getTime();
              expect(t < 0 || (t === 0 && a.id < b.id)).toBe(true);
            }
          }
          for (const f of ev.fills) {
            const o = key(f.orderId);
            expect(o !== undefined && isLimitMarketable(o.side, o.limitPrice, q)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('evaluateOpenOrders over 5,000 open orders against one quote is fast (benchmark; generous bound asserted)', () => {
    const orders: OpenLimitOrder[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `o${String(i).padStart(5, '0')}`,
      createdAt: new Date(T0.getTime() + i),
      side: i % 2 === 0 ? 'BUY' : 'SELL',
      qty: '0.001',
      limitPrice: i % 2 === 0 ? '90100.00' : '89900.00', // all marketable on the quote below
      reservedUsd: i % 2 === 0 ? reserveForLimitBuy('0.001', '90100.00', SCHED).reserve : '0',
    }));
    const q = { bid: '90000.00', ask: '90010.00' };
    const t0 = performance.now();
    const ev = evaluateOpenOrders(q, 'REAL_TIME', true, orders, SCHED, '0.01');
    const cold = performance.now() - t0;
    const t1 = performance.now();
    evaluateOpenOrders(q, 'REAL_TIME', true, orders, SCHED, '0.01');
    const warm = performance.now() - t1;
    process.stdout.write(
      `M8B1_EVAL_BENCH 5000 open orders, ${String(ev.fills.length)} fills: cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms\n`,
    );
    expect(ev.fills).toHaveLength(5000);
    expect(cold).toBeLessThan(2000);
  });

  it('random sequences of accept, quote move, cancel, expire and fill keep every ledger invariant (BigInt accounting)', () => {
    type Op =
      | { k: 'accept'; buy: boolean; qtyU: bigint; limT: bigint }
      | { k: 'move'; bidT: bigint; spread: bigint }
      | { k: 'cancel'; i: number }
      | { k: 'expire'; i: number };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({
        k: fc.constant('accept' as const),
        buy: fc.boolean(),
        qtyU: fc.bigInt({ min: 1n, max: 30_000_000n }),
        limT: fc.bigInt({ min: 8_900_000n, max: 9_100_000n }),
      }),
      fc.record({
        k: fc.constant('move' as const),
        bidT: fc.bigInt({ min: 8_900_000n, max: 9_100_000n }),
        spread: fc.bigInt({ min: 0n, max: 100n }),
      }),
      fc.record({ k: fc.constant('cancel' as const), i: fc.nat({ max: 9 }) }),
      fc.record({ k: fc.constant('expire' as const), i: fc.nat({ max: 9 }) }),
    );
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), (ops) => {
        let cash = 10_000n * U;
        let reserved = 0n;
        let position = 50_000_000n; // the account holds 0.5 coin (cost basis ignored here: the lots are tested elsewhere)
        let qtyReserved = 0n;
        let bid = 9_000_000n * 1_000_000n;
        let ask = 9_001_000n * 1_000_000n;
        interface Open {
          buy: boolean;
          qtyU: bigint;
          limit: bigint;
          reserve: bigint;
        }
        const open: Open[] = [];
        const sumLegs = (legs: ReadonlyArray<{ amount: string }>): bigint =>
          legs.reduce((a, l) => a + BigInt(l.amount.replace('.', '')), 0n);
        const check = (): void => {
          expect(cash >= 0n && reserved >= 0n).toBe(true);
          expect(reserved).toBe(open.reduce((a, o) => a + o.reserve, 0n)); // I7
          expect(qtyReserved).toBe(open.filter((o) => !o.buy).reduce((a, o) => a + o.qtyU, 0n)); // I4
          expect(qtyReserved <= position).toBe(true);
        };
        const fillOne = (o: Open): void => {
          const quote = { bid: text(bid), ask: text(ask) };
          const p = limitFillPricing(
            o.buy ? 'BUY' : 'SELL',
            text(o.qtyU),
            text(o.limit),
            quote,
            SCHED,
            '0.01',
          );
          const u = toU;
          if (o.buy) {
            const legs = buyFillFromReserveLegs({
              qty: text(o.qtyU),
              price: p.price,
              fee: p.fee,
              reserved: text(o.reserve),
            });
            expect(sumLegs(legs)).toBe(0n);
            expect(u(p.price) <= o.limit).toBe(true);
            cash += o.reserve - u(p.notional) - u(p.fee); // CASH +(R - C - f)
            reserved -= o.reserve;
          } else {
            expect(u(p.price) >= o.limit).toBe(true);
            cash += u(p.notional) - u(p.fee);
            position -= o.qtyU;
            qtyReserved -= o.qtyU;
          }
        };
        for (const op of ops) {
          if (op.k === 'accept') {
            const limit = op.limT * 1_000_000n;
            const d = decideLimitOrder(
              limitOrder({
                side: op.buy ? 'BUY' : 'SELL',
                qty: text(op.qtyU),
                limitPrice: text(limit),
                freeCash: text(cash),
                freeQty: text(position - qtyReserved),
                quote: { bid: text(bid), ask: text(ask) },
              }),
            );
            if (d.decision === 'ACCEPT') {
              const reserveU = op.buy ? toU(d.reserveUsd) : 0n;
              if (op.buy) {
                expect(sumLegs(reserveLegs({ amount: d.reserveUsd }))).toBe(0n);
                cash -= reserveU;
                reserved += reserveU;
              } else {
                qtyReserved += op.qtyU;
              }
              const o: Open = { buy: op.buy, qtyU: op.qtyU, limit, reserve: reserveU };
              open.push(o);
              if (d.fill !== null) {
                fillOne(o); // D-97: filled in the same transaction
                open.pop();
              }
            }
          } else if (op.k === 'move') {
            bid = op.bidT * 1_000_000n;
            ask = (op.bidT + op.spread) * 1_000_000n;
            const ev = evaluateOpenOrders(
              { bid: text(bid), ask: text(ask) },
              'REAL_TIME',
              true,
              open.map((o, i) => ({
                id: String(i).padStart(3, '0'),
                createdAt: new Date(T0.getTime() + i),
                side: o.buy ? ('BUY' as const) : ('SELL' as const),
                qty: text(o.qtyU),
                limitPrice: text(o.limit),
                reservedUsd: text(o.reserve),
              })),
              SCHED,
              '0.01',
            );
            const filled = new Set<number>();
            for (const f of ev.fills) {
              const idx = Number(f.orderId);
              filled.add(idx);
              fillOne(open[idx] as Open);
            }
            for (let i = open.length - 1; i >= 0; i -= 1) if (filled.has(i)) open.splice(i, 1);
          } else {
            const i = op.i;
            const o = open[i];
            if (o !== undefined) {
              if (o.buy) {
                expect(sumLegs(releaseLegs({ amount: text(o.reserve) }))).toBe(0n);
                cash += o.reserve;
                reserved -= o.reserve;
              } else qtyReserved -= o.qtyU;
              open.splice(i, 1);
            }
          }
          check();
        }
      }),
      { numRuns: 1000 },
    );
  });
});
