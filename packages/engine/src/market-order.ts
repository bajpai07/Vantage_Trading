// Market order decisions (TRADING_ENGINE sections 3, 4, 6, 7; decisions D-30, D-33, D-39, D-51, D-52, D-54).
// Pure: no IO, no clock, no randomness. Prices and quantities are decimal strings.
import type { FreshnessState, InstrumentStatus } from '@vantage/market-model';
import {
  add,
  compare,
  div,
  isZero,
  max,
  min,
  mul,
  parse,
  round8,
  roundToTickDown,
  roundToTickUp,
  sign,
  sub,
} from '@vantage/money';
import { EngineInputError, EngineInvariantError } from './errors.js';

export type OrderSide = 'BUY' | 'SELL';

/**
 * Reject codes in the order the rules are checked. THE FIRST FAILURE WINS.
 * 1 TRADING_PAUSED          admin kill switch (trading disabled)
 * 2 ACCOUNT_NOT_ACTIVE      the account or its user is not ACTIVE
 * 3 INSTRUMENT_NOT_TRADABLE not tradable in the MVP, DELISTED, or a BUY on a SELL_ONLY instrument
 * 4 INSTRUMENT_HALTED
 * 5 QTY_BELOW_MIN
 * 6 QTY_STEP_VIOLATION      (the instrument's step: 1 for stocks and ETFs, so a fraction is a violation; 0.00000001 for crypto)
 * 7 quote eligibility       UNAVAILABLE -> NO_ELIGIBLE_QUOTE, CLOSED -> MARKET_CLOSED, STALE -> STALE_QUOTE,
 *                           DELAYED while allowExecutionOnDelayed is false -> NO_ELIGIBLE_QUOTE
 * 8 PRICE_MOVED             the price moved against the user by more than the collar (D-51)
 * 8b QTY_BELOW_MIN          (M8) a BUY whose cost rounds to 0 at 8 decimal places: the order is too small to price. It sits
 *                           right after the price check because it needs the fill price; the code is the existing one
 *                           for "too small", so the code list and its order are unchanged.
 * 9 funds / position        BUY: INSUFFICIENT_BUYING_POWER (cash < notional + fee); SELL: INSUFFICIENT_POSITION
 * 10 FEE_EXCEEDS_PROCEEDS   SELL only, after the position check: the fee is larger than the proceeds (D-57)
 */
export const REJECT_RULE_ORDER = [
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
] as const;
export type RejectCode = (typeof REJECT_RULE_ORDER)[number];

/** The feature gate an instrument must carry in `tradable_in` to be traded in the MVP. */
export const MVP_TRADABLE_GATE = 'MVP';
/** Collar for equities and ETFs: the largest adverse price move tolerated since the user saw the price (1%). */
export const EQUITY_COLLAR_PERCENT = '1';
/** Collar for crypto (TRADING_ENGINE section 6: 2% crypto). */
export const CRYPTO_COLLAR_PERCENT = '2';

/** The collar (percent) of an asset class; anything that is not CRYPTO uses the equity collar. */
export function collarPercentFor(assetClass: string | undefined): string {
  return assetClass === 'CRYPTO' ? CRYPTO_COLLAR_PERCENT : EQUITY_COLLAR_PERCENT;
}

export interface FeeScheduleInput {
  readonly commissionBps: string;
  readonly commissionMinLocal: string;
  readonly slippageBaseBps: string;
  /** Always 0 in v1: there is no ADV data, so only the base slippage applies. */
  readonly slippageSizeCoef: string;
}

export interface MarketOrderInput {
  readonly side: OrderSide;
  /** Quantity as a decimal string (at most 8 decimals); it must be a multiple of the instrument's qty step. */
  readonly qty: string;
  readonly instrument: {
    readonly status: InstrumentStatus;
    readonly tradableIn: readonly string[];
    readonly tickSize: string;
    readonly minQty: string;
    readonly qtyStep: string;
  };
  /** The quote that would be traded against; null when there is none. */
  readonly quote: { readonly bid: string; readonly ask: string } | null;
  readonly freshness: FreshnessState;
  readonly allowExecutionOnDelayed: boolean;
  readonly schedule: FeeScheduleInput;
  /** The ask the user saw for a BUY, the bid for a SELL. */
  readonly referencePrice: string;
  readonly account: { readonly active: boolean; readonly tradingEnabled: boolean };
  readonly cash: string;
  readonly positionQty: string;
  /** Override of the collar (percent); defaults to the 1% equity collar. */
  readonly collarPercent?: string;
}

