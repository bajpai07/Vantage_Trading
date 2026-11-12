import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compare, div, isZero, mul, parse, add } from '@vantage/money';
import {
  EngineInputError,
  REJECT_RULE_ORDER,
  allocateProceeds,
  buyFillLegs,
  commission,
  consumeLotsFIFO,
  decideMarketOrder,
  fillPrice,
  sellFillLegs,
} from './index.js';
import type { MarketOrderInput, RejectCode } from './index.js';

// Every expected value below is a hard-coded string worked out by hand, never computed by the code under test.

const SCHEDULE_V1 = {
  commissionBps: '0',
  commissionMinLocal: '0',
  slippageBaseBps: '2',
  slippageSizeCoef: '0',
};

function input(over: Partial<MarketOrderInput> = {}): MarketOrderInput {
  return {
    side: 'BUY',
    qty: '10',
    instrument: {
      status: 'ACTIVE',
      tradableIn: ['MVP'],
      tickSize: '0.01',
      minQty: '1',
      qtyStep: '1',
    },
    quote: { bid: '189.95', ask: '190.00' },
    freshness: 'DELAYED',
    allowExecutionOnDelayed: true,
    schedule: SCHEDULE_V1,
    referencePrice: '190.00',
    account: { active: true, tradingEnabled: true },
    cash: '10000',
    positionQty: '0',
    ...over,
  };
}
const reject = (over: Partial<MarketOrderInput>): string => {
  const d = decideMarketOrder(input(over));
  return d.decision === 'REJECT' ? d.code : `FILL:${d.price}`;
};

