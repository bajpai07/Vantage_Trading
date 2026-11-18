// M8 (D-86): decimal quantities in the ticket. Everything here is TEXT in, TEXT out: the helpers never convert to a number.
// The BigInt reference is used only by the tests, to prove the string comparison agrees with real arithmetic.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_ORDER_QTY } from '@vantage/contracts';
import { rejectMessage } from './reject-copy';
import {
  compareDecimalText,
  disabledReason,
  initialPreview,
  qtyComplete,
  qtyTooLarge,
  sanitizeQtyFor,
  stepDecimals,
  stepMessage,
} from './ticket';
import type { ReasonInput } from './ticket';

const BTC = { qtyStep: '0.00000001', minQty: '0.00000001' };
const DOGE = { qtyStep: '0.00001', minQty: '0.00001' };
const STOCK = { qtyStep: '1', minQty: '1' };

describe('stepDecimals', () => {
  it.each([
    ['1', 0],
    ['0.00001', 5],
    ['0.00000001', 8],
    ['0.5', 1],
    ['10', 0],
    ['0.000000001', 8], // never more than the contract's 8
  ])('step %s allows %i decimals', (step, n) => {
    expect(stepDecimals(step)).toBe(n);
  });
  it('an unknown step is treated as whole shares', () => {
    expect(stepDecimals(undefined)).toBe(0);
  });
});

