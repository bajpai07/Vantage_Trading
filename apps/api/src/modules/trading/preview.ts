// Order preview (D-70): the same decision the real order will make, on a plain read of the current state. Pure: no
// database, no clock. It is ADVISORY: the real order re-decides under its locks, against the quote of that moment.
import { commission, fillPrice, maxQty } from '@vantage/engine';
import type { RejectCode } from '@vantage/engine';
import { add, mul, parse, round8, sub } from '@vantage/money';
import { decideForCommand } from './execute-market-order.js';
import type { DecisionState, MarketOrderCommand } from './execute-market-order.js';

/**
 * A reject at or after the price check still has a meaningful estimate (what the order WOULD have cost), which the
 * ticket shows next to the reason ("you need 1,919.04 and have 1,500.00"). An earlier reject (paused, halted, closed,
 * stale, no quote, bad quantity) has no honest estimate: the quote is not usable or the order is not valid.
 */
const ESTIMATE_AFTER_REJECT: ReadonlySet<RejectCode> = new Set([
  'PRICE_MOVED',
  'INSUFFICIENT_BUYING_POWER',
  'INSUFFICIENT_POSITION',
  'FEE_EXCEEDS_PROCEEDS',
]);

export interface PreviewEstimate {
  /** Fill price per share after slippage, rounded to the tick. */
  readonly price: string;
  /** round8(qty x price). */
  readonly notional: string;
  readonly fee: string;
  readonly slippageBps: string;
  /** CASH after the order (BUY: minus notional and fee; SELL: plus proceeds). Can be negative for a BUY that cannot be paid. */
  readonly cashAfter: string;
  /** SELL only: notional minus fee. */
  readonly proceeds: string | null;
}

export interface PreviewOutcome {
  readonly wouldFill: boolean;
  readonly rejectCode: RejectCode | null;
  readonly estimate: PreviewEstimate | null;
}

/**
 * D-90: the largest quantity the account could order right now (see the engine's maxQty). The engine computes the
 * candidate with the SAME pricing as the decision; the decision is then asked about it, so a quantity is only offered
 * when the real rules would fill it (a halted instrument, a stale quote or a paused platform give null).
 */
export function previewMaxQty(
  cmd: MarketOrderCommand,
  state: DecisionState,
  maxOrderQty: string,
): string | null {
  const q = maxQty({
    side: cmd.side,
    instrument: cmd.instrument,
    quote: cmd.quote === null ? null : { bid: cmd.quote.bid, ask: cmd.quote.ask },
    schedule: cmd.feeSchedule,
    cash: state.cash,
    positionQty: state.positionQty,
    maxOrderQty,
  });
  if (q === null || q === '0') return q;
  return decideForCommand({ ...cmd, qty: q }, state).decision === 'FILL' ? q : null;
}

export function previewMarketOrder(cmd: MarketOrderCommand, state: DecisionState): PreviewOutcome {
  const decision = decideForCommand(cmd, state);
  let figures: { price: string; notional: string; fee: string; slippageBps: string } | null = null;
  if (decision.decision === 'FILL') {
    figures = {
      price: decision.price,
      notional: decision.notional,
      fee: decision.fee,
      slippageBps: decision.slippageBps,
    };
  } else if (ESTIMATE_AFTER_REJECT.has(decision.code) && cmd.quote !== null) {
    // the same formulas as the real fill (engine fillPrice and commission), because the decision stopped before them
    const slippageBps = cmd.feeSchedule.slippageBaseBps;
    const price = fillPrice(
      cmd.side,
      cmd.quote.bid,
      cmd.quote.ask,
      slippageBps,
      cmd.instrument.tickSize,
    );
    const notional = round8(mul(parse(cmd.qty), parse(price))).toString();
    figures = { price, notional, fee: commission(notional, cmd.feeSchedule), slippageBps };
  }
  if (figures === null) {
    return {
      wouldFill: false,
      rejectCode: decision.decision === 'REJECT' ? decision.code : null,
      estimate: null,
    };
  }
  const notional = parse(figures.notional);
  const fee = parse(figures.fee);
  const cash = parse(state.cash);
  const sell = cmd.side === 'SELL';
  return {
    wouldFill: decision.decision === 'FILL',
    rejectCode: decision.decision === 'REJECT' ? decision.code : null,
    estimate: {
      ...figures,
      cashAfter: (sell ? add(cash, sub(notional, fee)) : sub(cash, add(notional, fee))).toString(),
      proceeds: sell ? sub(notional, fee).toString() : null,
    },
  };
}