describe('golden vectors (quote AAPL bid 189.95, ask 190.00, slippage 2 bps)', () => {
  it('BUY 10: price 190.038 rounds UP to 190.04, notional 1,900.40, fee 0', () => {
    // 190.00 x 1.0002 = 190.038 -> up to the 0.01 tick = 190.04; 10 x 190.04 = 1900.40
    expect(decideMarketOrder(input())).toEqual({
      decision: 'FILL',
      price: '190.04',
      notional: '1900.4',
      fee: '0',
      slippageBps: '2',
    });
    // ledger: CASH -1900.40, POSITION_COST +1900.40 (sum 0); cash after the 10,000 grant = 10000.00 - 1900.40 = 8099.60
    expect(
      buyFillLegs({ qty: '10', price: '190.04', fee: '0' }).map(
        (l) => `${l.ledgerAccountType} ${l.amount}`,
      ),
    ).toEqual(['CASH -1900.40000000', 'POSITION_COST 1900.40000000']);
  });

  it('SELL 10 at bid 195.00: 195.00 x 0.9998 = 194.961 rounds DOWN to 194.96, proceeds 1,949.60', () => {
    const d = decideMarketOrder(
      input({
        side: 'SELL',
        quote: { bid: '195.00', ask: '195.05' },
        referencePrice: '195.00',
        positionQty: '10',
      }),
    );
    expect(d).toEqual({
      decision: 'FILL',
      price: '194.96',
      notional: '1949.6',
      fee: '0',
      slippageBps: '2',
    });
    // basis 1900.40 (the lot bought above), realised 1949.60 - 1900.40 = +49.20, cash 8099.60 + 1949.60 = 10049.20
    const legs = sellFillLegs({ qty: '10', price: '194.96', fee: '0', basis: '1900.40' });
    expect(legs.map((l) => `${l.ledgerAccountType} ${l.amount}`)).toEqual([
      'CASH 1949.60000000',
      'POSITION_COST -1900.40000000',
      'REALIZED_PNL -49.20000000',
    ]);
    // sum: 1949.60 - 1900.40 - 49.20 = 0
  });

  it('BUY 10 with a 10 bps commission: fee 1.9004, CASH -1902.3004, FEES +1.9004', () => {
    const schedule = { ...SCHEDULE_V1, commissionBps: '10' };
    const d = decideMarketOrder(input({ schedule }));
    // 1900.40 x 10 / 10000 = 1.9004 exactly
    expect(d).toMatchObject({
      decision: 'FILL',
      price: '190.04',
      notional: '1900.4',
      fee: '1.9004',
    });
    expect(
      buyFillLegs({ qty: '10', price: '190.04', fee: '1.9004' }).map(
        (l) => `${l.ledgerAccountType} ${l.amount}`,
      ),
    ).toEqual(['CASH -1902.30040000', 'POSITION_COST 1900.40000000', 'FEES 1.90040000']);
    // cash after the grant: 10000.0000 - 1902.3004 = 8097.6996 (sum of legs: -1902.3004 + 1900.40 + 1.9004 = 0)
  });

  it('FIFO: buy 3 at ask 100.00, buy 2 at ask 101.00, sell 4 at bid 99.00', () => {
    // lot 1: 100.00 x 1.0002 = 100.02 (exact). lot 2: 101.00 x 1.0002 = 101.0202 -> UP to 101.03.
    expect(fillPrice('BUY', '99.98', '100.00', '2', '0.01')).toBe('100.02');
    expect(fillPrice('BUY', '100.98', '101.00', '2', '0.01')).toBe('101.03');
    // sell 4 at bid 99.00: 99.00 x 0.9998 = 98.9802 -> DOWN to 98.98; proceeds 4 x 98.98 = 395.92
    expect(fillPrice('SELL', '99.00', '99.05', '2', '0.01')).toBe('98.98');

    const lots = [
      {
        id: 'lot-2',
        openedAt: new Date('2026-11-10T15:01:00Z'),
        qtyOpen: '2',
        costPerUnit: '101.03',
      },
      {
        id: 'lot-1',
        openedAt: new Date('2026-11-10T15:00:00Z'),
        qtyOpen: '3',
        costPerUnit: '100.02',
      }, // given out of order
    ];
    const used = consumeLotsFIFO(lots, '4');
    // lot 1 fully (3 x 100.02 = 300.06) and 1 share of lot 2 (101.03): basis 401.09
    expect(used).toEqual([
      { lotId: 'lot-1', qty: '3', cost: '300.06', qtyOpenAfter: '0' },
      { lotId: 'lot-2', qty: '1', cost: '101.03', qtyOpenAfter: '1' },
    ]);
    // proceeds 395.92 split by quantity 3:1 -> 296.94 and 98.98 (the last by subtraction)
    expect(allocateProceeds('395.92', used)).toEqual(['296.94', '98.98']);
    // realised: (296.94 - 300.06) + (98.98 - 101.03) = -3.12 + -2.05 = -5.17 = 395.92 - 401.09
    const legs = sellFillLegs({ qty: '4', price: '98.98', fee: '0', basis: '401.09' });
    expect(legs.map((l) => `${l.ledgerAccountType} ${l.amount}`)).toEqual([
      'CASH 395.92000000',
      'POSITION_COST -401.09000000',
      'REALIZED_PNL 5.17000000',
    ]);
    // remaining: lot 2 has 1 share at 101.03, so the position average cost is 101.03
  });
});

describe('fillPrice and commission', () => {
  it('rounds a BUY up and a SELL down, and never rounds against the rule when already on the tick', () => {
    expect(fillPrice('BUY', '10.00', '10.00', '0', '0.01')).toBe('10');
    expect(fillPrice('BUY', '10.00', '10.00', '2', '0.01')).toBe('10.01'); // 10.002 -> up
    expect(fillPrice('SELL', '10.00', '10.00', '2', '0.01')).toBe('9.99'); // 9.998 -> down
    expect(fillPrice('BUY', '1.00', '1.00', '2', '0.05')).toBe('1.05'); // a 0.05 tick: 1.0002 -> up
    expect(fillPrice('SELL', '1.00', '1.00', '2', '0.05')).toBe('0.95'); // 0.9998 -> down
  });
  it('throws when the price would not be positive', () => {
    expect(() => fillPrice('SELL', '0.01', '0.02', '10000', '0.01')).toThrow();
  });
  it('commission is max(notional x bps / 10000, minimum) at 8 dp HALF_EVEN', () => {
    expect(commission('1900.40', { commissionBps: '10', commissionMinLocal: '0' })).toBe('1.9004');
    expect(commission('1900.40', { commissionBps: '0', commissionMinLocal: '0' })).toBe('0');
    expect(commission('100', { commissionBps: '10', commissionMinLocal: '1' })).toBe('1'); // the minimum wins
    expect(commission('333.33', { commissionBps: '1', commissionMinLocal: '0' })).toBe('0.033333'); // 0.033333
    expect(commission('0.15', { commissionBps: '1', commissionMinLocal: '0' })).toBe('0.000015');
  });
});

