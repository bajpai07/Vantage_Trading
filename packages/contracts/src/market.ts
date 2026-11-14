// Market data, instrument and watchlist contracts. All prices are canonical decimal strings.
// A quote is never a bare price: it always carries `source` and `freshness`.
import { z } from 'zod';
import { MoneyString } from './money-string.js';

export const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;

export const SymbolSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(SYMBOL_PATTERN, 'must be a ticker symbol'));

export const AssetClass = z.enum(['EQUITY', 'ETF', 'CRYPTO', 'INDEX', 'FX', 'COMMODITY']);
export const InstrumentStatus = z.enum(['ACTIVE', 'HALTED', 'SELL_ONLY', 'DELISTED']);
export const Entitlement = z.enum(['REAL_TIME', 'DELAYED']);
export const FreshnessState = z.enum(['REAL_TIME', 'DELAYED', 'STALE', 'CLOSED', 'UNAVAILABLE']);

// ---- instruments -----------------------------------------------------------------------------------

export const SearchQuery = z.strictObject({ q: z.string().trim().min(1).max(40) });
export type SearchQuery = z.output<typeof SearchQuery>;

export const InstrumentItem = z.strictObject({
  symbol: z.string(),
  name: z.string(),
  assetClass: AssetClass,
  /** Market identifier code, e.g. XNAS. */
  exchange: z.string(),
  currency: z.string().length(3),
  status: InstrumentStatus,
  tickSize: MoneyString,
  /** What the active data feed entitles us to show for this instrument. */
  entitlement: Entitlement,
  delaySeconds: z.number().int().min(0),
  /** Label of the active data source, e.g. SIM. */
  source: z.string().min(1),
  /** false when orders cannot be placed for this instrument yet (for example crypto before M8): prices only. */
  tradable: z.boolean(),
});
export type InstrumentItem = z.output<typeof InstrumentItem>;

export const SearchResponse = z.strictObject({ results: z.array(InstrumentItem).max(20) });
export type SearchResponse = z.output<typeof SearchResponse>;

// ---- quotes ----------------------------------------------------------------------------------------

export const QuotesQuery = z.strictObject({
  symbols: z
    .string()
    .min(1)
    .max(1000)
    .transform((s) => [...new Set(s.split(',').map((p) => p.trim().toUpperCase()))])
    .pipe(z.array(z.string().regex(SYMBOL_PATTERN, 'must be a ticker symbol')).min(1).max(50)),
});
export type QuotesQuery = z.output<typeof QuotesQuery>;

/**
 * The day change of a quote (M7b, D-82), computed by the server from exact decimals: the browser does no arithmetic.
 * PREV_SESSION_CLOSE: the close of the previous regular session (stocks on the real calendar). ROLLING_24H: the price 24
 * hours ago (crypto, and stocks in the simulated 24/7 session). Every field is null when there is no prior data: a missing
 * reference is never shown as 0.
 */
export const CHANGE_BASES = ['PREV_SESSION_CLOSE', 'ROLLING_24H'] as const;
export const ChangeBasis = z.enum(CHANGE_BASES);
export type ChangeBasis = z.output<typeof ChangeBasis>;
export const changeFields = {
  /** The reference price: the previous close, or the price 24 hours ago. */
  prevClose: MoneyString.nullable().optional(),
  /** last minus prevClose, exact. */
  change: MoneyString.nullable().optional(),
  /** change / prevClose x 100, rounded to 2 decimal places (half to even). Always has two decimals. */
  changePct: z
    .string()
    .regex(/^-?\d+\.\d{2}$/, 'must be a decimal with two places')
    .nullable()
    .optional(),
  changeBasis: ChangeBasis.nullable().optional(),
  /** Which price the change is measured from: the last trade, or (only when there is none) the mid of bid and ask. */
  changeOf: z.enum(['LAST', 'MID']).nullable().optional(),
};

