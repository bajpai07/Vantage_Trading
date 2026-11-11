import { describe, expect, it } from 'vitest';
import {
  AddWatchlistItemRequest,
  CreateWatchlistRequest,
  InstrumentItem,
  MarketStatusResponse,
  QuoteItem,
  QuotesQuery,
  ReorderWatchlistItemsRequest,
  SearchQuery,
  SymbolSchema,
  UpdateWatchlistRequest,
} from './index.js';

const quote = {
  symbol: 'AAPL',
  known: true,
  freshness: 'DELAYED',
  source: 'FIXTURE',
  entitlement: 'DELAYED',
  delaySeconds: 900,
  ageSeconds: 900,
  asOf: '2026-11-10T14:45:00.000Z',
  bid: '11.11',
  ask: '11.13',
};

describe('QuoteItem', () => {
  it('accepts a labelled quote with string prices (control)', () => {
    expect(QuoteItem.safeParse(quote).success).toBe(true);
  });
  it('rejects numeric or non-canonical prices', () => {
    expect(QuoteItem.safeParse({ ...quote, bid: 11.11 }).success).toBe(false);
    expect(QuoteItem.safeParse({ ...quote, bid: '11' }).success).toBe(false);
    expect(QuoteItem.safeParse({ ...quote, bid: '1e1' }).success).toBe(false);
  });
  it('requires a source and a freshness (no bare price)', () => {
    const noSource: Record<string, unknown> = { ...quote };
    delete noSource.source;
    const noFreshness: Record<string, unknown> = { ...quote };
    delete noFreshness.freshness;
    expect(QuoteItem.safeParse(noSource).success).toBe(false);
    expect(QuoteItem.safeParse(noFreshness).success).toBe(false);
    expect(QuoteItem.safeParse({ ...quote, source: '' }).success).toBe(false);
  });
  it('an UNAVAILABLE quote must carry no price (control: without prices it is fine)', () => {
    const unavailable = { ...quote, freshness: 'UNAVAILABLE', ageSeconds: null, asOf: null };
    expect(QuoteItem.safeParse(unavailable).success).toBe(false);
    const bare: Record<string, unknown> = { ...unavailable };
    delete bare.bid;
    delete bare.ask;
    expect(QuoteItem.safeParse(bare).success).toBe(true);
  });
});

describe('queries and requests', () => {
  it('SymbolSchema upper-cases and rejects odd characters', () => {
    expect(SymbolSchema.parse(' aapl ')).toBe('AAPL');
    expect(SymbolSchema.parse('brk.b')).toBe('BRK.B');
    for (const bad of ['', 'A B', 'A;B', "A'", '-A', 'X'.repeat(16)]) {
      expect(SymbolSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
  it('SearchQuery needs 1 to 40 characters after trimming', () => {
    expect(SearchQuery.safeParse({ q: 'a' }).success).toBe(true);
    expect(SearchQuery.safeParse({ q: 'x'.repeat(40) }).success).toBe(true);
    for (const q of ['', '  ', 'x'.repeat(41)])
      expect(SearchQuery.safeParse({ q }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: 'a', extra: 1 }).success).toBe(false);
  });
  it('QuotesQuery splits, upper-cases, de-duplicates and caps at 50', () => {
    expect(QuotesQuery.parse({ symbols: 'aapl, msft,AAPL' }).symbols).toEqual(['AAPL', 'MSFT']);
    const fifty = Array.from({ length: 50 }, (_x, i) => `S${String(i)}`).join(',');
    expect(QuotesQuery.safeParse({ symbols: fifty }).success).toBe(true);
    expect(QuotesQuery.safeParse({ symbols: `${fifty},S50` }).success).toBe(false);
    expect(QuotesQuery.safeParse({ symbols: '' }).success).toBe(false);
    expect(QuotesQuery.safeParse({ symbols: 'A,,B' }).success).toBe(false);
  });
  it('watchlist requests', () => {
    expect(CreateWatchlistRequest.parse({ name: ' Tech ' }).name).toBe('Tech');
    expect(CreateWatchlistRequest.safeParse({ name: 'x'.repeat(41) }).success).toBe(false);
    expect(UpdateWatchlistRequest.safeParse({}).success).toBe(false);
    expect(UpdateWatchlistRequest.safeParse({ position: 3 }).success).toBe(true);
    expect(AddWatchlistItemRequest.parse({ symbol: 'aapl' }).symbol).toBe('AAPL');
    expect(ReorderWatchlistItemsRequest.safeParse({ symbols: [] }).success).toBe(false);
  });
  it('instrument and market status shapes', () => {
    expect(
      InstrumentItem.safeParse({
        symbol: 'AAPL',
        name: 'Apple Inc.',
        assetClass: 'EQUITY',
        exchange: 'XNAS',
        currency: 'USD',
        status: 'ACTIVE',
        tickSize: '0.01',
        entitlement: 'DELAYED',
        delaySeconds: 900,
        source: 'FIXTURE',
      }).success,
    ).toBe(true);
    expect(
      MarketStatusResponse.safeParse({
        asOf: '2026-11-10T15:00:00.000Z',
        exchanges: [
          {
            exchange: 'XNYS',
            name: 'NYSE',
            state: 'OPEN',
            session: 'REGULAR',
            reason: null,
            note: null,
            localDate: '2026-11-10',
            nextOpen: null,
            nextClose: '2026-11-10T21:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(true);
  });
});
