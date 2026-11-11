import { Controller, Get, Inject, Module, Query, UseGuards } from '@nestjs/common';
import { MarketStatusResponse, QuotesQuery, QuotesResponse } from '@vantage/contracts';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import type { Logger } from '../../log.js';
import { CLOCK, LOGGER, QUOTE_STORE } from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { SessionGuard, SessionModule } from '../auth/session.guard.js';
import { FeedModule } from '../feed/feed.module.js';
import { InstrumentsModule } from '../instruments/instruments.module.js';
import { CalendarService } from './calendar.service.js';
import { MarketRefresher, MarketStartup } from './market.startup.js';
import { QuoteIngest } from './quote.ingest.js';
import { QuoteService } from './quote.service.js';
import { InMemoryQuoteStore } from './quote.store.js';

@Controller('v1')
@UseGuards(SessionGuard)
export class MarketController {
  constructor(
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(CalendarService) private readonly calendars: CalendarService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 1 to 50 symbols; every requested symbol gets an answer with `source` and `freshness`. */
  @Get('quotes')
  async getQuotes(
    @Query(new ZodValidationPipe(QuotesQuery)) query: QuotesQuery,
  ): Promise<QuotesResponse> {
    return QuotesResponse.parse({ quotes: await this.quotes.getQuotes(query.symbols) });
  }

  @Get('market/status')
  async status(): Promise<MarketStatusResponse> {
    const now = this.clock.now();
    const all = await this.calendars.statusAll(now);
    return MarketStatusResponse.parse({
      asOf: now.toISOString(),
      exchanges: all.map((s) => ({
        exchange: s.exchange,
        name: s.name,
        state: s.state,
        session: s.session,
        reason: s.reason,
        note: s.note,
        localDate: s.localDate,
        nextOpen: s.nextOpen?.toISOString() ?? null,
        nextClose: s.nextClose?.toISOString() ?? null,
      })),
    });
  }
}

@Module({
  imports: [SessionModule, FeedModule, InstrumentsModule],
  controllers: [MarketController],
  providers: [
    { provide: QUOTE_STORE, useFactory: () => new InMemoryQuoteStore() },
    {
      provide: QuoteIngest,
      inject: [QUOTE_STORE, CLOCK, LOGGER],
      useFactory: (store: InMemoryQuoteStore, clock: Clock, logger: Logger) =>
        new QuoteIngest(store, clock, logger),
    },
    CalendarService,
    QuoteService,
    MarketRefresher,
    MarketStartup,
  ],
  exports: [QuoteService, QuoteIngest, CalendarService, MarketRefresher],
})
export class MarketDataModule {}
