// Market order decisions (TRADING_ENGINE sections 3, 4, 6, 7; decisions D-30, D-33, D-39, D-51, D-52, D-54).
// Pure: no IO, no clock, no randomness. Prices and quantities are decimal strings.
import type { FreshnessState, InstrumentStatus } from '@vantage/market-model';
import {
  add,
  compare,
  div,
  max,
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
 * 6 QTY_STEP_VIOLATION      (whole shares: fractions violate a step of 1)
 * 7 quote eligibility       UNAVAILABLE -> NO_ELIGIBLE_QUOTE, CLOSED -> MARKET_CLOSED, STALE -> STALE_QUOTE,
 *                           DELAYED while allowExecutionOnDelayed is false -> NO_ELIGIBLE_QUOTE
 * 8 PRICE_MOVED             the price moved against the user by more than the collar (D-51)
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

export interface FeeScheduleInput {
  readonly commissionBps: string;
  readonly commissionMinLocal: string;
  readonly slippageBaseBps: string;
  /** Always 0 in v1: there is no ADV data, so only the base slippage applies. */
  readonly slippageSizeCoef: string;
}

export interface MarketOrderInput {
  readonly side: OrderSide;
  /** Whole-share quantity as a decimal string. */
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

  const slippageBps = input.schedule.slippageBaseBps; // the size term is 0: no ADV data (D-54)
  const price = fillPrice(input.side, bid, ask, slippageBps, input.instrument.tickSize);
  const notional = round8(mul(qty, parse(price))).toString();
  const fee = commission(notional, input.schedule);

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
