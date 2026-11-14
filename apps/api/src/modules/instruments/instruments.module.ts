import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type pg from 'pg';
import { InstrumentItem, SearchQuery, SearchResponse, SymbolSchema } from '@vantage/contracts';
import { MVP_TRADABLE_GATE } from '@vantage/engine';
import { parse } from '@vantage/money';
import { AppError } from '../../common/errors.js';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import { POOL } from '../../tokens.js';
import { SessionGuard, SessionModule } from '../auth/session.guard.js';
import { FeedInfoService, FeedModule } from '../feed/feed.module.js';
import { findBySymbols, searchInstruments } from './search.js';
import type { InstrumentRow } from './search.js';

@Injectable()
export class InstrumentsService {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  search(text: string, limit = 20): Promise<InstrumentRow[]> {
    return searchInstruments(this.pool, text, limit);
  }

  findBySymbols(symbols: readonly string[]): Promise<InstrumentRow[]> {
    return findBySymbols(this.pool, symbols);
  }

  /** Symbols mapped to a provider, with the provider's own symbol and the tick size (for the refresher). */
  async listForProvider(
    providerId: string,
  ): Promise<
    Array<{ symbol: string; providerSymbol: string; tickSize: string; assetClass: string }>
  > {
    const r = await this.pool.query<{
      symbol: string;
      provider_symbol: string;
      tick_size: string;
      asset_class: string;
    }>(
      `SELECT i.symbol, m.provider_symbol, i.tick_size, i.asset_class::text AS asset_class
         FROM instruments i JOIN instrument_provider_map m ON m.instrument_id = i.id AND m.provider = $1
        WHERE i.status <> 'DELISTED' ORDER BY i.symbol`,
      [providerId],
    );
    return r.rows.map((x) => ({
      symbol: x.symbol,
      providerSymbol: x.provider_symbol,
      tickSize: x.tick_size,
      assetClass: x.asset_class,
    }));
  }

  /** True when any instrument master row is labelled FIXTURE (the staging/production guard). */
  async hasFixtureInstruments(): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM instruments WHERE attrs->>'source' = 'FIXTURE' LIMIT 1`,
    );
    return (r.rowCount ?? 0) > 0;
  }
}

@Controller('v1/instruments')
@UseGuards(SessionGuard)
export class InstrumentsController {
  constructor(
    @Inject(InstrumentsService) private readonly instruments: InstrumentsService,
    @Inject(FeedInfoService) private readonly feed: FeedInfoService,
  ) {}

  @Get('search')
  async search(
    @Query(new ZodValidationPipe(SearchQuery)) query: SearchQuery,
  ): Promise<SearchResponse> {
    const rows = await this.instruments.search(query.q, 20);
    return SearchResponse.parse({ results: rows.map((r) => this.toItem(r)) });
  }

  @Get(':symbol')
  async one(
    @Param('symbol', new ZodValidationPipe(SymbolSchema)) symbol: string,
  ): Promise<InstrumentItem> {
    const [row] = await this.instruments.findBySymbols([symbol]);
    if (row === undefined) throw new AppError(404, 'INSTRUMENT_NOT_FOUND', 'Instrument not found');
    return InstrumentItem.parse(this.toItem(row));
  }

  private toItem(r: InstrumentRow): InstrumentItem {
    const feed = this.feed.get();
    return {
      symbol: r.symbol,
      name: r.name,
      assetClass: r.assetClass as InstrumentItem['assetClass'],
      exchange: r.exchange,
      currency: r.currency,
      status: r.status as InstrumentItem['status'],
      tickSize: parse(r.tickSize).toCanonicalString(),
      entitlement: feed.entitlement,
      delaySeconds: feed.delaySeconds,
      source: r.attrsSource ?? feed.source,
      tradable: r.tradableIn.includes(MVP_TRADABLE_GATE),
    };
  }
}

@Module({
  imports: [SessionModule, FeedModule],
  controllers: [InstrumentsController],
  providers: [InstrumentsService],
  exports: [InstrumentsService],
})
export class InstrumentsModule {}