describe('rule order: the first failure wins', () => {
  it('lists the codes in the documented order', () => {
    expect([...REJECT_RULE_ORDER]).toEqual([
      'TRADING_PAUSED',
      'ACCOUNT_NOT_ACTIVE',
      'INSTRUMENT_NOT_TRADABLE',
      'INSTRUMENT_HALTED',
      'QTY_BELOW_MIN',
      'QTY_STEP_VIOLATION',
      'NO_ELIGIBLE_QUOTE',
      'MARKET_CLOSED',
      'STALE_QUOTE',
      'PRICE_MOVED',
      'INSUFFICIENT_BUYING_POWER',
      'INSUFFICIENT_POSITION',
      'FEE_EXCEEDS_PROCEEDS',
    ]);
  });

  const inst = (over: Partial<MarketOrderInput['instrument']>) => ({
    ...input().instrument,
    ...over,
  });
  const cases: Array<[RejectCode, Partial<MarketOrderInput>]> = [
    ['TRADING_PAUSED', { account: { active: true, tradingEnabled: false } }],
    ['ACCOUNT_NOT_ACTIVE', { account: { active: false, tradingEnabled: true } }],
    ['INSTRUMENT_NOT_TRADABLE', { instrument: inst({ tradableIn: [] }) }],
    ['INSTRUMENT_NOT_TRADABLE', { instrument: inst({ status: 'DELISTED' }) }],
    ['INSTRUMENT_NOT_TRADABLE', { instrument: inst({ status: 'SELL_ONLY' }) }], // a BUY on SELL_ONLY
    ['INSTRUMENT_HALTED', { instrument: inst({ status: 'HALTED' }) }],
    ['QTY_BELOW_MIN', { qty: '1', instrument: inst({ minQty: '5' }) }],
    ['QTY_STEP_VIOLATION', { qty: '2.5' }],
    ['QTY_STEP_VIOLATION', { qty: '15', instrument: inst({ qtyStep: '10' }) }],
    ['NO_ELIGIBLE_QUOTE', { freshness: 'UNAVAILABLE', quote: null }],
    ['NO_ELIGIBLE_QUOTE', { freshness: 'DELAYED', allowExecutionOnDelayed: false }],
    ['NO_ELIGIBLE_QUOTE', { freshness: 'REAL_TIME', quote: null }],
    ['MARKET_CLOSED', { freshness: 'CLOSED' }],
    ['STALE_QUOTE', { freshness: 'STALE' }],
    ['PRICE_MOVED', { referencePrice: '188.00' }], // ask 190.00 is more than 1% above 188.00
    ['INSUFFICIENT_BUYING_POWER', { cash: '1900.39' }],
    ['INSUFFICIENT_POSITION', { side: 'SELL', positionQty: '9', referencePrice: '189.95' }],
  ];
  it.each(cases)('%s', (code, over) => {
    expect(reject(over)).toBe(code);
  });

  // D-57. A schedule with a 5.00 minimum commission: a 1-share SELL at bid 2.00 (2.00 x 0.9998 = 1.9996, down
  // to the tick = 1.99) has proceeds 1.99 and pays a fee of 5.00, which is more than the proceeds.
  const MIN_FEE = { ...SCHEDULE_V1, commissionMinLocal: '5' };
  const tinySell = (over: Partial<MarketOrderInput> = {}): Partial<MarketOrderInput> => ({
    side: 'SELL',
    qty: '1',
    positionQty: '1',
    quote: { bid: '2.00', ask: '2.05' },
    referencePrice: '2.00',
    schedule: MIN_FEE,
    ...over,
  });
  it('FEE_EXCEEDS_PROCEEDS: fee 5.00 against proceeds 1.99 is rejected', () => {
    expect(reject(tinySell())).toBe('FEE_EXCEEDS_PROCEEDS');
  });
  it('FEE_EXCEEDS_PROCEEDS controls: fee equal to the proceeds fills, a larger SELL fills, a BUY is not affected', () => {
    // 1 share at bid 5.01: 5.01 x 0.9998 = 5.009 -> 5.00 down; proceeds 5.00 equal to the fee 5.00 (not greater)
    expect(reject(tinySell({ quote: { bid: '5.01', ask: '5.05' }, referencePrice: '5.01' }))).toBe(
      'FILL:5',
    );
    // 10 shares at 2.00: proceeds 19.90, fee 5.00
    expect(reject(tinySell({ qty: '10', positionQty: '10' }))).toBe('FILL:1.99');
    expect(reject(tinySell({ side: 'BUY', positionQty: '0', referencePrice: '2.05' }))).toBe(
      'FILL:2.06',
    );
  });
  it('FEE_EXCEEDS_PROCEEDS comes after INSUFFICIENT_POSITION', () => {
    expect(reject(tinySell({ positionQty: '0' }))).toBe('INSUFFICIENT_POSITION');
  });

  it('a SELL on a SELL_ONLY instrument is tradable (control)', () => {
    expect(
      reject({
        side: 'SELL',
        positionQty: '10',
        referencePrice: '189.95',
        instrument: inst({ status: 'SELL_ONLY' }),
      }),
    ).toMatch(/^FILL:/);
  });

  it('DELAYED is accepted when allowed and REAL_TIME is accepted (controls)', () => {
    expect(reject({ freshness: 'DELAYED', allowExecutionOnDelayed: true })).toMatch(/^FILL:/);
    expect(reject({ freshness: 'REAL_TIME', allowExecutionOnDelayed: false })).toMatch(/^FILL:/);
  });

  it('when several rules fail, the earliest one is reported', () => {
    const everythingWrong = input({
      account: { active: false, tradingEnabled: false },
      freshness: 'STALE',
      cash: '0',
      qty: '2.5',
      referencePrice: '1',
    });
    expect(decideMarketOrder(everythingWrong)).toEqual({
      decision: 'REJECT',
      code: 'TRADING_PAUSED',
    });
    expect(
      decideMarketOrder({ ...everythingWrong, account: { active: false, tradingEnabled: true } }),
    ).toEqual({
      decision: 'REJECT',
      code: 'ACCOUNT_NOT_ACTIVE',
    });
    expect(
      decideMarketOrder({ ...everythingWrong, account: { active: true, tradingEnabled: true } }),
    ).toEqual({ decision: 'REJECT', code: 'QTY_STEP_VIOLATION' });
    expect(
      decideMarketOrder({
        ...everythingWrong,
        account: { active: true, tradingEnabled: true },
        qty: '10',
      }),
    ).toEqual({ decision: 'REJECT', code: 'STALE_QUOTE' });
    expect(
      decideMarketOrder({
        ...everythingWrong,
        account: { active: true, tradingEnabled: true },
        qty: '10',
        freshness: 'DELAYED',
      }),
    ).toEqual({ decision: 'REJECT', code: 'PRICE_MOVED' });
    expect(
      decideMarketOrder({
        ...everythingWrong,
        account: { active: true, tradingEnabled: true },
        qty: '10',
        freshness: 'DELAYED',
        referencePrice: '190.00',
      }),
    ).toEqual({ decision: 'REJECT', code: 'INSUFFICIENT_BUYING_POWER' });
  });

  it('malformed quantities are input errors, not orders', () => {
    for (const qty of ['0', '-1', 'abc', ''])
      expect(() => decideMarketOrder(input({ qty }))).toThrow(EngineInputError);
  });
});

