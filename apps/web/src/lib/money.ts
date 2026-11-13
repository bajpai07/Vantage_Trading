// Money, quantity and price DISPLAY helpers. They work on the decimal strings exactly as the API sent them and use
// string operations only: no number conversion, no arithmetic, no rounding (the API already rounded to 2 dp and
// ships the full-precision value in `exact`). ESLint bans Number(), parseInt, parseFloat, Math.* and decimal
// literals in this file, and a property test proves the digits that go in are the digits that come out.

/** U+2212, the real minus sign (DESIGN_SYSTEM section 3). */
export const MINUS = '−';
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
/** Shown wherever a value is not available. Never 0, never a guess. */
export const DASH = '—';

export interface ParsedDecimal {
  readonly negative: boolean;
  /** Integer digits as received (leading zeros kept). */
  readonly int: string;
  /** Fraction digits as received, or '' when none. */
  readonly frac: string;
}

/** Splits a plain decimal string into sign, integer digits and fraction digits; null if it is not one. */
export function splitDecimal(value: string): ParsedDecimal | null {
  const m = DECIMAL.exec(value);
  if (m === null) return null;
  return { negative: m[1] === '-', int: m[2] ?? '', frac: m[3] ?? '' };
}

/** "1234567" -> "1,234,567" (digits only; thousands separators by string manipulation). */
export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** True when every digit of the value is 0 (so "0.00" and "-0.00" are zero). */
export function isZeroDecimal(value: string): boolean {
  const p = splitDecimal(value);
  return p !== null && /^0*$/.test(p.int + p.frac);
}

export type Direction = 'up' | 'down' | 'flat';

/** The direction of a signed amount, from its text: up for a positive, down for a negative, flat for zero. */
export function direction(value: string): Direction {
  const p = splitDecimal(value);
  if (p === null || isZeroDecimal(value)) return 'flat';
  return p.negative ? 'down' : 'up';
}

/**
 * "10049.60" -> "10,049.60"; "-1900.40" -> "−1,900.40". The digits are the digits received. Not a decimal: DASH.
 * A negative zero shows no sign.
 */
export function formatMoney(value: string | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  const p = splitDecimal(value);
  if (p === null) return DASH;
  const sign = p.negative && !isZeroDecimal(value) ? MINUS : '';
  return `${sign}${groupThousands(p.int)}${p.frac === '' ? '' : `.${p.frac}`}`;
}

/** Like formatMoney but with an explicit "+" for a positive amount (P&L, cash effect). Zero has no sign. */
export function formatSigned(value: string | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  const f = formatMoney(value);
  if (f === DASH) return DASH;
  return direction(value) === 'up' ? `+${f}` : f;
}

/** Quantities and prices are shown the same way as money: thousands separators, digits as received. */
export const formatQty = formatMoney;
export const formatPrice = formatMoney;
