import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { formatUtc, formatUtcShort, shortId } from './format';
import {
  DASH,
  MINUS,
  direction,
  formatMoney,
  formatQty,
  formatSigned,
  groupThousands,
  isZeroDecimal,
  splitDecimal,
} from './money';

const here = dirname(fileURLToPath(import.meta.url));
const digitsOf = (s: string): string => s.replace(/\D/g, '');

describe('formatMoney: hand-checked examples (the digits are the digits received)', () => {
  it.each([
    ['10000.00', '10,000.00'],
    ['8099.60', '8,099.60'],
    ['0.00', '0.00'],
    ['49.60', '49.60'],
    ['-1900.40', `${MINUS}1,900.40`],
    ['-0.01', `${MINUS}0.01`],
    ['1234567.89', '1,234,567.89'],
    ['999999999999999999999999.99', '999,999,999,999,999,999,999,999.99'],
    ['190.04', '190.04'],
    ['0.12345678', '0.12345678'], // 8 dp shown as received, never rounded
    ['1.9004', '1.9004'],
    ['100', '100'],
    ['1000', '1,000'],
    ['007.50', '007.50'], // leading zeros are not "fixed": digits in, digits out
    ['-0.00', '0.00'], // negative zero shows no sign
  ])('%s -> %s', (input, out) => {
    expect(formatMoney(input)).toBe(out);
  });

  it.each([
    null,
    undefined,
    '',
    'abc',
    '1e3',
    '1,000.00',
    '+5.00',
    '--1',
    '1.',
    '.5',
    ' 5',
    '5 ',
    'NaN',
    'Infinity',
  ])('a value that is not a plain decimal string shows the dash, never a number: %s', (v) => {
    expect(formatMoney(v)).toBe(DASH);
    expect(formatSigned(v)).toBe(DASH);
  });
});

describe('formatSigned: explicit plus, real minus, zero has no sign', () => {
  it.each([
    ['49.60', '+49.60'],
    ['-5.17', `${MINUS}5.17`],
    ['0.00', '0.00'],
    ['-0.00', '0.00'],
    ['1000.50', '+1,000.50'],
    ['-1000.50', `${MINUS}1,000.50`],
  ])('%s -> %s', (input, out) => {
    expect(formatSigned(input)).toBe(out);
  });
});

describe('direction', () => {
  it.each([
    ['49.60', 'up'],
    ['-0.01', 'down'],
    ['0.00', 'flat'],
    ['-0.00', 'flat'],
    ['0', 'flat'],
    ['not a number', 'flat'],
  ])('%s is %s', (v, d) => {
    expect(direction(v)).toBe(d);
  });
});

