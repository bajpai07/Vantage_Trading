// The ONE freshness function (TRADING_ENGINE section 3, MARKET_DATA section 7). The API, the engine and
// any later gateway must call this and nothing else to decide what a quote is.
import type { AssetClassKind, FreshnessResult, InstrumentStatus, Quote } from './types.js';

/** A REAL_TIME quote older than this is STALE (equities and ETFs). */
export const REAL_TIME_MAX_AGE_SECONDS: Readonly<Record<AssetClassKind, number>> = {
  EQUITY: 5,
  ETF: 5,
  CRYPTO: 3,
};
/** A DELAYED quote is fresh while (age - declared delay) is at most this. */
export const DELAYED_TOLERANCE_SECONDS = 60;

export interface CalendarStateLike {
  readonly state: 'OPEN' | 'CLOSED';
}

export interface FreshnessOptions {
  readonly assetClass?: AssetClassKind;
  /** false means the feed is disabled (kill switch): the answer is UNAVAILABLE. Default true. */
  readonly feedEnabled?: boolean;
}

const MS = 1000;

/**
 * Order of evaluation:
 * 1. UNAVAILABLE: no valid quote ever, the feed is disabled, or the instrument is DELISTED.
 * 2. CLOSED: the calendar says the market is closed (the quote is the last close).
 * 3. REAL_TIME / DELAYED by entitlement and age (boundaries are inclusive); otherwise STALE.
 *
 * `instrumentStatus` only matters for DELISTED (there is nothing to quote). HALTED and SELL_ONLY
 * instruments keep their quote; a halted quote simply goes STALE as it ages. Eligibility rules that
 * depend on status (e.g. block buys on SELL_ONLY) belong to the trading engine, not here.
 */
export function freshness(
  quote: Quote | null,
  instrumentStatus: InstrumentStatus,
  calendarState: CalendarStateLike,
  now: Date,
  options: FreshnessOptions = {},
): FreshnessResult {
  if (quote === null || options.feedEnabled === false || instrumentStatus === 'DELISTED') {
    return { state: 'UNAVAILABLE', ageSeconds: null };
  }
  const rawAgeMs = now.getTime() - quote.providerTs.getTime();
  const ageMs = rawAgeMs < 0 ? 0 : rawAgeMs;
  const ageSeconds = (ageMs - (ageMs % MS)) / MS;

  if (calendarState.state === 'CLOSED') return { state: 'CLOSED', ageSeconds };

  if (quote.entitlement === 'REAL_TIME') {
    const limit = REAL_TIME_MAX_AGE_SECONDS[options.assetClass ?? 'EQUITY'] * MS;
    return { state: ageMs <= limit ? 'REAL_TIME' : 'STALE', ageSeconds };
  }
  const effectiveMs = ageMs - quote.delaySeconds * MS; // may be negative: fresher than declared
  return {
    state: effectiveMs <= DELAYED_TOLERANCE_SECONDS * MS ? 'DELAYED' : 'STALE',
    ageSeconds,
  };
}
