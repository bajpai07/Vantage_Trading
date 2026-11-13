// Portfolio valuation (M5; decisions D-60 and D-61). Pure: no IO, no clock, no randomness. All amounts are exact
// decimal strings. Nothing is rounded except marketValue (8 decimal places, HALF_EVEN, once per position);
// display rounding to 2 decimal places happens only at the API edge (`roundDisplay`).
import type { FreshnessState } from '@vantage/market-model';
import { add, mul, parse, round8, sign, sub } from '@vantage/money';

/** D-60: the bid is the mark for a long position (what you could sell at); `last` only when there is no bid. */
export type MarkBasis = 'BID' | 'LAST';

export interface MarkQuote {
  /** The bid, or null/absent when the quote has none. The ask is deliberately not an input: it is never a mark. */
  readonly bid?: string | null;
  readonly last?: string | null;
  /** The provider timestamp of the quote (an absolute instant). */
  readonly providerTs: Date;
  readonly source: string;
}

export interface PositionInput {
  readonly symbol: string;
  /** Open quantity (sum of the open lots). */
  readonly qty: string;
  /** Sum over open lots of qty_open x cost per unit (fees are not part of cost). */
  readonly costBasis: string;
  /** The accepted quote behind the mark, or null when there is none. */
  readonly quote: MarkQuote | null;
  /** From the shared market-model freshness function; UNAVAILABLE when there is no usable quote. */
  readonly freshness: FreshnessState;
}

export interface ValuedPosition {
  readonly valuation: 'VALUED';
  readonly symbol: string;
  readonly qty: string;
  readonly costBasis: string;
  readonly mark: string;
  readonly markBasis: MarkBasis;
  readonly marketValue: string;
  readonly unrealisedPnl: string;
  /** Never UNAVAILABLE here. STALE and CLOSED are valued and labelled; they are never shown as real time. */
  readonly freshness: Exclude<FreshnessState, 'UNAVAILABLE'>;
  readonly quoteAsOf: Date;
  readonly source: string;
}

export interface UnvaluedPosition {
  readonly valuation: 'UNAVAILABLE';
  readonly symbol: string;
  readonly qty: string;
  readonly costBasis: string;
  readonly freshness: FreshnessState;
  /** NO_QUOTE: no accepted quote or freshness UNAVAILABLE. NO_USABLE_PRICE: the quote has no positive bid or last. */
  readonly reason: 'NO_QUOTE' | 'NO_USABLE_PRICE';
}

export type PositionValuation = ValuedPosition | UnvaluedPosition;

const positive = (s: string | null | undefined): s is string => {
  if (s === null || s === undefined) return false;
  return sign(parse(s)) > 0;
};

/**
 * Values one long position at its mark. A position without a usable quote is UNAVAILABLE: it is never valued at
 * zero and never silently at cost.
 */
export function valuePosition(p: PositionInput): PositionValuation {
  const base = { symbol: p.symbol, qty: p.qty, costBasis: p.costBasis };
  if (p.quote === null || p.freshness === 'UNAVAILABLE') {
    return { valuation: 'UNAVAILABLE', ...base, freshness: 'UNAVAILABLE', reason: 'NO_QUOTE' };
  }
  let mark: string;
  let markBasis: MarkBasis;
  if (positive(p.quote.bid)) {
    mark = p.quote.bid;
    markBasis = 'BID';
  } else if (positive(p.quote.last)) {
    mark = p.quote.last;
    markBasis = 'LAST';
  } else {
    return { valuation: 'UNAVAILABLE', ...base, freshness: p.freshness, reason: 'NO_USABLE_PRICE' };
  }
  const marketValue = round8(mul(parse(p.qty), parse(mark)));
  return {
    valuation: 'VALUED',
    ...base,
    mark: parse(mark).toString(),
    markBasis,
    marketValue: marketValue.toString(),
    unrealisedPnl: sub(marketValue, parse(p.costBasis)).toString(),
    freshness: p.freshness,
    quoteAsOf: p.quote.providerTs,
    source: p.quote.source,
  };
}

