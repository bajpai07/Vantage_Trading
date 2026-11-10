import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Dec } from '@vantage/money';
import { add, parse, isZero } from '@vantage/money';
import {
  EngineInputError,
  EngineInvariantError,
  UnsupportedCurrencyError,
  assertBalanced,
  buyFillLegs,
  grantLegs,
  sellFillLegs,
} from './index.js';
import type { Leg } from './index.js';

// Every expected value below is a hard-coded string, never computed by the code under test.
const usd = (ledgerAccountType: Leg['ledgerAccountType'], amount: string): Leg => ({
  ledgerAccountType,
  currency: 'USD',
  amount,
});

describe('golden vectors', () => {
  it('grant 10,000: CASH +10000, CAPITAL -10000 (sum 10000 - 10000 = 0)', () => {
    expect(grantLegs({ amount: '10000' })).toEqual([
      usd('CASH', '10000.00000000'),
      usd('CAPITAL', '-10000.00000000'),
    ]);
  });

  it('A: buy 10 at 190.04, fee 0 (sum -1900.40 + 1900.40 = 0); cash after grant 8,099.60', () => {
    // C = 10 x 190.04 = 1900.40; f = 0 so the FEES leg is omitted.
    expect(buyFillLegs({ qty: '10', price: '190.04', fee: '0' })).toEqual([
      usd('CASH', '-1900.40000000'),
      usd('POSITION_COST', '1900.40000000'),
    ]);
    // 10000.00 - 1900.40 = 8099.60 (hand check, asserted again on Postgres in the ledger tests)
  });

  it('B: buy 0.05 at 60,030.00, fee 3.0015 (sum -3004.5015 + 3001.50 + 3.0015 = 0)', () => {
    // C = 0.05 x 60030.00 = 3001.50; f = 3.0015; CASH = -(3001.50 + 3.0015) = -3004.5015
    expect(buyFillLegs({ qty: '0.05', price: '60030.00', fee: '3.0015' })).toEqual([
      usd('CASH', '-3004.50150000'),
      usd('POSITION_COST', '3001.50000000'),
      usd('FEES', '3.00150000'),
    ]);
  });

  it('sell, no fee: 10 at 195.00, basis 1,900.40 (sum 1950 - 1900.40 - 49.60 = 0)', () => {
    // P = 1950.00; CASH = P - 0; POSITION_COST = -1900.40; REALIZED_PNL = -(1950.00 - 1900.40) = -49.60
    expect(sellFillLegs({ qty: '10', price: '195.00', fee: '0', basis: '1900.40' })).toEqual([
      usd('CASH', '1950.00000000'),
      usd('POSITION_COST', '-1900.40000000'),
      usd('REALIZED_PNL', '-49.60000000'),
    ]);
  });

  it('sell with fee 1.95 (sum 1948.05 + 1.95 - 1900.40 - 49.60 = 0)', () => {
    expect(sellFillLegs({ qty: '10', price: '195.00', fee: '1.95', basis: '1900.40' })).toEqual([
      usd('CASH', '1948.05000000'),
      usd('FEES', '1.95000000'),
      usd('POSITION_COST', '-1900.40000000'),
      usd('REALIZED_PNL', '-49.60000000'),
    ]);
  });

  it('a losing sell books a positive REALIZED_PNL leg (sum 1500 - 1900.40 + 400.40 = 0)', () => {
    expect(sellFillLegs({ qty: '10', price: '150.00', fee: '0', basis: '1900.40' })).toEqual([
      usd('CASH', '1500.00000000'),
      usd('POSITION_COST', '-1900.40000000'),
      usd('REALIZED_PNL', '400.40000000'),
    ]);
  });
});

describe('rounding is done once per leg, the cash leg is derived', () => {
  it('rounds the cost at 8 dp HALF_EVEN, then derives cash by addition', () => {
    // qty x price = 0.000000015 -> C = 0.00000002 (tie rounds to even); f = 0.000000005 -> 0
    expect(buyFillLegs({ qty: '0.000000015', price: '1', fee: '0.000000005' })).toEqual([
      usd('CASH', '-0.00000002'),
      usd('POSITION_COST', '0.00000002'),
    ]);
  });
});

