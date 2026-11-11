import { Controller, Get, Inject, Module } from '@nestjs/common';
import type pg from 'pg';
import { AppError } from '../../common/errors.js';
import { POOL } from '../../tokens.js';

const READY_TIMEOUT_MS = 2000;

@Controller('health')
export class HealthController {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  /** Liveness: the process is up. No dependencies are touched. */
  @Get()
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness: the database answers SELECT 1, else 503. */
  @Get('ready')
  async ready(): Promise<{ status: string }> {
    try {
      await Promise.race([
        this.pool.query('SELECT 1'),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT_MS).unref(),
        ),
      ]);
    } catch {
      throw new AppError(503, 'NOT_READY', 'Database unavailable');
    }
    return { status: 'ready' };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
