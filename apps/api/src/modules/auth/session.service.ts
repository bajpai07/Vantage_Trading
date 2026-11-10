import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { Config } from '@vantage/config';
import { newId } from '../../ids.js';
import { CLOCK, CONFIG, POOL } from '../../tokens.js';
import type { Clock } from '../../tokens.js';

/** Update last_seen_at at most this often. */
const TOUCH_INTERVAL_MS = 60_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export interface ValidSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly userStatus: string;
}

export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

@Injectable()
export class SessionService {
  constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  get maxAgeSeconds(): number {
    return this.config.sessionAbsoluteDays * 24 * 60 * 60;
  }

  /**
   * Creates a brand-new session (a token is never reused). Only the SHA-256 of the token is stored.
   * Runs inside the caller's transaction when a client is given.
   */
  async create(
    client: Pick<pg.ClientBase, 'query'>,
    userId: string,
    meta: { ip: string | undefined; userAgent: string | undefined },
  ): Promise<{ token: string; sessionId: string }> {
    const token = randomBytes(32).toString('base64url');
    const sessionId = newId();
    const now = this.clock.now();
    const expires = new Date(now.getTime() + this.maxAgeSeconds * 1000);
    await client.query(
      `INSERT INTO user_sessions (id, user_id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::inet, $5, $6, $6, $7)`,
      [
        sessionId,
        userId,
        hashToken(token),
        meta.ip ?? null,
        meta.userAgent?.slice(0, 300) ?? null,
        now,
        expires,
      ],
    );
    return { token, sessionId };
  }

  /** Returns the session when the token is valid, not revoked, not expired and not idle; otherwise undefined. */
  async validate(token: string | undefined): Promise<ValidSession | undefined> {
    if (token === undefined || !TOKEN_SHAPE.test(token)) return undefined;
    const r = await this.pool.query<{
      id: string;
      user_id: string;
      last_seen_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
      status: string;
      deleted_at: Date | null;
    }>(
      `SELECT s.id, s.user_id, s.last_seen_at, s.expires_at, s.revoked_at, u.status::text AS status, u.deleted_at
         FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [hashToken(token)],
    );
    const row = r.rows[0];
    if (row === undefined || row.revoked_at !== null || row.deleted_at !== null) return undefined;
    const now = this.clock.now().getTime();
    if (now >= row.expires_at.getTime()) return undefined;
    const idleMs = this.config.sessionIdleMinutes * 60 * 1000;
    if (now - row.last_seen_at.getTime() > idleMs) return undefined;
    if (now - row.last_seen_at.getTime() >= TOUCH_INTERVAL_MS) {
      await this.pool.query(`UPDATE user_sessions SET last_seen_at = $2 WHERE id = $1::uuid`, [
        row.id,
        new Date(now),
      ]);
    }
    return { sessionId: row.id, userId: row.user_id, userStatus: row.status };
  }

  /** Revokes a session. Idempotent. */
  async revoke(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE user_sessions SET revoked_at = $2 WHERE id = $1::uuid AND revoked_at IS NULL`,
      [sessionId, this.clock.now()],
    );
  }
}
