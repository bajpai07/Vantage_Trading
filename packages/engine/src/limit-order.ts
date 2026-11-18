// LIMIT orders (M8b-1; decisions D-91 to D-97; TRADING_ENGINE sections 3, 4, 5.1, 6, 7). Pure: no IO, no clock, no
// randomness, no floats. Prices, quantities and amounts are decimal strings. Everything that prices an order goes through
// `priceOrder` of market-order.ts (with the limit as its cap): there is ONE pricing function for market orders, limit
// accepts, previews and the matcher.
import type { FreshnessState } from '@vantage/market-model';
import { add, compare, div, isZero, mul, parse, round8, sign, sub } from '@vantage/money';
import { EngineInputError } from './errors.js';
import {
  MVP_TRADABLE_GATE,
  commission,
  fillPrice,
  priceFromSlipped,
  priceOrder,
} from './market-order.js';
import type {
  FeeScheduleInput,
  MarketOrderInput,
  OrderSide,
  Pricing,
  RejectCode,
} from './market-order.js';

/** TIF values supported in the MVP (D-93). IOC and FOK are rejected at the HTTP layer. */
export type LimitTimeInForce = 'DAY' | 'GTC';

// ---- the reserve of a limit BUY (D-92) ----------------------------------------------------------------------------------

export interface LimitReserve {
  /** ceil8(qty x limit): the largest notional the order can ever have. */
  readonly maxNotional: string;
  /** commission(maxNotional): the largest fee the order can ever have (the commission never decreases with the notional). */
  readonly maxFee: string;
  /** R = maxNotional + maxFee. The cash held back when the order is accepted. */
  readonly reserve: string;
}

/**
 * D-92 (a clarification of TRADING_ENGINE section 6): a LIMIT BUY never fills above its limit, so no collar is applied:
 * R = ceil8(qty x limit + commission(qty x limit)), built from the same 8-decimal commission function as the fill.
 * Because the fill price is at most the limit, the actual notional C = round8(qty x price) <= round8(qty x limit) <=
 * maxNotional, and because the commission is monotone non-decreasing in the notional (a property test proves it) the
 * actual fee f <= maxFee, so C + f <= R always holds and a fill can never overspend.
 */
export function reserveForLimitBuy(
  qty: string,
  limitPrice: string,
  schedule: Pick<FeeScheduleInput, 'commissionBps' | 'commissionMinLocal'>,
): LimitReserve {
  const maxNotional = mul(parse(qty), parse(limitPrice)).round(8, 'CEIL');
  const maxFee = parse(commission(maxNotional.toString(), schedule));
  return {
    maxNotional: maxNotional.toString(),
    maxFee: maxFee.toString(),
    reserve: add(maxNotional, maxFee).toString(),
  };
}

export type FillResolution =
  | {
      readonly ok: true;
      /** R - C - f, what returns to CASH at the fill. */ readonly cashBack: string;
    }
  | { readonly ok: false };

/** The reserved case of a fill (TRADING_ENGINE 5.1): C + f <= R, else the fill is refused and the order left intact. */
export function fillResolution(reserved: string, notional: string, fee: string): FillResolution {
  const back = sub(parse(reserved), add(parse(notional), parse(fee)));
  return sign(back) < 0 ? { ok: false } : { ok: true, cashBack: back.toString() };
}

// ---- marketability ---------------------------------------------------------------------------------------------------------

/** BUY when ask <= limit; SELL when bid >= limit (TRADING_ENGINE section 4). */
export function isLimitMarketable(
  side: OrderSide,
  limitPrice: string,
  quote: { readonly bid: string; readonly ask: string },
): boolean {
  return side === 'BUY'
    ? compare(parse(quote.ask), parse(limitPrice)) <= 0
    : compare(parse(quote.bid), parse(limitPrice)) >= 0;
}

