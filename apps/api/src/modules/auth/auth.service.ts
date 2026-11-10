import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import { normalizeEmail } from '@vantage/contracts';
import type { LoginRequest, MeResponse, RegisterRequest } from '@vantage/contracts';
import { AppError } from '../../common/errors.js';
import type { Logger } from '../../log.js';
import {
  LOGGER,
  LOGIN_LIMITER_IP,
  LOGIN_LIMITER_PAIR,
  PASSWORD_HASHER,
  POOL,
  REGISTER_LIMITER,
} from '../../tokens.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { AuditService, emailHashPrefix } from '../audit/audit.service.js';
import { UsersService } from '../users/users.service.js';
import { toMeResponse } from '../users/me.js';
import type { PasswordHasher } from './password.hasher.js';
import type { RateLimiter } from './rate-limiter.js';
import { SessionService } from './session.service.js';

export interface RequestMeta {
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
  readonly requestId: string;
}

export interface AuthResult {
  readonly me: MeResponse;
  readonly token: string;
}

const INVALID_CREDENTIALS = (): AppError =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

@Injectable()
export class AuthService implements OnModuleInit {
  /** A real Argon2id hash of a random string, verified when the email is unknown (no timing shortcut). */
  #dummyHash = '';

  constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(LOGIN_LIMITER_PAIR) private readonly pairLimiter: RateLimiter,
    @Inject(LOGIN_LIMITER_IP) private readonly ipLimiter: RateLimiter,
    @Inject(REGISTER_LIMITER) private readonly registerLimiter: RateLimiter,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.#dummyHash = await this.hasher.hash(randomBytes(24).toString('base64url'));
  }

  /** User, MAIN account, ledger accounts, GRANT and session in ONE transaction: all or nothing. */
  async register(body: RegisterRequest, meta: RequestMeta): Promise<AuthResult> {
    const ipKey = meta.ip ?? 'unknown';
    if (!this.registerLimiter.tryConsume(ipKey)) {
      throw this.rateLimited(this.registerLimiter.retryAfterSeconds(ipKey));
    }
    const passwordHash = await this.hasher.hash(body.password);

    const client = await this.pool.connect();
    let userId: string;
    let token: string;
    try {
      await client.query('BEGIN');
      userId = await this.users.createUser(client, {
        email: body.email,
        passwordHash,
        displayName: body.displayName,
        countryCode: body.countryCode,
      });
      await this.accounts.createMainAccount(client, userId);
      ({ token } = await this.sessions.create(client, userId, meta));
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      const err = e as { code?: string; constraint?: string };
      if (err.code === '23505' && err.constraint === 'users_email_key') {
        throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw e;
    } finally {
      client.release();
    }

    const user = await this.users.findById(userId);
    if (user === undefined) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
    await this.audit.record({
      action: 'USER_REGISTERED',
      actorId: userId,
      actorRole: 'USER',
      targetType: 'user',
      targetId: userId,
      ...(meta.ip === undefined ? {} : { ip: meta.ip }),
      requestId: meta.requestId,
    });
    return { me: toMeResponse(user), token };
  }

  async login(body: LoginRequest, meta: RequestMeta): Promise<AuthResult> {
    const ipKey = meta.ip ?? 'unknown';
    const pairKey = `${ipKey}|${normalizeEmail(body.email)}`;
    if (this.pairLimiter.isBlocked(pairKey)) {
      throw this.rateLimited(this.pairLimiter.retryAfterSeconds(pairKey));
    }
    if (this.ipLimiter.isBlocked(ipKey)) {
      throw this.rateLimited(this.ipLimiter.retryAfterSeconds(ipKey));
    }

    const user = await this.users.findByEmail(body.email);
    // Always exactly one Argon2 verification, whether or not the email exists.
    const ok = await this.hasher.verify(user?.passwordHash ?? this.#dummyHash, body.password);
    if (user === undefined || !ok || user.status !== 'ACTIVE') {
      this.pairLimiter.record(pairKey);
      this.ipLimiter.record(ipKey);
      await this.audit.record({
        action: 'LOGIN_FAILED',
        after: { emailHash: emailHashPrefix(body.email) },
        ...(meta.ip === undefined ? {} : { ip: meta.ip }),
        requestId: meta.requestId,
      });
      throw INVALID_CREDENTIALS();
    }

    const { token } = await this.sessions.create(this.pool, user.id, meta);
    await this.audit.record({
      action: 'LOGIN_SUCCEEDED',
      actorId: user.id,
      actorRole: user.role,
      targetType: 'user',
      targetId: user.id,
      ...(meta.ip === undefined ? {} : { ip: meta.ip }),
      requestId: meta.requestId,
    });
    return { me: toMeResponse(user), token };
  }

  async logout(sessionId: string, userId: string, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(sessionId);
    await this.audit.record({
      action: 'LOGOUT',
      actorId: userId,
      targetType: 'user',
      targetId: userId,
      ...(meta.ip === undefined ? {} : { ip: meta.ip }),
      requestId: meta.requestId,
    });
  }

  private rateLimited(retryAfter: number): AppError {
    this.logger.warn('rate_limited', { retryAfterSeconds: retryAfter });
    return new AppError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {
      'Retry-After': String(retryAfter),
    });
  }
}
