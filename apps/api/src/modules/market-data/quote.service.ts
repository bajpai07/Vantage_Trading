import { Inject, Injectable } from '@nestjs/common';
import type { QuoteItem } from '@vantage/contracts';
import { freshness } from '@vantage/market-model';
import type { InstrumentStatus, MarketState, Quote } from '@vantage/market-model';
import { parse } from '@vantage/money';
import { CLOCK, QUOTE_STORE } from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { FeedInfoService } from '../feed/feed.module.js';
import { InstrumentsService } from '../instruments/instruments.module.js';
import { CalendarService } from './calendar.service.js';
import type { QuoteStore } from './quote.store.js';

const price = (p: string): string => parse(p).toCanonicalString();

/**
 * Reads quotes. Freshness comes ONLY from the shared freshness() function. When no valid quote exists the
 * answer is UNAVAILABLE and carries no price: this service never returns a made-up number.
 */
@Injectable()
export class QuoteService {
  constructor(
    @Inject(QUOTE_STORE) private readonly store: QuoteStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(InstrumentsService) private readonly instruments: InstrumentsService,
    @Inject(CalendarService) private readonly calendars: CalendarService,
    @Inject(FeedInfoService) private readonly feed: FeedInfoService,
  ) {}

  /** One answer per requested symbol, in request order. Unknown symbols are reported, never dropped. */
  async getQuotes(symbols: readonly string[]): Promise<QuoteItem[]> {
    const now = this.clock.now();
    const feed = this.feed.get();
    const rows = await this.instruments.findBySymbols(symbols);
    const bySymbol = new Map(rows.map((r) => [r.symbol.toUpperCase(), r]));
    const out: QuoteItem[] = [];

    for (const requested of symbols) {
      const symbol = requested.toUpperCase();
      const row = bySymbol.get(symbol);
      const base = {
        symbol,
        source: feed.source,
        entitlement: feed.entitlement,
        delaySeconds: feed.delaySeconds,
      };
      if (row === undefined) {
        out.push({ ...base, known: false, freshness: 'UNAVAILABLE', ageSeconds: null, asOf: null });
        continue;
      }
      const quote: Quote | null = (await this.store.get(symbol))?.lastAccepted ?? null;
      const calendarState: MarketState | undefined = await this.calendars.stateFor(
        row.exchange,
        now,
      );
      const result = freshness(
        quote,
        row.status as InstrumentStatus,
        { state: calendarState?.state ?? 'CLOSED' },
        now,
        { feedEnabled: feed.enabled, assetClass: row.assetClass === 'ETF' ? 'ETF' : 'EQUITY' },
      );
      if (quote === null || result.state === 'UNAVAILABLE') {
        out.push({ ...base, known: true, freshness: 'UNAVAILABLE', ageSeconds: null, asOf: null });
        continue;
      }
      out.push({
        symbol,
        known: true,
        freshness: result.state,
        source: quote.source,
        entitlement: quote.entitlement,
        delaySeconds: quote.delaySeconds,
        ageSeconds: result.ageSeconds,
        asOf: quote.providerTs.toISOString(),
        bid: price(quote.bid),
        ask: price(quote.ask),
        ...(quote.last === undefined ? {} : { last: price(quote.last) }),
        ...(quote.gapConfirmed === true ? { gapConfirmed: true as const } : {}),
      });
    }
    return out;
  }
}