describe('sanitizeQtyFor: digits and one dot, nothing else, no more decimals than the step allows', () => {
  it.each([
    ['0.0025', BTC.qtyStep, '0.0025'],
    ['.5', BTC.qtyStep, '0.5'],
    ['00.5', BTC.qtyStep, '0.5'],
    ['1.123456789', BTC.qtyStep, '1.12345678'], // the ninth decimal is dropped
    ['1.123456', DOGE.qtyStep, '1.12345'], // the step allows 5
    ['1e-3', BTC.qtyStep, '13'], // letters and signs are dropped (and the field refuses to type or paste them in the first place)
    ['-5', BTC.qtyStep, '5'],
    ['1,5', BTC.qtyStep, '15'],
    ['1.2.3', BTC.qtyStep, '1.23'], // a second dot is dropped
    ['12345678', BTC.qtyStep, '1234567'], // 7 integer digits at most
    ['1.', BTC.qtyStep, '1.'], // while typing
    ['abc', BTC.qtyStep, ''],
    ['', BTC.qtyStep, ''],
    ['0', BTC.qtyStep, ''],
    ['٣', BTC.qtyStep, ''], // non-ASCII digits are not digits
    // a whole-share instrument KEEPS the typed dot and decimals (the ticket then blocks with the step message)
    ['1.5', STOCK.qtyStep, '1.5'],
    ['2.123456789', STOCK.qtyStep, '2.12345678'],
  ])('sanitizeQtyFor(%j, step %s) = %j', (raw, step, out) => {
    expect(sanitizeQtyFor(raw, step)).toBe(out);
  });

  it('the output only ever contains digits and at most one dot, and never more decimals than allowed (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.constantFrom(BTC.qtyStep, DOGE.qtyStep, STOCK.qtyStep),
        (raw, step) => {
          const out = sanitizeQtyFor(raw, step);
          expect(out).toMatch(/^(\d*|\d+\.\d*)$/);
          const decimals = (out.split('.')[1] ?? '').length;
          expect(decimals).toBeLessThanOrEqual(stepDecimals(step) > 0 ? stepDecimals(step) : 8);
          expect((out.split('.')[0] ?? '').length).toBeLessThanOrEqual(7);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('qtyComplete: a positive quantity the field may send', () => {
  it.each([
    ['5', true],
    ['0.0025', true],
    ['10.5', true],
    ['0.00000001', true],
    ['', false],
    ['0', false],
    ['0.', false],
    ['1.', false],
    ['0.000', false],
    ['.5', false],
    ['1e3', false],
    ['-1', false],
  ])('%j -> %s', (text, ok) => {
    expect(qtyComplete(text)).toBe(ok);
  });
});

describe('compareDecimalText agrees with real arithmetic (BigInt reference)', () => {
  const U = 100_000_000n;
  const textOf = (u: bigint): string =>
    `${(u / U).toString()}.${(u % U).toString().padStart(8, '0')}`;
  it('property: -1, 0 or 1 exactly as the integers compare', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n * U }),
        fc.bigInt({ min: 0n, max: 10_000_000n * U }),
        (a, b) => {
          const expected = a === b ? 0 : a < b ? -1 : 1;
          expect(compareDecimalText(textOf(a), textOf(b))).toBe(expected);
          expect(compareDecimalText(textOf(a).replace(/0+$/, ''), textOf(b))).toBe(expected); // trailing zeros do not matter
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('qtyTooLarge with decimals', () => {
  it('the maximum itself is allowed; one smallest step above it is not', () => {
    expect(qtyTooLarge(String(MAX_ORDER_QTY))).toBe(false);
    expect(qtyTooLarge(`${String(MAX_ORDER_QTY)}.00000000`)).toBe(false);
    expect(qtyTooLarge(`${String(MAX_ORDER_QTY)}.00000001`)).toBe(true);
    expect(qtyTooLarge('999999.99999999')).toBe(false);
    expect(qtyTooLarge('1000001')).toBe(true);
  });
});

describe('stepMessage and disabledReason with the instrument step and minimum', () => {
  const base = (over: Partial<ReasonInput> = {}): ReasonInput => ({
    symbol: 'BTC-USD',
    side: 'BUY',
    qty: '0.0025',
    tradable: true,
    ...BTC,
    status: 'ACTIVE',
    quote: { freshness: 'REAL_TIME', bid: '89990.00', ask: '90010.00' },
    refreshFailed: false,
    positionQty: undefined,
    preview: { ...initialPreview, status: 'ready' },
    submitting: false,
    ...over,
  });
  it('a quantity with more decimals than the step says the step, per instrument', () => {
    expect(stepMessage('1.123456', DOGE.qtyStep)).toBe(
      'This instrument trades in steps of 0.00001.',
    );
    expect(stepMessage('1.12345', DOGE.qtyStep)).toBeNull(); // control: exactly the step's decimals
    expect(disabledReason(base({ symbol: 'DOGE-USD', ...DOGE, qty: '1.123456' }))).toBe(
      'This instrument trades in steps of 0.00001.',
    );
  });
  it('a fractional stock quantity is blocked with the step message (control: the whole quantity passes)', () => {
    expect(disabledReason(base({ symbol: 'AAPL', ...STOCK, qty: '1.5' }))).toBe(
      'This instrument trades in steps of 1.',
    );
    expect(disabledReason(base({ symbol: 'AAPL', ...STOCK, qty: '2' }))).toBeNull();
  });
  it('below the minimum names the minimum; an incomplete quantity just asks for one', () => {
    expect(disabledReason(base({ symbol: 'DOGE-USD', ...DOGE, qty: '0.00000001' }))).toBe(
      'This instrument trades in steps of 0.00001.', // 8 decimals is also past the step: the step message comes first
    );
    expect(
      disabledReason(base({ symbol: 'ETH-USD', qtyStep: '0.001', minQty: '0.01', qty: '0.005' })),
    ).toBe('The smallest order for ETH-USD is 0.01.');
    expect(disabledReason(base({ qty: '0.' }))).toBe('Enter a quantity.');
    expect(disabledReason(base({ qty: '' }))).toBe('Enter a quantity.');
  });
  it('the maximum order size message says units for a fractional instrument and shares otherwise', () => {
    expect(disabledReason(base({ qty: '1000000.00000001' }))).toBe(
      'The most you can order at once is 1,000,000 units.',
    );
    expect(disabledReason(base({ symbol: 'AAPL', ...STOCK, qty: '1000001' }))).toBe(
      'The most you can order at once is 1,000,000 shares.',
    );
  });
  it('a tradable crypto instrument with a fresh quote and a good quantity is allowed (the "not tradable yet" reason is gone)', () => {
    expect(disabledReason(base())).toBeNull();
  });
  it('an instrument without the MVP gate keeps the "not tradable yet" reason', () => {
    expect(disabledReason(base({ tradable: false }))).toMatch(/not tradable yet/);
  });
});

describe('rejectMessage with the instrument context', () => {
  it('QTY_STEP_VIOLATION and QTY_BELOW_MIN name the instrument step and minimum', () => {
    expect(rejectMessage('QTY_STEP_VIOLATION', { qtyStep: '0.00001' })).toBe(
      'This instrument trades in steps of 0.00001.',
    );
    expect(rejectMessage('QTY_BELOW_MIN', { minQty: '0.0001' })).toBe(
      'The smallest order for this instrument is 0.0001.',
    );
  });
  it('PRICE_MOVED says 2% for crypto and 1% otherwise (control)', () => {
    expect(rejectMessage('PRICE_MOVED', { assetClass: 'CRYPTO' })).toContain('2%');
    expect(rejectMessage('PRICE_MOVED', { assetClass: 'EQUITY' })).toContain('1%');
    expect(rejectMessage('PRICE_MOVED')).toContain('1%');
  });
  it('without a context the generic sentences are unchanged; an unknown code is the generic copy', () => {
    expect(rejectMessage('QTY_STEP_VIOLATION')).toBe(
      'The quantity is not a multiple of the size this instrument trades in.',
    );
    expect(rejectMessage('SOMETHING_NEW', { qtyStep: '1' })).toBe(rejectMessage(null));
  });
});