describe('input checks', () => {
  it('rejects non-USD input', () => {
    expect(() => grantLegs({ amount: '1', currency: 'INR' })).toThrow(UnsupportedCurrencyError);
    expect(() => buyFillLegs({ qty: '1', price: '1', fee: '0', currency: 'INR' })).toThrow(
      UnsupportedCurrencyError,
    );
    expect(() =>
      sellFillLegs({ qty: '1', price: '1', fee: '0', basis: '1', currency: 'EUR' }),
    ).toThrow(UnsupportedCurrencyError);
    expect(grantLegs({ amount: '1', currency: 'USD' })).toHaveLength(2); // control
  });

  it.each([
    ['zero grant', () => grantLegs({ amount: '0' })],
    ['negative grant', () => grantLegs({ amount: '-5' })],
    ['float-looking grant', () => grantLegs({ amount: '1e3' })],
    ['zero qty', () => buyFillLegs({ qty: '0', price: '1', fee: '0' })],
    ['negative price', () => buyFillLegs({ qty: '1', price: '-1', fee: '0' })],
    ['negative fee', () => buyFillLegs({ qty: '1', price: '1', fee: '-1' })],
    ['negative basis', () => sellFillLegs({ qty: '1', price: '1', fee: '0', basis: '-1' })],
    ['garbage qty', () => sellFillLegs({ qty: 'abc', price: '1', fee: '0', basis: '1' })],
  ])('rejects %s', (_name, fn) => {
    expect(fn).toThrow(EngineInputError);
  });

  it('assertBalanced throws on an unbalanced set and passes a balanced one (control)', () => {
    expect(() => assertBalanced([usd('CASH', '1.00000000')])).toThrow(EngineInvariantError);
    expect(() => assertBalanced([])).not.toThrow();
    expect(() =>
      assertBalanced([usd('CASH', '1.00000000'), usd('CAPITAL', '-1.00000000')]),
    ).not.toThrow();
  });
});

// Decimal strings with up to 8 decimal places, built from digit strings (no JS numbers).
const digits = (lo: number, hi: number) =>
  fc.stringMatching(new RegExp(`^[0-9]{${String(lo)},${String(hi)}}$`));
const positive = (maxInt: number) =>
  fc
    .tuple(digits(1, maxInt), digits(0, 8))
    .map(([i, f]) => `${i}${f === '' ? '' : `.${f}`}`)
    .filter((s) => !isZero(parse(s)));
const nonNegative = (maxInt: number) =>
  fc.tuple(digits(1, maxInt), digits(0, 8)).map(([i, f]) => `${i}${f === '' ? '' : `.${f}`}`);

function sumOf(legs: readonly Leg[]): Dec {
  return legs.reduce<Dec>((acc, l) => add(acc, parse(l.amount)), parse('0'));
}

describe('properties: legs always sum to exactly zero per currency', () => {
  it('buy', () => {
    fc.assert(
      fc.property(positive(10), positive(10), nonNegative(6), (qty, price, fee) => {
        const legs = buyFillLegs({ qty, price, fee });
        expect(isZero(sumOf(legs))).toBe(true);
        expect(legs.every((l) => l.currency === 'USD' && /\.\d{8}$/.test(l.amount))).toBe(true);
        expect(legs.every((l) => !isZero(parse(l.amount)))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
  it('sell', () => {
    fc.assert(
      fc.property(
        positive(10),
        positive(10),
        nonNegative(6),
        nonNegative(14),
        (qty, price, fee, basis) => {
          const legs = sellFillLegs({ qty, price, fee, basis });
          expect(isZero(sumOf(legs))).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
  it('grant', () => {
    fc.assert(
      fc.property(positive(15), (amount) => {
        const legs = grantLegs({ amount });
        expect(isZero(sumOf(legs))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
