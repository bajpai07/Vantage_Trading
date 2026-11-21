// Pure posting recipes (TRADING_ENGINE section 5.1). No IO, no clock, no randomness, no floats.
// A leg is signed: positive increases the ledger account balance, negative decreases it.
import type { Dec } from '@vantage/money';
import { EngineInputError, EngineInvariantError, UnsupportedCurrencyError } from './errors.js';
import { isZero, mul, negate, parse, round8, sign, sub, add } from '@vantage/money';

export type LedgerAccountType =
  | 'CAPITAL'
  | 'CASH'
  | 'RESERVED'
  | 'POSITION_COST'
  | 'FEES'
  | 'REALIZED_PNL'
  | 'FX_CLEARING'
  | 'ADJUSTMENT';

export interface Leg {
  readonly ledgerAccountType: LedgerAccountType;
  readonly currency: string;
  /** Signed fixed-point string with exactly 8 decimal places. */
  readonly amount: string;
}

const USD = 'USD';
const SCALE = 8;

function checkCurrency(currency: string | undefined): void {
  if (currency !== undefined && currency !== USD) {
    throw new UnsupportedCurrencyError(`only ${USD} is supported in M1`);
  }
}

function amountOf(name: string, value: string, rule: 'positive' | 'non-negative'): Dec {
  let d: Dec;
  try {
    d = parse(value);
  } catch {
    throw new EngineInputError(`${name} must be a plain decimal string`);
  }
  const s = sign(d);
  if (rule === 'positive' ? s <= 0 : s < 0) {
    throw new EngineInputError(`${name} must be ${rule}`);
  }
  return d;
}

function leg(ledgerAccountType: LedgerAccountType, value: Dec): Leg {
  return { ledgerAccountType, currency: USD, amount: value.toScaleString(SCALE) };
}

/** Zero legs are omitted (the database forbids zero entries); every currency must sum to exactly zero. */
function finish(candidates: readonly [LedgerAccountType, Dec][]): Leg[] {
  const total = candidates.reduce<Dec>((acc, [, v]) => add(acc, v), parse('0'));
  if (!isZero(total)) {
    throw new EngineInvariantError('legs do not sum to zero');
  }
  return candidates.filter(([, v]) => !isZero(v)).map(([type, v]) => leg(type, v));
}

/** Sums legs per currency and throws unless every currency is exactly zero. */
export function assertBalanced(legs: readonly Leg[]): void {
  const sums = new Map<string, Dec>();
  for (const l of legs) {
    sums.set(l.currency, add(sums.get(l.currency) ?? parse('0'), parse(l.amount)));
  }
  for (const [currency, s] of sums) {
    if (!isZero(s)) throw new EngineInvariantError(`legs do not sum to zero in ${currency}`);
  }
}

export interface GrantInput {
  readonly amount: string;
  readonly currency?: string;
}

/** GRANT: CASH +A, CAPITAL -A. */
export function grantLegs(input: GrantInput): Leg[] {
  checkCurrency(input.currency);
  const a = round8(amountOf('amount', input.amount, 'positive'));
  const legs = finish([
    ['CASH', a],
    ['CAPITAL', negate(a)],
  ]);
  assertBalanced(legs);
  return legs;
}

export interface BuyFillInput {
  readonly qty: string;
  readonly price: string;
  readonly fee: string;
  readonly currency?: string;
}

/**
 * BUY fill, synchronous execution (no RESERVED movement, D-39).
 * C = round8(qty x price), f = round8(fee). CASH -(C + f), POSITION_COST +C, FEES +f.
 */
export function buyFillLegs(input: BuyFillInput): Leg[] {
  checkCurrency(input.currency);
  const qty = amountOf('qty', input.qty, 'positive');
  const price = amountOf('price', input.price, 'positive');
  const f = round8(amountOf('fee', input.fee, 'non-negative'));
  const c = round8(mul(qty, price));
  const legs = finish([
    ['CASH', negate(add(c, f))],
    ['POSITION_COST', c],
    ['FEES', f],
  ]);
  assertBalanced(legs);
  return legs;
}

