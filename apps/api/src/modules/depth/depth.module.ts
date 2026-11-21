import { Controller, Get, Header, Inject, Module, Query, Req, UseGuards } from '@nestjs/common';
import { DEPTH_DEFAULT_LEVELS, DepthQuery, MyDepthOrdersQuery } from '@vantage/contracts';
import type { DepthResponse, MyDepthOrdersResponse } from '@vantage/contracts';
import type { Config } from '@vantage/config';
import { unauthenticated } from '../../common/errors.js';
import { clientIp } from '../../common/http.js';
import type { AppRequest } from '../../common/http.js';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import { CLOCK, CONFIG, DEPTH_LIMITER } from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { SessionGuard, SessionModule } from '../auth/session.guard.js';
import { InstrumentsModule } from '../instruments/instruments.module.js';
import { MarketDataModule } from '../market-data/market-data.module.js';
import { DepthService, newDepthLimiter } from './depth.service.js';

/**
 * Simulated depth (M8b-2). Public and read-only like /v1/market/feed; the book is informational (D-98). Every request spends
 * cost points from a per-client allowance (DEPTH_RATE_LIMIT_PER_MINUTE, D-101): by address here, by user on my-orders.
 */
@Controller('v1/market/depth')
export class DepthController {
  constructor(@Inject(DepthService) private readonly depth: DepthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(
    @Query(new ZodValidationPipe(DepthQuery)) query: DepthQuery,
    @Req() req: AppRequest,
  ): Promise<DepthResponse> {
    const levels = query.levels ?? DEPTH_DEFAULT_LEVELS;
    this.depth.spend(`ip:${clientIp(req) ?? 'unknown'}`, levels);
    return this.depth.depth(query.symbol, levels);
  }

  /** The caller's own open limit orders on the book (D-102). Needs a session: another user's orders are never returned. */
  @Get('my-orders')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  async myOrders(
    @Query(new ZodValidationPipe(MyDepthOrdersQuery)) query: MyDepthOrdersQuery,
    @Req() req: AppRequest,
  ): Promise<MyDepthOrdersResponse> {
    if (req.auth === undefined) throw unauthenticated();
    const levels = query.levels ?? DEPTH_DEFAULT_LEVELS;
    this.depth.spend(`user:${req.auth.userId}`, levels);
    return this.depth.myOrders(req.auth.userId, query.symbol, levels);
  }
}

@Module({
  imports: [SessionModule, MarketDataModule, InstrumentsModule],
  controllers: [DepthController],
  providers: [
    DepthService,
    {
      provide: DEPTH_LIMITER,
      inject: [CONFIG, CLOCK],
      useFactory: (config: Config, clock: Clock) => newDepthLimiter(config, clock),
    },
  ],
})
export class DepthModule {}
