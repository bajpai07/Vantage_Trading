import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LoginRequest, RegisterRequest } from '@vantage/contracts';
import type { MeResponse } from '@vantage/contracts';
import { ZodValidationPipe } from '../../common/zod.pipe.js';
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  clientIp,
  parseCookies,
  sessionCookie,
} from '../../common/http.js';
import type { AppRequest } from '../../common/http.js';
import { CONFIG } from '../../tokens.js';
import type { Config } from '@vantage/config';
import { AuthService } from './auth.service.js';
import type { RequestMeta } from './auth.service.js';
import { SessionService } from './session.service.js';

const metaOf = (req: AppRequest): RequestMeta => ({
  ip: clientIp(req),
  userAgent: req.headers['user-agent'],
  requestId: req.requestId,
});

@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Post('register')
  @HttpCode(201)
  async register(
    @Body(new ZodValidationPipe(RegisterRequest)) body: RegisterRequest,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const { me, token } = await this.auth.register(body, metaOf(req));
    this.setSession(res, token);
    return me;
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const { me, token } = await this.auth.login(body, metaOf(req));
    this.setSession(res, token);
    return me;
  }

  /** Revokes the current session if there is one. Always clears the cookie. */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    try {
      const session = await this.sessions.validate(
        parseCookies(req.headers.cookie)[SESSION_COOKIE],
      );
      if (session !== undefined)
        await this.auth.logout(session.sessionId, session.userId, metaOf(req));
    } finally {
      res.setHeader('Set-Cookie', clearedSessionCookie(this.config.cookieSecure));
    }
  }

  private setSession(res: Response, token: string): void {
    res.setHeader(
      'Set-Cookie',
      sessionCookie(token, {
        secure: this.config.cookieSecure,
        maxAgeSeconds: this.sessions.maxAgeSeconds,
      }),
    );
  }
}