describe('property: no number conversion happens (digits in equal digits out)', () => {
  const intDigits = fc.stringMatching(/^[0-9]{1,30}$/);
  const fracDigits = fc.stringMatching(/^[0-9]{1,12}$/);
  const decimal = fc
    .tuple(fc.boolean(), intDigits, fc.option(fracDigits, { nil: undefined }))
    .map(([neg, i, f]) => `${neg ? '-' : ''}${i}${f === undefined ? '' : `.${f}`}`);

  it('the digits of the output are exactly the digits of the input, in order (negative, zero, huge, 8 dp)', () => {
    fc.assert(
      fc.property(decimal, (v) => {
        for (const f of [formatMoney, formatSigned, formatQty]) {
          expect(digitsOf(f(v)), v).toBe(digitsOf(v));
        }
      }),
      { numRuns: 500 },
    );
  });

  it('the fraction is kept character for character (no rounding, no padding, no trimming)', () => {
    fc.assert(
      fc.property(decimal, (v) => {
        const p = splitDecimal(v);
        const out = formatMoney(v);
        expect(out.includes('.')).toBe(p !== null && p.frac !== '');
        if (p !== null && p.frac !== '') expect(out.endsWith(`.${p.frac}`)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('removing the separators and the sign gives the integer digits back; the sign is a real minus or none', () => {
    fc.assert(
      fc.property(decimal, (v) => {
        const out = formatMoney(v);
        const p = splitDecimal(v);
        expect(out.replace(/[,−]/g, '').replace(/^-/, '')).toBe(
          `${p?.int ?? ''}${p !== null && p.frac !== '' ? `.${p.frac}` : ''}`,
        );
        expect(out.includes('-')).toBe(false); // never an ASCII hyphen-minus
        if (out.startsWith(MINUS)) expect(isZeroDecimal(v)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('groupThousands groups every three digits from the right and never changes the digits', () => {
    fc.assert(
      fc.property(intDigits, (d) => {
        const g = groupThousands(d);
        expect(g.replace(/,/g, '')).toBe(d);
        for (const part of g.split(',').slice(1)) expect(part.length).toBe(3);
        expect(g.split(',')[0]?.length).toBeLessThanOrEqual(3);
      }),
      { numRuns: 300 },
    );
  });

  it('values beyond the safe-integer and float range survive exactly (a float conversion would corrupt them)', () => {
    const big = '12345678901234567890123456789.12345678';
    expect(formatMoney(big)).toBe('12,345,678,901,234,567,890,123,456,789.12345678');
    expect(formatMoney('0.1000000000000000055511151231257827')).toBe(
      '0.1000000000000000055511151231257827',
    );
    expect(formatMoney('9007199254740993')).toBe('9,007,199,254,740,993'); // 2^53 + 1: a float would give ...992
  });
});

describe('timestamps: string manipulation only, always UTC', () => {
  it('formats an ISO instant', () => {
    expect(formatUtc('2026-11-10T14:45:00.000Z')).toBe('2026-11-10 14:45:00 UTC');
    expect(formatUtc('2026-11-10T14:45:00Z')).toBe('2026-11-10 14:45:00 UTC');
    expect(formatUtcShort('2026-11-10T14:45:00.000Z')).toBe('2026-11-10 14:45 UTC');
  });
  it.each([null, undefined, '', 'yesterday', '2026-11-10', '2026-11-10T14:45:00+05:30'])(
    '%s -> dash',
    (v) => {
      expect(formatUtc(v)).toBe(DASH);
      expect(formatUtcShort(v)).toBe(DASH);
    },
  );
  it('shortId is the last 8 characters', () => {
    expect(shortId('0198d0d0-1111-7000-8000-00000000abcd')).toBe('0000abcd');
  });
});

describe('the display helpers cannot convert money to a number (ESLint, the real config)', () => {
  const eslint = new ESLint({ cwd: join(here, '..', '..', '..', '..') });
  const lint = async (code: string) => {
    const [r] = await eslint.lintText(code, { filePath: join(here, 'money.ts') });
    return (r?.messages ?? []).filter((m) => m.severity === 2);
  };

  it.each([
    ['Number(', 'export const a = Number("1.5");'],
    ['parseFloat', 'export const a = parseFloat("1.5");'],
    ['parseInt', 'export const a = parseInt("15", 10);'],
    ['Math', 'export const a = Math.round(1);'],
    ['unary plus', 'export const a = +"1.5";'],
    ['decimal literal', 'export const a = 1.5;'],
  ])('bans %s in money.ts', async (_n, code) => {
    expect((await lint(code)).length).toBeGreaterThan(0);
  });

  it('allows string operations (control) and the real file is clean', async () => {
    expect(await lint('export const a = "12".replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");')).toEqual(
      [],
    );
    const [r] = await eslint.lintFiles([join(here, 'money.ts'), join(here, 'format.ts')]);
    expect((r?.messages ?? []).filter((m) => m.severity === 2)).toEqual([]);
  });

  it('control: the source of money.ts really contains none of the banned calls', () => {
    const src = readFileSync(join(here, 'money.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\bNumber\(|parseFloat|parseInt|Math\./);
  });
});