/** Is a quote with this freshness usable for evaluating orders? (TRADING_ENGINE section 3: STALE, CLOSED, UNAVAILABLE are not.) */
export function isEvaluable(freshness: FreshnessState, allowExecutionOnDelayed: boolean): boolean {
  return freshness === 'REAL_TIME' || (freshness === 'DELAYED' && allowExecutionOnDelayed);
}

/** The price, notional and fee of a limit fill against a quote: the one pricing function, capped by the limit. */
export function limitFillPricing(
  side: OrderSide,
  qty: string,
  limitPrice: string,
  quote: { readonly bid: string; readonly ask: string },
  schedule: FeeScheduleInput,
  tickSize: string,
): Pricing {
  return priceOrder(side, qty, quote, schedule, tickSize, limitPrice);
}

// ---- the decision at accept --------------------------------------------------------------------------------------------------

export interface LimitOrderInput {
  readonly side: OrderSide;
  readonly qty: string;
  readonly limitPrice: string;
  readonly instrument: MarketOrderInput['instrument'];
  /** The eligible quote, or null. A non-evaluable freshness makes the order rest instead of being evaluated. */
  readonly quote: { readonly bid: string; readonly ask: string } | null;
  readonly freshness: FreshnessState;
  readonly allowExecutionOnDelayed: boolean;
  readonly schedule: FeeScheduleInput;
  readonly account: MarketOrderInput['account'];
  /** The CASH balance: reservations are already removed from it (D-96, D-97). */
  readonly freeCash: string;
  /** positions.qty - positions.qty_reserved (D-96). */
  readonly freeQty: string;
}

export type LimitDecision =
  | {
      readonly decision: 'ACCEPT';
      /** BUY: R, held back from CASH. SELL: "0" (no cash moves). */
      readonly reserveUsd: string;
      /** SELL: the quantity reserved (positions.qty_reserved += qty). BUY: "0". */
      readonly reserveQty: string;
      /** The fill, when the order is marketable on the current eligible quote (D-97: filled in the same transaction). */
      readonly fill: Pricing | null;
    }
  | { readonly decision: 'REJECT'; readonly code: RejectCode };

const isMultiple = (value: string, step: string): boolean => {
  const s = parse(step);
  return div(parse(value), s, 0, 'FLOOR').mul(s).equals(parse(value));
};

/**
 * Decides a LIMIT order at accept. Rule order (first failure wins): TRADING_PAUSED, ACCOUNT_NOT_ACTIVE,
 * INSTRUMENT_NOT_TRADABLE, INSTRUMENT_HALTED, QTY_BELOW_MIN, QTY_STEP_VIOLATION, TICK_VIOLATION, then the funds: BUY needs
 * the reserve R in free CASH (INSUFFICIENT_BUYING_POWER), SELL needs the quantity in free quantity (INSUFFICIENT_POSITION).
 * Unlike a MARKET order there is no quote rule: a limit order on a STALE, CLOSED or UNAVAILABLE quote is accepted and rests
 * (it is just not evaluated, D-97). When the quote is evaluable and the order is marketable the decision carries the fill.
 * A BUY whose largest possible cost rounds to 0 at 8 decimals is rejected as QTY_BELOW_MIN, like a market BUY.
 */
