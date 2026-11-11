import { Controller, Get, Inject, Module, Req, UseGuards } from '@nestjs/common';
import { AccountResponse } from '@vantage/contracts';
import { AppError } from '../../common/errors.js';
import type { AppRequest } from '../../common/http.js';
import { SessionGuard, SessionModule } from '../auth/session.guard.js';
import { LedgerModule } from '../ledger/ledger.service.js';
import { AccountsService } from './accounts.service.js';

@Controller('v1')
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  /** The caller's own account only: there is no account id in the URL or query. */
  @Get('account')
  @UseGuards(SessionGuard)
  async account(@Req() req: AppRequest): Promise<AccountResponse> {
    const auth = req.auth;
    if (auth === undefined) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    if (auth.status !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
    }
    const view = await this.accounts.getAccountForUser(auth.userId);
    if (view === undefined) throw new AppError(404, 'NOT_FOUND', 'Account not found');
    return AccountResponse.parse(view);
  }
}

@Module({
  imports: [SessionModule, LedgerModule],
  controllers: [AccountsController],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