export const QuoteItem = z
  .strictObject({
    symbol: z.string(),
    /** false when the symbol is not in the instrument master. */
    known: z.boolean(),
    freshness: FreshnessState,
    /** Label of the data source the answer is about (FIXTURE in local/test). Always present. */
    source: z.string().min(1),
    entitlement: Entitlement,
    delaySeconds: z.number().int().min(0),
    ageSeconds: z.number().int().min(0).nullable(),
    /** Provider timestamp of the quote shown; null when there is no quote. */
    asOf: z.iso.datetime().nullable(),
    bid: MoneyString.optional(),
    ask: MoneyString.optional(),
    last: MoneyString.optional(),
    /** ask minus bid, computed by the server (the browser does no money arithmetic). Present with bid and ask. */
    spread: MoneyString.optional(),
    ...changeFields,
    gapConfirmed: z.literal(true).optional(),
  })
  .refine(
    (q) =>
      q.freshness !== 'UNAVAILABLE' ||
      (q.bid === undefined &&
        q.ask === undefined &&
        q.last === undefined &&
        q.spread === undefined &&
        q.prevClose === undefined &&
        q.change === undefined &&
        q.changePct === undefined &&
        q.changeBasis === undefined &&
        q.changeOf === undefined),
    'an UNAVAILABLE quote must carry no price',
  );
export type QuoteItem = z.output<typeof QuoteItem>;

export const QuotesResponse = z.strictObject({ quotes: z.array(QuoteItem).min(1).max(50) });
export type QuotesResponse = z.output<typeof QuotesResponse>;

// ---- candles (M7b, D-79 to D-81) ----------------------------------------------------------------------

export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export const CandleInterval = z.enum(CANDLE_INTERVALS);
export type CandleInterval = z.output<typeof CandleInterval>;

/** Most candles in one answer; the default when `limit` is not given is 200. */
export const MAX_CANDLES_PER_REQUEST = 500;
export const DEFAULT_CANDLES_PER_REQUEST = 200;

const isoInstant = z.iso.datetime({
  message: 'must be an ISO 8601 instant in UTC, for example 2026-11-10T15:00:00Z',
});

/**
 * GET /v1/market/candles. `from` and `to` bound the OPEN TIME of a candle (inclusive); nothing after "now" is ever served.
 * Without them the answer is the latest `limit` candles ending now.
 */
export const CandlesQuery = z
  .strictObject({
    symbol: SymbolSchema,
    interval: CandleInterval,
    from: isoInstant.optional(),
    to: isoInstant.optional(),
    limit: z
      .string()
      .regex(/^[0-9]{1,4}$/, 'must be a whole number')
      .transform(Number)
      .pipe(z.number().int().min(1).max(MAX_CANDLES_PER_REQUEST))
      .optional(),
  })
  .refine(
    (q) => q.from === undefined || q.to === undefined || Date.parse(q.from) <= Date.parse(q.to),
    {
      message: 'from must not be after to',
      path: ['from'],
    },
  );
export type CandlesQuery = z.output<typeof CandlesQuery>;

/** One candle. Prices and volume are decimal strings; `t` is the open time. `closed: false` marks the forming candle. */
export const CandleItem = z.strictObject({
  t: z.iso.datetime(),
  o: MoneyString,
  h: MoneyString,
  l: MoneyString,
  c: MoneyString,
  /** Volume: synthetic for simulated data (see `synthetic`). */
  v: z.string().regex(/^[0-9]+(\.[0-9]+)?$/, 'must be a decimal string'),
  closed: z.boolean(),
});
export type CandleItem = z.output<typeof CandleItem>;

export const CandlesResponse = z.strictObject({
  symbol: z.string(),
  interval: CandleInterval,
  /** The label of the data behind the candles (SIM). A candle answer is never served without one. */
  source: z.string().min(1),
  /** true: the candles and their volume are simulated, not market data. */
  synthetic: z.boolean(),
  /** true when more candles matched than `limit`: the NEWEST `limit` are returned. */
  truncated: z.boolean(),
  /** Ascending by open time. */
  candles: z.array(CandleItem).max(MAX_CANDLES_PER_REQUEST),
});
export type CandlesResponse = z.output<typeof CandlesResponse>;

// ---- market status ---------------------------------------------------------------------------------