export function decideLimitOrder(input: LimitOrderInput): LimitDecision {
  let qty;
  let limit;
  try {
    qty = parse(input.qty);
    limit = parse(input.limitPrice);
  } catch {
    throw new EngineInputError('qty and limitPrice must be plain decimal strings');
  }
  if (sign(qty) <= 0) throw new EngineInputError('qty must be positive');
  if (sign(limit) <= 0) throw new EngineInputError('limitPrice must be positive');
  const reject = (code: RejectCode): LimitDecision => ({ decision: 'REJECT', code });

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
  if (!isMultiple(input.qty, input.instrument.qtyStep)) return reject('QTY_STEP_VIOLATION');
  if (!isMultiple(input.limitPrice, input.instrument.tickSize)) return reject('TICK_VIOLATION');

  const reserve =
    input.side === 'BUY' ? reserveForLimitBuy(input.qty, input.limitPrice, input.schedule) : null;
  if (input.side === 'BUY') {
    if (isZero(round8(mul(qty, limit)))) return reject('QTY_BELOW_MIN'); // no lot can have a zero cost
    if (compare(parse(input.freeCash), parse(reserve?.reserve ?? '0')) < 0) {
      return reject('INSUFFICIENT_BUYING_POWER');
    }
  } else if (compare(parse(input.freeQty), qty) < 0) {
    return reject('INSUFFICIENT_POSITION');
  }

  let fill: Pricing | null = null;
  if (
    input.quote !== null &&
    isEvaluable(input.freshness, input.allowExecutionOnDelayed) &&
    isLimitMarketable(input.side, input.limitPrice, input.quote)
  ) {
    fill = limitFillPricing(
      input.side,
      input.qty,
      input.limitPrice,
      input.quote,
      input.schedule,
      input.instrument.tickSize,
    );
    if (input.side === 'SELL' && compare(parse(fill.fee), parse(fill.notional)) > 0) {
      return reject('FEE_EXCEEDS_PROCEEDS');
    }
    if (
      input.side === 'BUY' &&
      !fillResolution(reserve?.reserve ?? '0', fill.notional, fill.fee).ok
    ) {
      // unreachable by construction (D-92); refused rather than overspent
      throw new EngineInputError('a limit BUY fill would exceed its reserve');
    }
  }
  return {
    decision: 'ACCEPT',
    reserveUsd: reserve?.reserve ?? '0',
    reserveQty: input.side === 'SELL' ? input.qty : '0',
    fill,
  };
}

// ---- the largest limit quantity (D-90 for limits) ----------------------------------------------------------------------------

export interface LimitMaxQtyInput {
  readonly side: OrderSide;
  readonly limitPrice: string;
  readonly instrument: { readonly minQty: string; readonly qtyStep: string };
  readonly schedule: Pick<FeeScheduleInput, 'commissionBps' | 'commissionMinLocal'>;
  readonly freeCash: string;
  readonly freeQty: string;
  readonly maxOrderQty: string;
}

/**
 * The largest quantity, rounded DOWN to the step, that a LIMIT order could be accepted with: BUY, the largest q whose RESERVE
 * fits the free cash (an exact binary search over multiples of the step on top of `reserveForLimitBuy`, which never decreases
 * with q); SELL, the free quantity. "0" when not even the minimum fits.
 */
export function limitMaxQty(input: LimitMaxQtyInput): string {
  const step = parse(input.instrument.qtyStep);
  const cap = parse(input.maxOrderQty);
  const stepsOf = (q: ReturnType<typeof parse>): ReturnType<typeof parse> =>
    div(q, step, 0, 'FLOOR');
  let hi = stepsOf(
    input.side === 'SELL'
      ? compare(parse(input.freeQty), cap) < 0
        ? parse(input.freeQty)
        : cap
      : cap,
  );
  if (input.side === 'BUY') {
    const cash = parse(input.freeCash);
    const fits = (n: ReturnType<typeof parse>): boolean => {
      const q = mul(n, step).toString();
      return (
        compare(cash, parse(reserveForLimitBuy(q, input.limitPrice, input.schedule).reserve)) >= 0
      );
    };
    let lo = parse('0');
    while (compare(lo, hi) < 0) {
      const mid = div(add(add(lo, hi), parse('1')), parse('2'), 0, 'FLOOR');
      if (fits(mid)) lo = mid;
      else hi = sub(mid, parse('1'));
    }
    hi = lo;
  }
  const q = mul(hi, step);
  if (sign(q) <= 0 || compare(q, parse(input.instrument.minQty)) < 0) return '0';
  // a BUY whose largest cost rounds to 0 would be rejected as too small
  if (input.side === 'BUY' && isZero(round8(mul(q, parse(input.limitPrice))))) return '0';
  return q.toString();
}

