// Pure types for the market model. Prices and sizes are decimal STRINGS (handled with @vantage/money).
// Time is always an argument: nothing in this package reads a clock.

export type Entitlement = 'REAL_TIME' | 'DELAYED';
export type FreshnessState = 'REAL_TIME' | 'DELAYED' | 'STALE' | 'CLOSED' | 'UNAVAILABLE';
export type InstrumentStatus = 'ACTIVE' | 'HALTED' | 'SELL_ONLY' | 'DELISTED';
export type AssetClassKind = 'EQUITY' | 'ETF' | 'CRYPTO';

/** A quote as a provider adapter hands it over, before validation. */
export interface RawQuote {
  readonly symbol: string;
  readonly bid: string;
  readonly ask: string;
  readonly last?: string;
  readonly bidSize?: string;
  readonly askSize?: string;
  readonly lastSize?: string;
  /** The provider's own timestamp, already normalised to an absolute instant (UTC). */
  readonly providerTs: Date;
  readonly receivedAt: Date;
  /** Where the quote came from, e.g. FIXTURE. Never blank. */
  readonly source: string;
  readonly entitlement: Entitlement;
  /** Declared vendor delay in seconds (0 for real time). */
  readonly delaySeconds: number;
}

/** A quote that passed validation. */
export interface Quote extends RawQuote {
  /** True when an outlier price was accepted because a second consecutive tick confirmed it. */
  readonly gapConfirmed?: boolean;
}

export interface FreshnessResult {
  readonly state: FreshnessState;
  /** Whole seconds since the provider timestamp (never negative); null when there is no quote. */
  readonly ageSeconds: number | null;
}
