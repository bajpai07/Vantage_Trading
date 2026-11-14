import {
  Controller,
  Get,
  Headers,
  Inject,
  Module,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CandlesQuery,
  CandlesResponse,
  DEFAULT_CANDLES_PER_REQUEST,
  MarketStatusResponse,
  QuotesQuery,
  QuotesResponse,
} from '@vantage/contracts';
import type { Config } from '@vantage/config';
import { AppError, unauthenticated } from '../../common/errors.js';
import type { AppRequest } from '../../common/http.js';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import type { Logger } from '../../log.js';
import {
  CANDLES_LIMITER,
  CANDLE_PROVIDER,
  CLOCK,
  CONFIG,
  LOGGER,
  QUOTE_STORE,
} from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { SessionGuard, SessionModule } from '../auth/session.guard.js';
import { FeedModule } from '../feed/feed.module.js';
import { InstrumentsModule } from '../instruments/instruments.module.js';
import { SimCandleProvider } from './candles/candle.provider.js';
import type { CandleProvider } from './candles/candle.provider.js';
import { CandleService, candleCost } from './candles/candle.service.js';
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
    @Inject(CandleService) private readonly candles: CandleService,
    @Inject(CANDLES_LIMITER) private readonly candlesLimiter: RateLimiter,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** 1 to 50 symbols; every requested symbol gets an answer with `source` and `freshness`. */
  @Get('quotes')
  async getQuotes(
    @Query(new ZodValidationPipe(QuotesQuery)) query: QuotesQuery,
  ): Promise<QuotesResponse> {
    return QuotesResponse.parse({ quotes: await this.quotes.getQuotes(query.symbols) });
  }

  /**
   * OHLCV candles (M7b, D-79 to D-81). Session-only like /v1/quotes (the feed description is the public one). Answers made
   * only of closed candles in the past can never change: they carry a strong ETag (304 on If-None-Match) and a private
   * max-age; an answer with the forming candle is no-store. Each request spends cost points from a per-user allowance
   * that grows with the most work it can need (CANDLES_RATE_LIMIT_PER_MINUTE).
   */
  @Get('market/candles')
  async getCandles(
    @Query(new ZodValidationPipe(CandlesQuery)) query: CandlesQuery,
    @Req() req: AppRequest,
    // the response is written here (not by Nest) so that a 304 stays a 304
    @Res() res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<void> {
    if (req.auth === undefined) throw unauthenticated();
    const userId = req.auth.userId;
    const cost = candleCost(query.interval, query.limit ?? DEFAULT_CANDLES_PER_REQUEST);
    if (this.candlesLimiter.count(userId) + cost > this.config.candlesRateLimitPerMinute) {
      const retryAfter = this.candlesLimiter.retryAfterSeconds(userId);
      this.logger.warn('rate_limited', {
        route: 'GET /v1/market/candles',
        retryAfterSeconds: retryAfter,
      });
      throw new AppError(429, 'RATE_LIMITED', 'Too many candle requests. Try again shortly.', {
        'Retry-After': String(retryAfter),
      });
    }
    for (let i = 0; i < cost; i += 1) this.candlesLimiter.record(userId);
    const r = await this.candles.candles(query);
    if (r.immutable && r.etag !== null) {
      res.setHeader('ETag', r.etag);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      if (ifNoneMatch !== undefined && ifNoneMatch.split(',').some((t) => t.trim() === r.etag)) {
        res.status(304).end();
        return;
      }
    }
    // written with end() so that Express adds no automatic weak ETag: only an immutable answer is ever tagged
    const text = JSON.stringify(CandlesResponse.parse(r.body));
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(text));
    res.end(text);
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
    CandleService,
    {
      provide: CANDLE_PROVIDER,
      inject: [CONFIG, CalendarService],
      useFactory: (config: Config, calendars: CalendarService): CandleProvider | null =>
        config.marketDataSource === 'SIM'
          ? new SimCandleProvider({
              seed: config.simSeed,
              session: config.simSession,
              crypto: config.cryptoFeed === 'sim',
              calendars,
            })
          : null,
    },
    {
      provide: CANDLES_LIMITER,
      inject: [CONFIG, CLOCK],
      useFactory: (config: Config, clock: Clock) =>
        new RateLimiter({
          limit: config.candlesRateLimitPerMinute,
          windowMs: 60_000,
          now: () => clock.now().getTime(),
        }),
    },
    QuoteService,
    MarketRefresher,
    MarketStartup,
  ],
  exports: [
    QUOTE_STORE,
    QuoteService,
    QuoteIngest,
    CalendarService,
    MarketRefresher,
    CandleService,
  ],
})
export class MarketDataModule {}
