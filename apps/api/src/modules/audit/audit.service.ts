import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { normalizeEmail } from '@vantage/contracts';
import type { Logger } from '../../log.js';
import { LOGGER, POOL } from '../../tokens.js';

export type AuditAction =
  | 'USER_REGISTERED'
  | 'LOGIN_SUCCEEDED'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'ORDER_PLACED'
  | 'ORDER_CANCELLED';

export interface AuditEntry {
  readonly action: AuditAction;
  readonly actorId?: string;
  readonly actorRole?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly after?: Record<string, unknown>;
  readonly ip?: string;
  readonly requestId?: string;
}

/** A short, one-way tag for an email: enough to correlate attempts, never the address itself. */
export function emailHashPrefix(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 12);
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Appends one audit row. A failure is logged and swallowed: auditing must never block the request. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, after, ip, request_id)
         VALUES ($1::uuid, $2::user_role, $3, $4, $5, $6::jsonb, $7::inet, $8)`,
        [
          entry.actorId ?? null,
          entry.actorRole ?? null,
          entry.action,
          entry.targetType ?? null,
          entry.targetId ?? null,
          entry.after === undefined ? null : JSON.stringify(entry.after),
          entry.ip ?? null,
          entry.requestId ?? null,
        ],
      );
    } catch (e) {
      const err = e as { name?: unknown; code?: unknown };
      this.logger.error('audit_write_failed', {
        action: entry.action,
        requestId: entry.requestId,
        errorName: typeof err.name === 'string' ? err.name : 'unknown',
        errorCode: typeof err.code === 'string' ? err.code : undefined,
      });
    }
  }
}