// ---- expiry (D-94) --------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export interface ExpiryInput {
  readonly tif: LimitTimeInForce;
  readonly now: Date;
  /** GTC lifetime in whole days (config GTC_EXPIRY_DAYS, default 90). */
  readonly gtcDays: number;
  /** true for an instrument with no session (crypto, and stocks in the simulated 24/7 session). */
  readonly continuous: boolean;
  /** The next session close after `now` (the close of the current session while open), or null when unknown. */
  readonly nextSessionClose: Date | null;
}

/**
 * D-94. GTC: now + gtcDays. DAY for a stock or ETF: the next session close (the current one while the market is open, else
 * the next session's). DAY for crypto (no session): the next 00:00 UTC strictly after now, an illustrative rule. A stock whose
 * calendar gives no next close (beyond its coverage) falls back to the same 00:00 UTC rule rather than guessing a session.
 */
export function expiresAt(input: ExpiryInput): Date {
  const t = input.now.getTime();
  if (input.tif === 'GTC') return new Date(t + input.gtcDays * DAY_MS);
  if (!input.continuous && input.nextSessionClose !== null) return input.nextSessionClose;
  return new Date(t - (t % DAY_MS) + DAY_MS);
}

// ---- evaluating the open orders of one instrument -------------------------------------------------------------------------------

export interface OpenLimitOrder {
  readonly id: string;
  readonly createdAt: Date;
  readonly side: OrderSide;
  readonly qty: string;
  readonly limitPrice: string;
  /** The stored reserved_usd (BUY); "0" for a SELL. */
  readonly reservedUsd: string;
}

export interface OrderFill {
  readonly orderId: string;
  readonly pricing: Pricing;
}

export interface Evaluation {
  /** The orders to fill, in created_at, id order, at most one per order. */
  readonly fills: OrderFill[];
  /** Marketable BUYs whose fill would exceed their reserve: refused, left intact (unreachable by construction, D-92). */
  readonly refused: string[];
}

/**
 * TRADING_ENGINE section 4 "Triggering and ordering": the open orders of an instrument against ONE eligible quote, in
 * created_at, id order, at most one fill per order. A quote that is not evaluable (STALE, CLOSED, UNAVAILABLE, or DELAYED while
 * delayed execution is off) evaluates nothing: the orders rest, and when a quote returns it is the new quote that is evaluated
 * (there is no back-filling at an old price, because only the quote passed here is ever looked at).
 */
export function evaluateOpenOrders(
  quote: { readonly bid: string; readonly ask: string } | null,
  freshness: FreshnessState,
  allowExecutionOnDelayed: boolean,
  orders: readonly OpenLimitOrder[],
  schedule: FeeScheduleInput,
  tickSize: string,
): Evaluation {
  if (quote === null || !isEvaluable(freshness, allowExecutionOnDelayed))
    return { fills: [], refused: [] };
  const ordered = [...orders].sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const fills: OrderFill[] = [];
  const refused: string[] = [];
  // the slippage-adjusted price depends only on the side and the quote: compute it once per side, then price each order
  // with the same function limitFillPricing uses (priceFromSlipped)
  const slipped: { BUY?: string; SELL?: string } = {};
  const ask = parse(quote.ask); // parsed once for the whole batch
  const bid = parse(quote.bid);
  for (const o of ordered) {
    // the same rule as isLimitMarketable, with the quote already parsed
    const limit = parse(o.limitPrice);
    if (o.side === 'BUY' ? compare(ask, limit) > 0 : compare(bid, limit) < 0) continue;
    const s = (slipped[o.side] ??= fillPrice(
      o.side,
      quote.bid,
      quote.ask,
      schedule.slippageBaseBps,
      tickSize,
    ));
    const pricing = priceFromSlipped(o.side, o.qty, s, schedule, o.limitPrice);
    if (o.side === 'BUY' && !fillResolution(o.reservedUsd, pricing.notional, pricing.fee).ok) {
      refused.push(o.id);
      continue;
    }
    fills.push({ orderId: o.id, pricing });
  }
  return { fills, refused };
}
