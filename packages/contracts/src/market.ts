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
  /** Label of the active data source, e.g. FIXTURE. */
  source: z.string().min(1),
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
    gapConfirmed: z.literal(true).optional(),
  })
  .refine(
    (q) =>
      q.freshness !== 'UNAVAILABLE' ||
      (q.bid === undefined && q.ask === undefined && q.last === undefined),
    'an UNAVAILABLE quote must carry no price',
  );
export type QuoteItem = z.output<typeof QuoteItem>;

export const QuotesResponse = z.strictObject({ quotes: z.array(QuoteItem).min(1).max(50) });
export type QuotesResponse = z.output<typeof QuotesResponse>;

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
export const FeedInfoResponse = z.strictObject({
  /** Label of the active data source, e.g. FIXTURE. */
  source: z.string().min(1),
  entitlement: Entitlement,
  delaySeconds: z.number().int().min(0),
  /** false when the feed kill switch is on: quotes are then UNAVAILABLE. */
  enabled: z.boolean(),
});
export type FeedInfoResponse = z.output<typeof FeedInfoResponse>;