export interface SellFillInput {
  readonly qty: string;
  readonly price: string;
  readonly fee: string;
  /** FIFO cost basis of the quantity sold. */
  readonly basis: string;
  readonly currency?: string;
}

/**
 * SELL fill. P = round8(qty x price), f = round8(fee), B = round8(basis).
 * CASH +(P - f), FEES +f, POSITION_COST -B, REALIZED_PNL -(P - B).
 */
export function sellFillLegs(input: SellFillInput): Leg[] {
  checkCurrency(input.currency);
  const qty = amountOf('qty', input.qty, 'positive');
  const price = amountOf('price', input.price, 'positive');
  const f = round8(amountOf('fee', input.fee, 'non-negative'));
  const b = round8(amountOf('basis', input.basis, 'non-negative'));
  const p = round8(mul(qty, price));
  const legs = finish([
    ['CASH', sub(p, f)],
    ['FEES', f],
    ['POSITION_COST', negate(b)],
    ['REALIZED_PNL', negate(sub(p, b))],
  ]);
  assertBalanced(legs);
  return legs;
}

export interface ReserveInput {
  /** The amount to hold back (a limit BUY's reserve R, or what a cancel or expiry gives back). */
  readonly amount: string;
  readonly currency?: string;
}

/** ORDER_RESERVE (TRADING_ENGINE 5.1): a limit BUY is accepted. CASH -R, RESERVED +R. */
export function reserveLegs(input: ReserveInput): Leg[] {
  checkCurrency(input.currency);
  const r = round8(amountOf('amount', input.amount, 'positive'));
  const legs = finish([
    ['CASH', negate(r)],
    ['RESERVED', r],
  ]);
  assertBalanced(legs);
  return legs;
}

/** ORDER_RELEASE (TRADING_ENGINE 5.1): cancel or expiry. RESERVED -R, CASH +R, with R the STORED reserved amount. */
export function releaseLegs(input: ReserveInput): Leg[] {
  checkCurrency(input.currency);
  const r = round8(amountOf('amount', input.amount, 'positive'));
  const legs = finish([
    ['RESERVED', negate(r)],
    ['CASH', r],
  ]);
  assertBalanced(legs);
  return legs;
}

export interface BuyFillFromReserveInput {
  readonly qty: string;
  readonly price: string;
  readonly fee: string;
  /** The reserved amount R of the order (the stored reserved_usd). */
  readonly reserved: string;
  readonly currency?: string;
}

/**
 * FILL of a BUY that holds a reservation (TRADING_ENGINE 5.1): C = round8(qty x price), f = round8(fee), R the reserved amount.
 * RESERVED -R, POSITION_COST +C, FEES +f, CASH +(R - C - f). It requires C + f <= R: a fill may never spend more than was
 * reserved (the reserve of a limit BUY is built so this always holds, D-92; if it ever did not, the fill is refused with an
 * EngineInvariantError and the order is left intact). A zero CASH leg (C + f = R exactly) is omitted.
 */
export function buyFillFromReserveLegs(input: BuyFillFromReserveInput): Leg[] {
  checkCurrency(input.currency);
  const qty = amountOf('qty', input.qty, 'positive');
  const price = amountOf('price', input.price, 'positive');
  const f = round8(amountOf('fee', input.fee, 'non-negative'));
  const r = round8(amountOf('reserved', input.reserved, 'positive'));
  const c = round8(mul(qty, price));
  const back = sub(r, add(c, f));
  if (sign(back) < 0) {
    throw new EngineInvariantError('the fill would cost more than the reservation (C + f > R)');
  }
  const legs = finish([
    ['RESERVED', negate(r)],
    ['POSITION_COST', c],
    ['FEES', f],
    ['CASH', back],
  ]);
  assertBalanced(legs);
  return legs;
}

export * from './errors.js';
export * from './lots.js';
export * from './limit-order.js';
export * from './depth.js';
export * from './market-order.js';
export * from './valuation.js';
