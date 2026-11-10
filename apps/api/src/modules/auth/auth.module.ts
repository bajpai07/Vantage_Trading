import { Module } from '@nestjs/common';
import {
  CLOCK,
  LOGIN_LIMITER_IP,
  LOGIN_LIMITER_PAIR,
  PASSWORD_HASHER,
  REGISTER_LIMITER,
} from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { argon2Hasher } from './password.hasher.js';
import { LIMITS, RateLimiter } from './rate-limiter.js';
import { SessionModule } from './session.guard.js';

const limiter = (limits: { limit: number; windowMs: number }) => ({
  inject: [CLOCK],
  useFactory: (clock: Clock) => new RateLimiter({ ...limits, now: () => clock.now().getTime() }),
});

@Module({
  imports: [SessionModule, UsersModule, AccountsModule, AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: PASSWORD_HASHER, useValue: argon2Hasher },
    { provide: LOGIN_LIMITER_PAIR, ...limiter(LIMITS.loginPair) },
    { provide: LOGIN_LIMITER_IP, ...limiter(LIMITS.loginIp) },
    { provide: REGISTER_LIMITER, ...limiter(LIMITS.register) },
  ],
})
export class AuthModule {}
