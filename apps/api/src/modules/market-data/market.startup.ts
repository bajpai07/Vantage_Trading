import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import type { Config } from '@vantage/config';
import type { Logger } from '../../log.js';
import { CLOCK, CONFIG, LOGGER, POOL, PROVIDER } from '../../tokens.js';
import { FeedInfoService } from '../feed/feed.module.js';
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

/** The fixture refresher (local development only) keeps its old, slow pace. */
const FIXTURE_REFRESH_INTERVAL_MS = 30_000;

/** Pulls a snapshot from the provider and runs every quote through ingest (normalise, validate, store). */
@Injectable()
export class MarketRefresher implements OnApplicationShutdown {
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PROVIDER) private readonly provider: MarketDataProvider | null,
    @Inject(InstrumentsService) private readonly instruments: InstrumentsService,
    @Inject(QuoteIngest) private readonly ingest: QuoteIngest,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(FeedInfoService) private readonly feed: FeedInfoService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** One pass over every instrument mapped to the provider. Returns how many quotes were accepted. */
  async refresh(): Promise<{ received: number; accepted: number }> {
    if (this.provider === null) throw new ProviderNotInstalledError();
    const list = await this.instruments.listForProvider(this.provider.id);
    const bySymbol = new Map(list.map((x) => [x.providerSymbol, x]));
    const raws = await this.provider.getSnapshot(list.map((x) => x.providerSymbol));
    let accepted = 0;
    const published = new Set<string>();
    for (const raw of raws) {
      const inst = bySymbol.get(raw.symbol);
      if (inst === undefined) continue;
      const r = await this.ingest.ingest(inst.symbol, raw, inst.tickSize);
      if (r.accepted) {
        accepted += 1;
        published.add(inst.assetClass);
      }
    }
    // D-75: the feed status served to the web app says when each asset class last published
    this.feed.recordPublished(this.clock.now(), published);
    return { received: raws.length, accepted };
  }

  /** Keeps quotes fresh while the app runs: the simulated feed ticks every SIM_TICK_MS (D-78), the fixture every 30 s. */
  startTimer(intervalMs: number): void {
    this.#timer = setInterval(() => {
      this.refresh().catch((e: unknown) =>
        this.logger.error('refresh_failed', { errorName: e instanceof Error ? e.name : 'unknown' }),
      );
    }, intervalMs);
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
    // The runner publishes simulated quotes continuously everywhere except tests (a test drives refresh() itself, with
    // its own clock); the fixture keeps its slow local-only timer.
    if (this.provider.id === 'SIM' && this.config.appEnv !== 'test') {
      this.refresher.startTimer(this.config.simTickMs);
    } else if (this.config.appEnv === 'local') {
      this.refresher.startTimer(FIXTURE_REFRESH_INTERVAL_MS);
    }
  }
}
