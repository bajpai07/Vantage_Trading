import { Controller, Get, Inject, Module, Req, UseGuards } from '@nestjs/common';
import { MeResponse } from '@vantage/contracts';
import { AppError } from '../../common/errors.js';
import type { AppRequest } from '../../common/http.js';
import { SessionGuard, SessionModule } from '../auth/session.guard.js';
import { toMeResponse } from './me.js';
import { UsersService } from './users.service.js';

@Controller('v1')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@Req() req: AppRequest): Promise<MeResponse> {
    const auth = req.auth;
    const user = auth === undefined ? undefined : await this.users.findById(auth.userId);
    if (user === undefined) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    return MeResponse.parse(toMeResponse(user));
  }
}

@Module({
  imports: [SessionModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
