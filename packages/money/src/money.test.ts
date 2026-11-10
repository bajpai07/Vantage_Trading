import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Dec } from './index.js';
import {
  MoneyArgumentError,
  MoneyDivisionByZeroError,
  MoneyParseError,
  add,
  compare,
  div,
  isZero,
  max,
  min,
  mul,
  negate,
  parse,
  round8,
  roundToTickDown,
  roundToTickUp,
  sign,
  sub,
  toDbString,
} from './index.js';

const p = (s: string): Dec => parse(s);

// Arbitrary decimal strings built from digit strings only: no JS number ever carries a money value.
const digits = (min: number, max: number) =>
  fc.stringMatching(/^[0-9]*$/, { minLength: min, maxLength: max });
const intPart = fc.oneof(
  fc.constant('0'),
  fc.tuple(fc.stringMatching(/^[1-9]$/), digits(0, 17)).map(([a, b]) => a + b),
);
const decString = fc
  .tuple(fc.boolean(), intPart, digits(0, 10))
  .map(([neg, i, f]) => `${neg ? '-' : ''}${i}${f === '' ? '' : `.${f}`}`);
const positiveDecString = decString.filter((s) => !s.startsWith('-') && !isZero(p(s)));

describe('parse', () => {
  it('accepts plain decimals', () => {
    for (const s of ['0', '-0', '12', '-12', '0.5', '-0.50', '123456789012345678.1234567890']) {
      expect(() => parse(s)).not.toThrow();
    }
  });

  it.each([
    ['empty string', ''],
    ['space only', ' '],
    ['leading space', ' 1'],
    ['trailing space', '1 '],
    ['trailing newline', '1\n'],
    ['exponent', '1e3'],
    ['exponent upper', '1E-3'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['plus sign', '+1'],
    ['leading dot', '.5'],
    ['trailing dot', '1.'],
    ['two dots', '1.2.3'],
    ['comma', '1,5'],
    ['hex', '0x1F'],
    ['underscore', '1_000'],
    ['double minus', '--1'],
    ['unicode digit', '١'],
    ['letters', 'abc'],
    ['too many digits', '1'.repeat(39)],
  ])('rejects %s with a typed error', (_name, input) => {
    expect(() => parse(input)).toThrow(MoneyParseError);
  });

  it('rejects non-strings', () => {
    expect(() => parse(1 as unknown as string)).toThrow(MoneyParseError);
    expect(() => parse(undefined as unknown as string)).toThrow(MoneyParseError);
  });

  it('does not echo the rejected input in the error', () => {
    expect(() => parse('secret-value')).toThrow(/not a plain decimal/);
    try {
      parse('secret-value');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('secret-value');
    }
  });
});

describe('arithmetic is exact', () => {
  it('0.1 + 0.2 equals 0.3 exactly', () => {
    const s = add(p('0.1'), p('0.2'));
    expect(s.toString()).toBe('0.3');
    expect(s.equals(p('0.3'))).toBe(true);
  });

  it('18-digit integers and 10-decimal fractions round-trip', () => {
    for (const s of [
      '999999999999999999',
      '-999999999999999999',
      '0.1234567891',
      '-0.1234567891',
      '123456789012345678.1234567891',
    ]) {
      expect(toDbString(p(s))).toBe(s);
    }
  });

  it('keeps products exact (no silent rounding)', () => {
    expect(mul(p('1234567890.1234567891'), p('2')).toString()).toBe('2469135780.2469135782');
    expect(mul(p('0.1'), p('0.1')).toString()).toBe('0.01');
    // 28 digits x 28 digits = 56 digits, still exact
    expect(mul(p('9999999999999999.9999999999'), p('9999999999999999.9999999999')).toString()).toBe(
      '99999999999999999999999998000000.00000000000000000001',
    );
  });

  it('sub, negate, sign, isZero, compare, min, max', () => {
    expect(sub(p('1'), p('3')).toString()).toBe('-2');
    expect(negate(p('2.5')).toString()).toBe('-2.5');
    expect(negate(p('0')).toString()).toBe('0');
    expect(sign(p('-3'))).toBe(-1);
    expect(sign(p('0.000'))).toBe(0);
    expect(sign(p('3'))).toBe(1);
    expect(isZero(p('-0'))).toBe(true);
    expect(compare(p('1.0'), p('1'))).toBe(0);
    expect(compare(p('1'), p('2'))).toBe(-1);
    expect(compare(p('2'), p('1'))).toBe(1);
    expect(min(p('1'), p('2')).toString()).toBe('1');
    expect(max(p('1'), p('2')).toString()).toBe('2');
  });

  it('never prints an exponent', () => {
    expect(p('0.0000000000000000000001').toString()).toBe('0.0000000000000000000001');
    expect(p('100000000000000000000000000000').toString()).toBe('100000000000000000000000000000');
  });

  it('toScaleString pads and refuses to round', () => {
    expect(p('1.5').toScaleString(8)).toBe('1.50000000');
    expect(p('-0').toScaleString(2)).toBe('0.00');
    expect(() => p('1.123').toScaleString(2)).toThrow(MoneyArgumentError);
  });
});

describe('division requires explicit rounding', () => {
  it('rounds at the named scale and mode', () => {
    expect(div(p('1'), p('3'), 4, 'HALF_EVEN').toString()).toBe('0.3333');
    expect(div(p('2'), p('3'), 4, 'HALF_EVEN').toString()).toBe('0.6667');
    expect(div(p('1'), p('3'), 4, 'CEIL').toString()).toBe('0.3334');
    expect(div(p('-1'), p('3'), 4, 'FLOOR').toString()).toBe('-0.3334');
    expect(div(p('1'), p('3'), 0, 'UP').toString()).toBe('1');
  });
  it('throws a typed error on zero and on a bad scale', () => {
    expect(() => div(p('1'), p('0'), 2, 'HALF_EVEN')).toThrow(MoneyDivisionByZeroError);
    expect(() => div(p('1'), p('3'), -1, 'HALF_EVEN')).toThrow(MoneyArgumentError);
    expect(() => div(p('1'), p('3'), 41, 'HALF_EVEN')).toThrow(MoneyArgumentError);
  });
});

describe('round8 is HALF_EVEN', () => {
  it.each([
    ['0.000000005', '0'],
    ['0.000000015', '0.00000002'],
    ['0.000000025', '0.00000002'],
    ['0.000000035', '0.00000004'],
    ['-0.000000005', '0'],
    ['-0.000000015', '-0.00000002'],
    ['0.000000004', '0'],
    ['0.000000006', '0.00000001'],
    ['1.123456785', '1.12345678'],
    ['1.123456795', '1.1234568'],
  ])('round8(%s) = %s', (input, expected) => {
    expect(round8(p(input)).toString()).toBe(expected);
  });

  it('renders the tie points at 8 dp', () => {
    expect(round8(p('0.000000005')).toScaleString(8)).toBe('0.00000000');
    expect(round8(p('0.000000015')).toScaleString(8)).toBe('0.00000002');
  });
});

describe('tick rounding', () => {
  it('rounds buys up and sells down to the tick', () => {
    expect(roundToTickUp(p('190.038'), p('0.01')).toString()).toBe('190.04');
    expect(roundToTickDown(p('2599.22'), p('0.05')).toString()).toBe('2599.2');
    expect(roundToTickUp(p('190.04'), p('0.01')).toString()).toBe('190.04'); // already on the tick
    expect(roundToTickDown(p('190.04'), p('0.01')).toString()).toBe('190.04');
  });
  it('rejects a zero or negative tick', () => {
    expect(() => roundToTickUp(p('1'), p('0'))).toThrow(MoneyArgumentError);
    expect(() => roundToTickDown(p('1'), p('-0.01'))).toThrow(MoneyArgumentError);
  });
});

describe('properties (fast-check)', () => {
  it('(a + b) - b = a', () => {
    fc.assert(
      fc.property(decString, decString, (a, b) => {
        const x = p(a);
        const y = p(b);
        expect(sub(add(x, y), y).equals(x)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('a + b = b + a', () => {
    fc.assert(
      fc.property(decString, decString, (a, b) => {
        expect(add(p(a), p(b)).equals(add(p(b), p(a)))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('round8 is idempotent', () => {
    fc.assert(
      fc.property(decString, (a) => {
        const once = round8(p(a));
        expect(round8(once).equals(once)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('round8 never moves a value by more than half a unit in the 8th place', () => {
    fc.assert(
      fc.property(decString, (a) => {
        const x = p(a);
        const diff = sub(round8(x), x);
        const abs = diff.sign() < 0 ? negate(diff) : diff;
        expect(compare(abs, p('0.000000005')) <= 0).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('tick rounding never moves a price the wrong way, and lands on the tick', () => {
    const tick = fc.constantFrom('0.01', '0.05', '0.0001', '1', '0.25', '0.00000001');
    fc.assert(
      fc.property(positiveDecString, tick, (priceS, tickS) => {
        const price = p(priceS);
        const t = p(tickS);
        const up = roundToTickUp(price, t);
        const down = roundToTickDown(price, t);
        expect(compare(up, price) >= 0).toBe(true);
        expect(compare(down, price) <= 0).toBe(true);
        expect(compare(sub(up, price), t) < 0).toBe(true);
        expect(compare(sub(price, down), t) < 0).toBe(true);
        // on the tick: the value divided by the tick is a whole number
        expect(div(up, t, 0, 'HALF_EVEN').mul(t).equals(up)).toBe(true);
        expect(div(down, t, 0, 'HALF_EVEN').mul(t).equals(down)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
