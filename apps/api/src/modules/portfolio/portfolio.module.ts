import { Controller, Get, Inject, Module, Query, Req, UseGuards } from '@nestjs/common';
import type {
  ListActivityResponse,
  ListExecutionsResponse,
  PortfolioHistoryResponse,
  PortfolioResponse,
} from '@vantage/contracts';
import { ListActivityQuery, ListExecutionsQuery, PortfolioHistoryQuery } from '@vantage/contracts';
import { unauthenticated } from '../../common/errors.js';
import type { AppRequest } from '../../common/http.js';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import { SessionGuard, SessionModule } from '../auth/session.guard.js';
import { MarketDataModule } from '../market-data/market-data.module.js';
import { HistoryService } from './history.service.js';
import { PortfolioService } from './portfolio.service.js';
import { SnapshotScheduler, SnapshotService } from './snapshot.service.js';

/** The account is always the session user's own MAIN account: there is no account id in any request. */
const userOf = (req: AppRequest): string => {
  if (req.auth === undefined) throw unauthenticated();
  return req.auth.userId;
};

@Controller('v1/portfolio')
@UseGuards(SessionGuard)
export class PortfolioController {
  constructor(@Inject(PortfolioService) private readonly portfolio: PortfolioService) {}

  /** Cash, positions valued at their marks (bid) with freshness labels, P&L and equity. Read-only. */
  @Get()
  async get(@Req() req: AppRequest): Promise<PortfolioResponse> {
    return this.portfolio.portfolio(userOf(req));
  }

  /** Daily equity snapshots, oldest first, at most 366 rows. */
  @Get('history')
  async history(
    @Query(new ZodValidationPipe(PortfolioHistoryQuery)) query: PortfolioHistoryQuery,
    @Req() req: AppRequest,
  ): Promise<PortfolioHistoryResponse> {
    return this.portfolio.history(userOf(req), query);
  }
}

@Controller('v1')
@UseGuards(SessionGuard)
export class HistoryController {
  constructor(@Inject(HistoryService) private readonly history: HistoryService) {}

  @Get('executions')
  async executions(
    @Query(new ZodValidationPipe(ListExecutionsQuery)) query: ListExecutionsQuery,
    @Req() req: AppRequest,
  ): Promise<ListExecutionsResponse> {
    return this.history.executions(userOf(req), query);
  }

  @Get('ledger/activity')
  async activity(
    @Query(new ZodValidationPipe(ListActivityQuery)) query: ListActivityQuery,
    @Req() req: AppRequest,
  ): Promise<ListActivityResponse> {
    return this.history.activity(userOf(req), query);
  }
}

@Module({
  imports: [SessionModule, MarketDataModule],
  controllers: [PortfolioController, HistoryController],
  providers: [PortfolioService, HistoryService, SnapshotService, SnapshotScheduler],
  exports: [PortfolioService, SnapshotService],
})
export class PortfolioModule {}
