import { Global, Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import type { Config } from '@vantage/config';
import type { Logger } from '../../log.js';
import { CONFIG, LOGGER, POOL } from '../../tokens.js';

/** The only database connection of the app: a pg Pool as vantage_app (config guards refuse other users). */
@Global()
@Module({
  providers: [
    {
      provide: POOL,
      inject: [CONFIG, LOGGER],
      useFactory: (config: Config, logger: Logger): pg.Pool => {
        const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
        pool.on('error', (e) => logger.error('pool_error', { errorName: e.name }));
        return pool;
      },
    },
  ],
  exports: [POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
