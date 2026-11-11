import { Inject, Injectable, Module } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { unauthenticated } from '../../common/errors.js';
import { SESSION_COOKIE, parseCookies } from '../../common/http.js';
import type { AppRequest } from '../../common/http.js';
import { SessionService } from './session.service.js';

/** Requires a valid session cookie; puts { userId, sessionId, status } on the request. Else 401. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = await this.sessions.validate(token);
    if (session === undefined) throw unauthenticated();
    req.auth = { userId: session.userId, sessionId: session.sessionId, status: session.userStatus };
    return true;
  }
}

/** Sessions and the guard live in their own module so users/accounts can use them without a cycle. */
@Module({ providers: [SessionService, SessionGuard], exports: [SessionService, SessionGuard] })
export class SessionModule {}