describe('price moved protection (D-51): only adverse moves beyond the collar reject', () => {
  it('BUY: ask up to ref x 1.01 is accepted, one tick above is rejected, a lower ask is accepted', () => {
    // reference 190.00: limit 191.90 (190 x 1.01)
    const buy = (ask: string) =>
      reject({ quote: { bid: '189.00', ask }, referencePrice: '190.00' });
    expect(buy('191.90')).toMatch(/^FILL:/);
    expect(buy('191.91')).toBe('PRICE_MOVED');
    expect(buy('150.00')).toMatch(/^FILL:/); // favourable
  });
  it('SELL: bid down to ref x 0.99 is accepted, one tick below is rejected, a higher bid is accepted', () => {
    // reference 200.00: floor 198.00 (200 x 0.99)
    const sell = (bid: string) =>
      reject({
        side: 'SELL',
        positionQty: '10',
        quote: { bid, ask: '300.00' },
        referencePrice: '200.00',
      });
    expect(sell('198.00')).toMatch(/^FILL:/);
    expect(sell('197.99')).toBe('PRICE_MOVED');
    expect(sell('250.00')).toMatch(/^FILL:/);
  });
});

describe('consumeLotsFIFO and allocateProceeds', () => {
  const lot = (id: string, t: string, qty: string, cost: string) => ({
    id,
    openedAt: new Date(t),
    qtyOpen: qty,
    costPerUnit: cost,
  });
  it('orders by (openedAt, id) and breaks a tie on the id', () => {
    const t = '2026-11-10T15:00:00Z';
    const used = consumeLotsFIFO([lot('b', t, '2', '10'), lot('a', t, '2', '20')], '3');
    expect(used.map((u) => `${u.lotId}:${u.qty}`)).toEqual(['a:2', 'b:1']);
  });
  it('skips empty lots and throws when the lots hold too little', () => {
    expect(
      consumeLotsFIFO(
        [lot('x', '2026-11-10T15:00:00Z', '0', '5'), lot('y', '2026-11-10T15:01:00Z', '2', '5')],
        '2',
      ),
    ).toHaveLength(1);
    expect(() => consumeLotsFIFO([lot('x', '2026-11-10T15:00:00Z', '2', '5')], '3')).toThrow(
      EngineInputError,
    );
    expect(() => consumeLotsFIFO([], '1')).toThrow(EngineInputError);
    expect(() => consumeLotsFIFO([lot('x', '2026-11-10T15:00:00Z', '2', '5')], '0')).toThrow(
      EngineInputError,
    );
  });
  it('allocateProceeds gives the last piece by subtraction (three pieces, an awkward total)', () => {
    // 100.00 over 1:1:1 -> 33.33333333, 33.33333333 and the rest 33.33333334 (hand check: 100 - 66.66666666)
    expect(allocateProceeds('100', [{ qty: '1' }, { qty: '1' }, { qty: '1' }])).toEqual([
      '33.33333333',
      '33.33333333',
      '33.33333334',
    ]);
  });
});

