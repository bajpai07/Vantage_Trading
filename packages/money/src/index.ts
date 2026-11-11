import { Decimal } from 'decimal.js';

// One fixed configuration for all money math. Precision 80 is far above what two numeric(28,10)
// operands can need (a product has at most 56 digits), so add/sub/mul are exact and a division
// can only round at the explicit scale the caller asks for.
const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });

const MODES = {
  UP: D.ROUND_UP,
  DOWN: D.ROUND_DOWN,
  CEIL: D.ROUND_CEIL,
  FLOOR: D.ROUND_FLOOR,
  HALF_UP: D.ROUND_HALF_UP,
  HALF_DOWN: D.ROUND_HALF_DOWN,
  HALF_EVEN: D.ROUND_HALF_EVEN,
} as const;

export type RoundingMode = keyof typeof MODES;

/** Inputs longer than this are refused (a numeric(28,10) value has 28 digits). */
export const MAX_DIGITS = 38;
/** Largest scale accepted by `div` and `round`. */
export const MAX_SCALE = 40;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class MoneyParseError extends MoneyError {}
export class MoneyDivisionByZeroError extends MoneyError {}
export class MoneyArgumentError extends MoneyError {}

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

function checkScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new MoneyArgumentError(`scale must be an integer from 0 to ${String(MAX_SCALE)}`);
  }
}

/** An immutable exact decimal. Construct it with `parse`. There is no way to build one from a JS number. */
export class Dec {
  readonly #d: Decimal;

  private constructor(d: Decimal) {
    this.#d = d;
  }

  static parse(input: string): Dec {
    if (typeof input !== 'string' || !PLAIN_DECIMAL.test(input)) {
      // The offending value is not echoed: it may be a secret by accident.
      throw new MoneyParseError('not a plain decimal string (expected -?digits[.digits])');
    }
    if (input.replace(/[-.]/g, '').length > MAX_DIGITS) {
      throw new MoneyParseError(`too many digits (max ${String(MAX_DIGITS)})`);
    }
    return new Dec(new D(input));
  }

  add(b: Dec): Dec {
    return new Dec(this.#d.plus(b.#d));
  }
  sub(b: Dec): Dec {
    return new Dec(this.#d.minus(b.#d));
  }
  mul(b: Dec): Dec {
    return new Dec(this.#d.times(b.#d));
  }
  /** Division always names the scale (decimal places) and the rounding mode. */
  div(b: Dec, scale: number, mode: RoundingMode): Dec {
    checkScale(scale);
    if (b.#d.isZero()) throw new MoneyDivisionByZeroError('division by zero');
    return new Dec(this.#d.div(b.#d).toDecimalPlaces(scale, MODES[mode]));
  }
  round(scale: number, mode: RoundingMode): Dec {
    checkScale(scale);
    return new Dec(this.#d.toDecimalPlaces(scale, MODES[mode]));
  }
  negate(): Dec {
    return new Dec(this.#d.negated());
  }
  isZero(): boolean {
    return this.#d.isZero();
  }
  sign(): -1 | 0 | 1 {
    if (this.#d.isZero()) return 0;
    return this.#d.isNegative() ? -1 : 1;
  }
  compare(b: Dec): -1 | 0 | 1 {
    return this.#d.comparedTo(b.#d) as -1 | 0 | 1;
  }
  equals(b: Dec): boolean {
    return this.#d.equals(b.#d);
  }
  /** Plain fixed-point text (never an exponent). Zero is always "0". */
  toString(): string {
    return this.#d.isZero() ? '0' : this.#d.toFixed();
  }
  /** Fixed-point text with exactly `scale` decimal places (pads with zeros; refuses to round). */
  toScaleString(scale: number): string {
    checkScale(scale);
    if (this.#d.decimalPlaces() > scale) {
      throw new MoneyArgumentError('value has more decimal places than the requested scale');
    }
    const text = this.#d.toFixed(scale);
    return this.#d.isZero() ? this.#d.abs().toFixed(scale) : text;
  }
  /**
   * Canonical API text: at least 2 decimal places, trailing zeros beyond the 2nd trimmed
   * ("10000.00", "1900.4015"). Display rounding is a UI concern; this never rounds.
   */
  toCanonicalString(): string {
    const text = this.toString();
    const dot = text.indexOf('.');
    if (dot === -1) return `${text}.00`;
    return text.length - dot - 1 === 1 ? `${text}0` : text;
  }
  /** A plain fixed-point string for a Postgres `numeric` parameter. */
  toDbString(): string {
    return this.toString();
  }
}

export const parse = (s: string): Dec => Dec.parse(s);
export const add = (a: Dec, b: Dec): Dec => a.add(b);
export const sub = (a: Dec, b: Dec): Dec => a.sub(b);
export const mul = (a: Dec, b: Dec): Dec => a.mul(b);
export const div = (a: Dec, b: Dec, scale: number, mode: RoundingMode): Dec =>
  a.div(b, scale, mode);
export const compare = (a: Dec, b: Dec): -1 | 0 | 1 => a.compare(b);
export const min = (a: Dec, b: Dec): Dec => (a.compare(b) <= 0 ? a : b);
export const max = (a: Dec, b: Dec): Dec => (a.compare(b) >= 0 ? a : b);
export const negate = (a: Dec): Dec => a.negate();
export const isZero = (a: Dec): boolean => a.isZero();
export const sign = (a: Dec): -1 | 0 | 1 => a.sign();
export const toDbString = (a: Dec): string => a.toDbString();
export const toCanonicalString = (a: Dec): string => a.toCanonicalString();

/** 8 decimal places, HALF_EVEN (TRADING_ENGINE section 9). */
export const round8 = (a: Dec): Dec => a.round(8, 'HALF_EVEN');

function checkTick(tick: Dec): void {
  if (tick.sign() <= 0) throw new MoneyArgumentError('tick must be positive');
}

/** The smallest multiple of `tick` that is >= price (buys round up). */
export function roundToTickUp(price: Dec, tick: Dec): Dec {
  checkTick(tick);
  return price.div(tick, 0, 'CEIL').mul(tick);
}

/** The largest multiple of `tick` that is <= price (sells round down). */
export function roundToTickDown(price: Dec, tick: Dec): Dec {
  checkTick(tick);
  return price.div(tick, 0, 'FLOOR').mul(tick);
}
