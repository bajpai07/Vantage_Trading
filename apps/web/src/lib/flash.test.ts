// M9a D-105: the price-flash decisions. Direction from digits only; never under reduced motion; at most 600 ms.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FLASH_MS, compareDecimalStrings, flashDirection, shouldFlash } from './flash';

describe('compareDecimalStrings compares as numbers without converting', () => {
  it.each([
    ['90010.00', '90010.5', -1],
    ['90010.50', '90010.5', 0],
    ['9', '10', -1],
    ['0.01', '0.001', 1],
    ['-1.5', '-1.25', -1],
    ['-0.00', '0', 0],
    ['100', '99.99', 1],
    ['-2', '1', -1],
    ['1', '-2', 1],
  ])('%s vs %s is %s', (a, b, expected) => {
    expect(compareDecimalStrings(a, b)).toBe(expected);
    expect(compareDecimalStrings(b, a)).toBe(expected === 0 ? 0 : -expected);
  });
  it('is null for anything that is not a plain decimal', () => {
    expect(compareDecimalStrings('1e3', '1')).toBeNull();
    expect(compareDecimalStrings('abc', '1')).toBeNull();
    expect(compareDecimalStrings('', '1')).toBeNull();
  });
  it('agrees with the numeric order of 2-decimal prices (property, the test may use numbers)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99_999_999 }),
        fc.integer({ min: 0, max: 99_999_999 }),
        (x, y) => {
          const s = (n: number): string =>
            `${String(Math.trunc(n / 100))}.${String(n % 100).padStart(2, '0')}`;
          const want = x === y ? 0 : x < y ? -1 : 1;
          expect(compareDecimalStrings(s(x), s(y))).toBe(want);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('flashDirection and shouldFlash', () => {
  it('up for a higher price, down for a lower one, none for equal, first or unreadable values', () => {
    expect(flashDirection('90010.00', '90010.01')).toBe('up');
    expect(flashDirection('90010.01', '90010.00')).toBe('down');
    expect(flashDirection('90010.00', '90010.0')).toBeNull();
    expect(flashDirection(undefined, '90010.00')).toBeNull();
    expect(flashDirection('90010.00', undefined)).toBeNull();
    expect(flashDirection('x', '1')).toBeNull();
  });
  it('reduced motion disables the flash entirely (control: it flashes otherwise)', () => {
    expect(shouldFlash(true, 'up')).toBe(false);
    expect(shouldFlash(true, 'down')).toBe(false);
    expect(shouldFlash(false, 'up')).toBe(true);
    expect(shouldFlash(false, null)).toBe(false);
  });
  it('lasts at most 600 ms', () => {
    expect(FLASH_MS).toBeLessThanOrEqual(600);
  });
});
