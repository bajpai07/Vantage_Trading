import { describe, expect, it } from 'vitest';
import {
  AddWatchlistItemRequest,
  CandleItem,
  CandlesQuery,
  CandlesResponse,
  CreateWatchlistRequest,
  FeedInfoResponse,
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
        tradable: true,
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

describe('FeedInfoResponse (M7a: per-source labelling, D-75)', () => {
  const source = {
    assetClass: 'CRYPTO',
    source: 'SIM',
    label: 'Simulated market data',
    mode: 'SIMULATED',
    session: '24_7',
    status: 'CONNECTED',
    lastMessageAt: '2026-11-10T15:00:00.000Z',
  };
  const feed = {
    source: 'SIM',
    entitlement: 'REAL_TIME',
    delaySeconds: 0,
    enabled: true,
    demoMode: true,
    sources: [source],
  };

  it('accepts one entry per class with its own mode, session and status', () => {
    expect(FeedInfoResponse.safeParse(feed).success).toBe(true);
    expect(
      FeedInfoResponse.safeParse({
        ...feed,
        sources: [{ ...source, lastMessageAt: null, status: 'OFF' }],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['an unknown mode', { ...source, mode: 'REAL' }],
    ['an unknown status', { ...source, status: 'UP' }],
    ['an unknown session', { ...source, session: 'ALWAYS' }],
    ['a blank label', { ...source, label: '' }],
    ['a blank source', { ...source, source: '' }],
    ['a bad timestamp', { ...source, lastMessageAt: 'yesterday' }],
    ['an extra field', { ...source, secret: 1 }],
  ])('refuses %s', (_n, bad) => {
    expect(FeedInfoResponse.safeParse({ ...feed, sources: [bad] }).success).toBe(false);
  });

  it('keeps the old fields and requires the new ones (the web app validates every answer)', () => {
    const noDemo: Record<string, unknown> = { ...feed };
    delete noDemo.demoMode;
    expect(FeedInfoResponse.safeParse(noDemo).success).toBe(false);
    const noSources: Record<string, unknown> = { ...feed };
    delete noSources.sources;
    expect(FeedInfoResponse.safeParse(noSources).success).toBe(false);
  });
});

describe('candles contracts (M7b)', () => {
  const ok = { symbol: 'aapl', interval: '1h' };

  it('the query: symbol upper-cased, optional ISO range and limit (a string becomes a whole number 1 to 500)', () => {
    const q = CandlesQuery.parse({
      ...ok,
      from: '2026-11-10T12:00:00Z',
      to: '2026-11-10T13:00:00.500Z',
      limit: '500',
    });
    expect(q).toMatchObject({ symbol: 'AAPL', interval: '1h', limit: 500 });
    expect(CandlesQuery.parse(ok)).toEqual({ symbol: 'AAPL', interval: '1h' });
  });

  it.each([
    ['an interval that does not exist', { ...ok, interval: '2m' }],
    ['limit 0', { ...ok, limit: '0' }],
    ['limit 501', { ...ok, limit: '501' }],
    ['limit with a sign or a decimal', { ...ok, limit: '-5' }],
    ['limit with a decimal', { ...ok, limit: '1.5' }],
    ['from after to', { ...ok, from: '2026-11-10T14:00:00Z', to: '2026-11-10T13:00:00Z' }],
    ['a date without a zone', { ...ok, from: '2026-11-10T12:00:00' }],
    ['a date that is not a date', { ...ok, to: 'now' }],
    ['an unknown field', { ...ok, extra: '1' }],
  ])('the query refuses %s', (_n, q) => {
    expect(CandlesQuery.safeParse(q).success).toBe(false);
  });

  it('from equal to to is allowed (one candle open time)', () => {
    expect(
      CandlesQuery.safeParse({ ...ok, from: '2026-11-10T12:00:00Z', to: '2026-11-10T12:00:00Z' })
        .success,
    ).toBe(true);
  });

  const candle = {
    t: '2026-11-10T12:00:00.000Z',
    o: '75642.67',
    h: '76043.14',
    l: '75461.79',
    c: '75935.95',
    v: '28.77612500',
    closed: true,
  };
  it('a candle carries canonical decimal strings and the forming flag', () => {
    expect(CandleItem.safeParse(candle).success).toBe(true);
    for (const bad of [
      { ...candle, o: 75642.67 },
      { ...candle, h: '1' },
      { ...candle, v: '-1' },
      { ...candle, closed: 'yes' },
      { ...candle, extra: 1 },
    ]) {
      expect(CandleItem.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a response is never without a source label, and says whether it is synthetic', () => {
    const body = {
      symbol: 'BTC-USD',
      interval: '1h',
      source: 'SIM',
      synthetic: true,
      truncated: false,
      candles: [candle],
    };
    expect(CandlesResponse.safeParse(body).success).toBe(true);
    expect(CandlesResponse.safeParse({ ...body, source: '' }).success).toBe(false);
    const noSource: Record<string, unknown> = { ...body };
    delete noSource.source;
    expect(CandlesResponse.safeParse(noSource).success).toBe(false);
    expect(
      CandlesResponse.safeParse({ ...body, candles: Array.from({ length: 501 }, () => candle) })
        .success,
    ).toBe(false);
  });
});