export type MarketOrderDecision =
  | {
      readonly decision: 'FILL';
      /** Slippage-adjusted fill price, a multiple of the tick. */
      readonly price: string;
      /** round8(qty x price): proceeds for a SELL, cost for a BUY. */
      readonly notional: string;
      readonly fee: string;
      readonly slippageBps: string;
    }
  | { readonly decision: 'REJECT'; readonly code: RejectCode };

const BPS_BASE = parse('10000');
const HUNDRED = parse('100');
const SCALE = 20;

/**
 * TRADING_ENGINE section 4: BUY = ask x (1 + bps/10000) rounded UP to the tick; SELL = bid x (1 - bps/10000)
 * rounded DOWN to the tick. The single place a fill price is computed. The result is always positive.
 */
export function fillPrice(
  side: OrderSide,
  bid: string,
  ask: string,
  slippageBps: string,
  tick: string,
): string {
  const bps = parse(slippageBps);
  const t = parse(tick);
  const price =
    side === 'BUY'
      ? roundToTickUp(div(mul(parse(ask), add(BPS_BASE, bps)), BPS_BASE, SCALE, 'HALF_EVEN'), t)
      : roundToTickDown(div(mul(parse(bid), sub(BPS_BASE, bps)), BPS_BASE, SCALE, 'HALF_EVEN'), t);
  if (sign(price) <= 0) throw new EngineInvariantError('fill price must be positive');
  return price.toString();
}

/** max(notional x bps / 10000, minimum), rounded to 8 decimal places HALF_EVEN. */
export function commission(
  notional: string,
  schedule: Pick<FeeScheduleInput, 'commissionBps' | 'commissionMinLocal'>,
): string {
  const raw = div(
    mul(parse(notional), parse(schedule.commissionBps)),
    BPS_BASE,
    SCALE,
    'HALF_EVEN',
  );
  return round8(max(raw, parse(schedule.commissionMinLocal))).toString();
}

export interface Pricing {
  readonly price: string;
  /** round8(qty x price): proceeds for a SELL, cost for a BUY. */
  readonly notional: string;
  readonly fee: string;
  readonly slippageBps: string;
}

/**
 * THE one place a quantity becomes a price, a notional and a fee: the order decision, the preview estimate and the
 * "maximum quantity" search all call it, so none of them can use a different formula.
 */
export function priceOrder(
  side: OrderSide,
  qty: string,
  quote: { readonly bid: string; readonly ask: string },
  schedule: FeeScheduleInput,
  tickSize: string,
): Pricing {
  const slippageBps = schedule.slippageBaseBps; // the size term is 0: no ADV data (D-54)
  const price = fillPrice(side, quote.bid, quote.ask, slippageBps, tickSize);
  const notional = round8(mul(parse(qty), parse(price))).toString();
  return { price, notional, fee: commission(notional, schedule), slippageBps };
}

const isWhole = (qty: string, step: string): boolean => {
  const s = parse(step);
  return div(parse(qty), s, 0, 'FLOOR').mul(s).equals(parse(qty));
};

/** True when the price moved against the user by MORE than the collar. Favourable moves are accepted. */
function priceMoved(input: MarketOrderInput, bid: string, ask: string): boolean {
  const collar = parse(input.collarPercent ?? EQUITY_COLLAR_PERCENT);
  const ref = parse(input.referencePrice);
  if (input.side === 'BUY') {
    // reject when ask > ref x (1 + collar/100)  <=>  ask x 100 > ref x (100 + collar)
    return compare(mul(parse(ask), HUNDRED), mul(ref, add(HUNDRED, collar))) > 0;
  }
  return compare(mul(parse(bid), HUNDRED), mul(ref, sub(HUNDRED, collar))) < 0;
}

/**
 * Decides a synchronous MARKET order. Rule order is documented at REJECT_RULE_ORDER. A non-positive or
 * unparsable quantity is malformed input, not an order: it throws EngineInputError (the HTTP layer rejects it).
 */