export interface PortfolioInput {
  readonly cash: string;
  readonly positions: readonly PositionValuation[];
  /** Realised P&L = minus the REALIZED_PNL ledger balance (equals the sum of lot-closure trading P&L). */
  readonly realisedPnl: string;
  /** The FEES ledger balance. */
  readonly fees: string;
  /** The starting grant (10,000 for every account today). */
  readonly initialCapital: string;
}

export interface PortfolioSummary {
  readonly cash: string;
  /** Sum of marketValue over VALUED positions only. */
  readonly positionsValue: string;
  /** Sum of unrealisedPnl over VALUED positions only. */
  readonly unrealisedPnl: string;
  /** Cost basis of ALL open positions (valued or not): this one reconciles with the ledger POSITION_COST. */
  readonly costBasis: string;
  readonly valuedCostBasis: string;
  readonly unvaluedCostBasis: string;
  readonly unvaluedCount: number;
  /** D-61: cash + positionsValue (valued positions only). */
  readonly equity: string;
  /** True when at least one position is UNAVAILABLE: the totals then exclude it, explicitly. */
  readonly incomplete: boolean;
  /** equity - initialCapital, ONLY when every position is valued; otherwise null. */
  readonly totalReturn: string | null;
  readonly realisedPnl: string;
  readonly fees: string;
  /** The oldest provider timestamp among the quotes used; null when no position was valued. */
  readonly oldestQuoteAsOf: Date | null;
}

/** D-61. Sums are exact and order-independent; nothing is rounded here. */
export function summarisePortfolio(input: PortfolioInput): PortfolioSummary {
  let positionsValue = parse('0');
  let unrealised = parse('0');
  let valuedCost = parse('0');
  let unvaluedCost = parse('0');
  let unvaluedCount = 0;
  let oldest: Date | null = null;
  for (const p of input.positions) {
    if (p.valuation === 'VALUED') {
      positionsValue = add(positionsValue, parse(p.marketValue));
      unrealised = add(unrealised, parse(p.unrealisedPnl));
      valuedCost = add(valuedCost, parse(p.costBasis));
      if (oldest === null || p.quoteAsOf.getTime() < oldest.getTime()) oldest = p.quoteAsOf;
    } else {
      unvaluedCost = add(unvaluedCost, parse(p.costBasis));
      unvaluedCount += 1;
    }
  }
  const equity = add(parse(input.cash), positionsValue);
  const incomplete = unvaluedCount > 0;
  return {
    cash: parse(input.cash).toString(),
    positionsValue: positionsValue.toString(),
    unrealisedPnl: unrealised.toString(),
    costBasis: add(valuedCost, unvaluedCost).toString(),
    valuedCostBasis: valuedCost.toString(),
    unvaluedCostBasis: unvaluedCost.toString(),
    unvaluedCount,
    equity: equity.toString(),
    incomplete,
    totalReturn: incomplete ? null : sub(equity, parse(input.initialCapital)).toString(),
    realisedPnl: parse(input.realisedPnl).toString(),
    fees: parse(input.fees).toString(),
    oldestQuoteAsOf: oldest,
  };
}

/**
 * The ledger identity (I10 restated): cash + costBasis + fees - realisedPnl = initial capital (no reservations
 * exist yet). Returns the left-hand side; a correct set of books gives exactly the initial capital.
 */
export function capitalIdentity(v: {
  readonly cash: string;
  readonly costBasis: string;
  readonly fees: string;
  readonly realisedPnl: string;
}): string {
  return sub(
    add(add(parse(v.cash), parse(v.costBasis)), parse(v.fees)),
    parse(v.realisedPnl),
  ).toString();
}

/** Display rounding for the API edge only: 2 decimal places, HALF_EVEN, as a fixed-point string. */
export function roundDisplay(amount: string): string {
  return parse(amount).round(2, 'HALF_EVEN').toScaleString(2);
}
