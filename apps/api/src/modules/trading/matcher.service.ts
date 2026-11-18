// The thin timer around runMatcherOnce (M8b-1, D-95). It wakes every MATCHER_INTERVAL_MS (chained timeouts, so a slow tick can
// never overlap the next one) when MATCHER=on, and exposes runOnce() for tests and tools. It holds no state beyond the timer.
import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import type { Config } from '@vantage/config';
import type { Logger } from '../../log.js';
import { CLOCK, CONFIG, LOGGER, POOL } from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { QuoteService } from '../market-data/quote.service.js';
import { runMatcherOnce } from './matcher.js';
import type { MatcherResult } from './matcher.js';

@Injectable()
export class MatcherService implements OnApplicationBootstrap, OnApplicationShutdown {
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;

  constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(QuoteService) private readonly quotes: QuoteService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.matcher !== 'on') return;
    this.logger.info('matcher_started', { intervalMs: this.config.matcherIntervalMs });
    this.#schedule();
  }

  onApplicationShutdown(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.runOnce().finally(() => this.#schedule());
    }, this.config.matcherIntervalMs);
    this.#timer.unref();
  }

  /** One tick now (tests and tools). A tick that is already running makes this a no-op (the timer can never overlap itself). */
  async runOnce(now: Date = this.clock.now()): Promise<MatcherResult | undefined> {
    if (this.#running) return undefined;
    this.#running = true;
    try {
      return await runMatcherOnce(
        { pool: this.pool, quotes: this.quotes, logger: this.logger },
        now,
      );
    } catch (e) {
      this.logger.error('matcher_tick_failed', { error: (e as Error).message });
      return undefined;
    } finally {
      this.#running = false;
    }
  }
}
