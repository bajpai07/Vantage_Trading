import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import type { Config } from '@vantage/config';
import type { Logger } from '../../log.js';
import { CLOCK, CONFIG, LOGGER, POOL, PROVIDER } from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { syncInstrumentMaster } from '../instruments/instrument-sync.js';
import { InstrumentsService } from '../instruments/instruments.module.js';
import { CalendarService } from './calendar.service.js';
import { QuoteIngest } from './quote.ingest.js';
import { ProviderNotInstalledError } from './provider.js';
import type { MarketDataProvider } from './provider.js';

export class FixtureDataForbiddenError extends Error {
  constructor(detail: string) {
    super(`refusing to start: ${detail}`);
    this.name = 'FixtureDataForbiddenError';
  }
}

/** D-48: staging and production must never hold or serve fixture data. Pure so it is easy to test. */
export function assertNoFixtureData(input: {
  appEnv: string;
  marketDataSource: string;
  fixtureInstruments: boolean;
}): void {
  const strict = input.appEnv === 'staging' || input.appEnv === 'production';
  if (!strict) return;
  if (input.marketDataSource === 'FIXTURE') {
    throw new FixtureDataForbiddenError(
      `the FIXTURE quote source is not allowed when APP_ENV is ${input.appEnv}`,
    );
  }
  if (input.fixtureInstruments) {
    throw new FixtureDataForbiddenError(
      `FIXTURE instruments (attrs.source = 'FIXTURE') exist in the database and APP_ENV is ${input.appEnv}`,
    );
  }
}

const REFRESH_INTERVAL_MS = 30_000;

/** Pulls a snapshot from the provider and runs every quote through ingest (normalise, validate, store). */
@Injectable()
export class MarketRefresher implements OnApplicationShutdown {
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PROVIDER) private readonly provider: MarketDataProvider | null,
    @Inject(InstrumentsService) private readonly instruments: InstrumentsService,
    @Inject(QuoteIngest) private readonly ingest: QuoteIngest,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** One pass over every instrument mapped to the provider. Returns how many quotes were accepted. */
  async refresh(): Promise<{ received: number; accepted: number }> {
    if (this.provider === null) throw new ProviderNotInstalledError();
    const list = await this.instruments.listForProvider(this.provider.id);
    const bySymbol = new Map(list.map((x) => [x.providerSymbol, x]));
    const raws = await this.provider.getSnapshot(list.map((x) => x.providerSymbol));
    let accepted = 0;
    for (const raw of raws) {
      const inst = bySymbol.get(raw.symbol);
      if (inst === undefined) continue;
      const r = await this.ingest.ingest(inst.symbol, raw, inst.tickSize);
      if (r.accepted) accepted += 1;
    }
    return { received: raws.length, accepted };
  }

  /** Local development only: keep fixture quotes from going stale while the app runs. */
  startTimer(): void {
    this.#timer = setInterval(() => {
      this.refresh().catch((e: unknown) =>
        this.logger.error('refresh_failed', { errorName: e instanceof Error ? e.name : 'unknown' }),
      );
    }, REFRESH_INTERVAL_MS);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }
}

/** Boot sequence: guard, provider check, calendars, then (local/test only) sync and first snapshot. */
@Injectable()
export class MarketStartup implements OnApplicationBootstrap {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PROVIDER) private readonly provider: MarketDataProvider | null,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(InstrumentsService) private readonly instruments: InstrumentsService,
    @Inject(CalendarService) private readonly calendars: CalendarService,
    @Inject(MarketRefresher) private readonly refresher: MarketRefresher,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // 1. The fixture guard runs first, so a polluted staging database is reported as exactly that.
    assertNoFixtureData({
      appEnv: this.config.appEnv,
      marketDataSource: this.config.marketDataSource,
      fixtureInstruments: await this.instruments.hasFixtureInstruments(),
    });
    // 2. PROVIDER mode has no adapter until M3b.
    if (this.provider === null) throw new ProviderNotInstalledError();
    // 3. Calendars are parsed and validated now (D-47).
    await this.calendars.load();
    // 4. Local and test only: sync the fixture master and take a first snapshot.
    await syncInstrumentMaster(this.pool, this.provider, {
      clock: this.clock,
      logger: this.logger,
    });
    const first = await this.refresher.refresh();
    this.logger.info('market_data_ready', { source: this.provider.id, ...first });
    if (this.config.appEnv === 'local') this.refresher.startTimer();
  }
}