export const MarketStatusItem = z.strictObject({
  exchange: z.string(),
  name: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  session: z.enum(['REGULAR', 'EARLY_CLOSE']).nullable(),
  reason: z
    .enum(['WEEKEND', 'HOLIDAY', 'BEFORE_OPEN', 'AFTER_CLOSE', 'CALENDAR_NOT_COVERED'])
    .nullable(),
  note: z.string().nullable(),
  localDate: z.string(),
  nextOpen: z.iso.datetime().nullable(),
  nextClose: z.iso.datetime().nullable(),
});
export const MarketStatusResponse = z.strictObject({
  asOf: z.iso.datetime(),
  exchanges: z.array(MarketStatusItem),
});
export type MarketStatusResponse = z.output<typeof MarketStatusResponse>;

// ---- watchlists ------------------------------------------------------------------------------------

export const WATCHLIST_LIMITS = { listsPerUser: 20, itemsPerList: 100, nameMax: 40 } as const;

const watchlistName = z.string().trim().min(1).max(WATCHLIST_LIMITS.nameMax);

export const CreateWatchlistRequest = z.strictObject({ name: watchlistName });
export const UpdateWatchlistRequest = z
  .strictObject({
    name: watchlistName.optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => v.name !== undefined || v.position !== undefined, 'provide a name or a position');
export const AddWatchlistItemRequest = z.strictObject({ symbol: SymbolSchema });
export const ReorderWatchlistItemsRequest = z.strictObject({
  symbols: z.array(SymbolSchema).min(1).max(WATCHLIST_LIMITS.itemsPerList),
});

export const WatchlistItem = z.strictObject({ symbol: z.string(), position: z.number().int() });
export const Watchlist = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  position: z.number().int(),
  items: z.array(WatchlistItem),
});
export const WatchlistsResponse = z.strictObject({ watchlists: z.array(Watchlist) });
export type Watchlist = z.output<typeof Watchlist>;
export type WatchlistsResponse = z.output<typeof WatchlistsResponse>;
export type CreateWatchlistRequest = z.output<typeof CreateWatchlistRequest>;
export type UpdateWatchlistRequest = z.output<typeof UpdateWatchlistRequest>;
export type AddWatchlistItemRequest = z.output<typeof AddWatchlistItemRequest>;
export type ReorderWatchlistItemsRequest = z.output<typeof ReorderWatchlistItemsRequest>;

// ---- data feed (public) ---------------------------------------------------------------------------------

/**
 * GET /v1/market/feed (no session needed): which market data source is active, so a client can say so honestly
 * (for example the "Simulated market data" banner while the source is FIXTURE). Carries no user data.
 */
/** M7a (D-75): how one asset class is being fed, in words the banner can show. */
export const FEED_MODES = ['LIVE', 'SIMULATED', 'FIXTURE'] as const;
export const FEED_SESSIONS = ['NYSE', 'ALWAYS_OPEN', '24_7'] as const;
export const FEED_STATUSES = ['CONNECTED', 'DISCONNECTED', 'OFF'] as const;
export const FeedSource = z.strictObject({
  assetClass: AssetClass,
  /** The label every quote of this class carries (SIM, FIXTURE, or an exchange name for a live feed). */
  source: z.string().min(1),
  /** A human label, for example "Simulated market data". */
  label: z.string().min(1),
  mode: z.enum(FEED_MODES),
  /** NYSE: the real exchange calendar. ALWAYS_OPEN: a simulated stock session that never closes. 24_7: crypto. */
  session: z.enum(FEED_SESSIONS),
  /** CONNECTED: the feed published recently. DISCONNECTED: it did not. OFF: switched off. */
  status: z.enum(FEED_STATUSES),
  /** When the feed last published a quote for this class (null if it never has). */
  lastMessageAt: z.iso.datetime().nullable(),
});
export type FeedSource = z.output<typeof FeedSource>;

export const FeedInfoResponse = z.strictObject({
  /** Label of the main (stock) data source, e.g. SIM. Kept for older clients; see `sources` for every class. */
  source: z.string().min(1),
  entitlement: Entitlement,
  delaySeconds: z.number().int().min(0),
  /** false when the feed kill switch is on: quotes are then UNAVAILABLE. */
  enabled: z.boolean(),
  /** D-77: this is a demo with virtual money (the API was started with DEMO_MODE=true). */
  demoMode: z.boolean(),
  /** One entry per asset class the API serves, each with its own truthful label and status. */
  sources: z.array(FeedSource).max(10),
});
export type FeedInfoResponse = z.output<typeof FeedInfoResponse>;