export function decideMarketOrder(input: MarketOrderInput): MarketOrderDecision {
  let qty;
  try {
    qty = parse(input.qty);
  } catch {
    throw new EngineInputError('qty must be a plain decimal string');
  }
  if (sign(qty) <= 0) throw new EngineInputError('qty must be positive');
  const reject = (code: RejectCode): MarketOrderDecision => ({ decision: 'REJECT', code });

  if (!input.account.tradingEnabled) return reject('TRADING_PAUSED');
  if (!input.account.active) return reject('ACCOUNT_NOT_ACTIVE');

  const status = input.instrument.status;
  if (
    !input.instrument.tradableIn.includes(MVP_TRADABLE_GATE) ||
    status === 'DELISTED' ||
    (input.side === 'BUY' && status === 'SELL_ONLY')
  ) {
    return reject('INSTRUMENT_NOT_TRADABLE');
  }
  if (status === 'HALTED') return reject('INSTRUMENT_HALTED');

  if (compare(qty, parse(input.instrument.minQty)) < 0) return reject('QTY_BELOW_MIN');
  if (!isWhole(input.qty, input.instrument.qtyStep)) return reject('QTY_STEP_VIOLATION');

  switch (input.freshness) {
    case 'UNAVAILABLE':
      return reject('NO_ELIGIBLE_QUOTE');
    case 'CLOSED':
      return reject('MARKET_CLOSED');
    case 'STALE':
      return reject('STALE_QUOTE');
    case 'DELAYED':
      if (!input.allowExecutionOnDelayed) return reject('NO_ELIGIBLE_QUOTE');
      break;
    case 'REAL_TIME':
      break;
  }
  if (input.quote === null) return reject('NO_ELIGIBLE_QUOTE');
  const { bid, ask } = input.quote;

  if (priceMoved(input, bid, ask)) return reject('PRICE_MOVED');

  const { price, notional, fee, slippageBps } = priceOrder(
    input.side,
    input.qty,
    { bid, ask },
    input.schedule,
    input.instrument.tickSize,
  );
  // M8: a BUY that costs nothing at 8 decimals (a few smallest units of a cheap coin) cannot become a lot with a cost
  if (input.side === 'BUY' && isZero(parse(notional))) return reject('QTY_BELOW_MIN');

  if (input.side === 'BUY') {
    if (compare(parse(input.cash), add(parse(notional), parse(fee))) < 0) {
      return reject('INSUFFICIENT_BUYING_POWER');
    }
  } else {
    if (compare(parse(input.positionQty), qty) < 0) return reject('INSUFFICIENT_POSITION');
    // D-57: a SELL whose fee is larger than its proceeds is a business reject, never a database error.
    if (compare(parse(fee), parse(notional)) > 0) return reject('FEE_EXCEEDS_PROCEEDS');
  }
  return { decision: 'FILL', price, notional, fee, slippageBps };
}

export interface MaxQtyInput {
  readonly side: OrderSide;
  readonly instrument: {
    readonly tickSize: string;
    readonly minQty: string;
    readonly qtyStep: string;
  };
  /** BUY needs the quote; SELL does not. */
  readonly quote: { readonly bid: string; readonly ask: string } | null;
  readonly schedule: FeeScheduleInput;
  readonly cash: string;
  readonly positionQty: string;
  /** The largest quantity one order may have (a validation limit of the API, not a reject). */
  readonly maxOrderQty: string;
}

/**
 * D-89: the largest quantity, rounded DOWN to the instrument's step, that an order could be filled with right now.
 *  - SELL: the position quantity (capped at maxOrderQty).
 *  - BUY: the largest q with cash >= notional(q) + fee(q), found by an exact binary search over multiples of the step on
 *    top of `priceOrder` (the same pricing as the decision; notional and fee never decrease with q, so the search is valid).
 * Returns "0" when nothing at or above the minimum quantity fits, and null when a BUY has no quote to price with.
 * It does not look at the market state (halted, closed, stale): the decision does, and rejects first.
 */
export function maxQty(input: MaxQtyInput): string | null {
  const step = parse(input.instrument.qtyStep);
  const minQty = parse(input.instrument.minQty);
  const cap = min(
    parse(input.maxOrderQty),
    parse(input.side === 'SELL' ? input.positionQty : input.maxOrderQty),
  );
  const stepsOf = (q: ReturnType<typeof parse>): ReturnType<typeof parse> =>
    div(q, step, 0, 'FLOOR');
  let hi = stepsOf(cap); // the most steps allowed by the cap
  if (input.side === 'BUY') {
    if (input.quote === null) return null;
    const quote = input.quote;
    const cash = parse(input.cash);
    const fits = (n: ReturnType<typeof parse>): boolean => {
      const p = priceOrder(
        'BUY',
        mul(n, step).toString(),
        quote,
        input.schedule,
        input.instrument.tickSize,
      );
      return compare(cash, add(parse(p.notional), parse(p.fee))) >= 0;
    };
    // binary search the largest n in [0, hi] that fits (n = 0 always fits)
    let lo = parse('0');
    while (compare(lo, hi) < 0) {
      const mid = div(add(add(lo, hi), parse('1')), parse('2'), 0, 'FLOOR');
      if (fits(mid)) lo = mid;
      else hi = sub(mid, parse('1'));
    }
    hi = lo;
  }
  const q = mul(hi, step);
  if (sign(q) <= 0 || compare(q, minQty) < 0) return '0';
  return q.toString();
}