describe('properties', () => {
  const digits = (lo: number, hi: number) =>
    fc.stringMatching(new RegExp(`^[0-9]{${String(lo)},${String(hi)}}$`));
  // prices that are multiples of 0.01 between 1.00 and 9999.99, as strings of cents
  const cents = fc
    .tuple(digits(1, 4), fc.stringMatching(/^[0-9]{2}$/))
    .map(([i, f]) => `${i}.${f}`)
    .filter((s) => compare(parse(s), parse('1')) >= 0);
  const bps = fc.constantFrom('0', '2', '10', '25');
  const sideArb = fc.constantFrom<'BUY' | 'SELL'>('BUY', 'SELL');

  it('a fill price is a multiple of the tick and never better than the quote for the user', () => {
    fc.assert(
      fc.property(cents, cents, bps, sideArb, (a, b, s, side) => {
        const lo = compare(parse(a), parse(b)) <= 0 ? a : b;
        const hi = compare(parse(a), parse(b)) <= 0 ? b : a;
        const price = fillPrice(side, lo, hi, s, '0.01');
        const p = parse(price);
        expect(div(p, parse('0.01'), 0, 'HALF_EVEN').mul(parse('0.01')).equals(p)).toBe(true);
        if (side === 'BUY') expect(compare(p, parse(hi)) >= 0).toBe(true);
        else expect(compare(p, parse(lo)) <= 0).toBe(true);
        expect(compare(p, parse('0')) > 0).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('the ledger legs of any decided fill sum to zero per currency', () => {
    fc.assert(
      fc.property(cents, bps, bps, fc.integer({ min: 1, max: 500 }), (c, slip, comm, qtyN) => {
        const qty = String(qtyN);
        const d = decideMarketOrder(
          input({
            qty,
            quote: { bid: c, ask: add(parse(c), parse('0.02')).toString() },
            referencePrice: add(parse(c), parse('0.02')).toString(),
            schedule: { ...SCHEDULE_V1, slippageBaseBps: slip, commissionBps: comm },
            cash: '1000000000',
          }),
        );
        if (d.decision !== 'FILL') throw new Error('expected a fill');
        const legs = buyFillLegs({ qty, price: d.price, fee: d.fee });
        const sum = legs.reduce((acc, l) => add(acc, parse(l.amount)), parse('0'));
        expect(isZero(sum)).toBe(true);
        const sell = sellFillLegs({
          qty,
          price: d.price,
          fee: d.fee,
          basis: mul(parse(qty), parse(c)).toString(),
        });
        expect(isZero(sell.reduce((acc, l) => add(acc, parse(l.amount)), parse('0')))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('allocateProceeds pieces always sum exactly to the total', () => {
    const qtys = fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(cents, fc.integer({ min: 1, max: 99 }), qtys, (c, extra, qs) => {
        const total = add(parse(c), parse(`0.${String(extra).padStart(2, '0')}`)).toString();
        const pieces = allocateProceeds(
          total,
          qs.map((q) => ({ qty: String(q) })),
        );
        const sum = pieces.reduce((acc, p) => add(acc, parse(p)), parse('0'));
        expect(sum.equals(parse(total))).toBe(true);
        expect(pieces).toHaveLength(qs.length);
      }),
      { numRuns: 500 },
    );
  });

  it('FIFO conserves quantity and never takes more than a lot holds', () => {
    const lotsArb = fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(lotsArb, fc.integer({ min: 1, max: 100 }), (sizes, want) => {
        const total = sizes.reduce((a, b) => a + b, 0);
        const lots = sizes.map((q, i) => ({
          id: `l${String(i).padStart(2, '0')}`,
          openedAt: new Date(Date.UTC(2026, 10, 10, 15, i)),
          qtyOpen: String(q),
          costPerUnit: '10.00',
        }));
        if (want > total) {
          expect(() => consumeLotsFIFO(lots, String(want))).toThrow(EngineInputError);
          return;
        }
        const used = consumeLotsFIFO(lots, String(want));
        const taken = used.reduce((acc, u) => add(acc, parse(u.qty)), parse('0'));
        expect(taken.equals(parse(String(want)))).toBe(true);
        used.forEach((u, i) => {
          expect(
            compare(parse(u.qty), parse(lots.find((l) => l.id === u.lotId)?.qtyOpen ?? '0')) <= 0,
          ).toBe(true);
          // oldest first: every consumed lot but the last is fully consumed
          if (i < used.length - 1) expect(u.qtyOpenAfter).toBe('0');
        });
      }),
      { numRuns: 500 },
    );
  });
});
