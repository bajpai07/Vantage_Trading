import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { FeedInfoResponse } from '@vantage/contracts';
import type { FeedSource } from '@vantage/contracts';
import type { Config } from '@vantage/config';
import type { Entitlement } from '@vantage/market-model';
import type { Clock } from '../../tokens.js';
import { CLOCK, CONFIG, PROVIDER } from '../../tokens.js';
import { FixtureProvider } from '../market-data/fixture/fixture.provider.js';
import { ProviderNotInstalledError } from '../market-data/provider.js';
import type { MarketDataProvider } from '../market-data/provider.js';
import { SimProvider } from '../market-data/sim/sim.provider.js';

export interface FeedInfo {
  /** The label every quote and instrument answer carries, e.g. SIM. */
  readonly source: string;
  readonly entitlement: Entitlement;
  readonly delaySeconds: number;
  /** false when a kill switch has disabled the feed: quotes are then UNAVAILABLE. */
  readonly enabled: boolean;
}

type FeedAssetClass = FeedSource['assetClass'];
const CLASSES: readonly FeedAssetClass[] = ['EQUITY', 'ETF', 'CRYPTO'];

/** Human labels for the sources this API can run (D-75). A live exchange or vendor adds its own entry. */
const SOURCE_LABELS: Readonly<Record<string, { label: string; mode: FeedSource['mode'] }>> = {
  SIM: { label: 'Simulated market data', mode: 'SIMULATED' },
  FIXTURE: { label: 'Synthetic test data', mode: 'FIXTURE' },
};

/** A feed is CONNECTED while it published within this many tick intervals (and at least this many ms). */
const CONNECTED_TICKS = 5;
const CONNECTED_MIN_MS = 10_000;
/** The fixture refresher runs every 30 s in local development. */
const FIXTURE_CONNECTED_MS = 90_000;

/** Describes the active data feed. The one place the rest of the API learns about the source. */
@Injectable()
export class FeedInfoService {
  #enabled = true;
  readonly #lastPublished = new Map<FeedAssetClass, Date>();

  constructor(
    @Inject(PROVIDER) private readonly provider: MarketDataProvider | null,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  get(): FeedInfo {
    if (this.provider === null) throw new ProviderNotInstalledError();
    const caps = this.provider.capabilities();
    return {
      source: this.provider.id,
      entitlement: caps.entitlement,
      delaySeconds: caps.delaySeconds,
      enabled: this.#enabled,
    };
  }

  /** Kill switch (admin tooling arrives later). */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  /** The refresher calls this after each pass: the feed published quotes for these asset classes at `at`. */
  recordPublished(at: Date, assetClasses: Iterable<string>): void {
    for (const c of assetClasses) {
      if ((CLASSES as readonly string[]).includes(c))
        this.#lastPublished.set(c as FeedAssetClass, at);
    }
  }

  /** The truthful per-class description served at GET /v1/market/feed (D-75). */
  describe(): FeedInfoResponse {
    const base = this.get();
    const now = this.clock.now().getTime();
    const known = SOURCE_LABELS[base.source] ?? {
      label: `Market data (${base.source})`,
      mode: 'LIVE' as const,
    };
    const caps = (this.provider as MarketDataProvider).capabilities();
    const connectedMs =
      base.source === 'FIXTURE'
        ? FIXTURE_CONNECTED_MS
        : Math.max(CONNECTED_MIN_MS, CONNECTED_TICKS * this.config.simTickMs);
    const sources: FeedSource[] = CLASSES.map((assetClass) => {
      const served = caps.assetClasses.includes(assetClass);
      const last = this.#lastPublished.get(assetClass) ?? null;
      const status: FeedSource['status'] =
        !served || !this.#enabled
          ? 'OFF'
          : last !== null && now - last.getTime() <= connectedMs
            ? 'CONNECTED'
            : 'DISCONNECTED';
      const session: FeedSource['session'] =
        assetClass === 'CRYPTO'
          ? '24_7'
          : known.mode === 'SIMULATED' && this.config.simSession === 'ALWAYS_OPEN'
            ? 'ALWAYS_OPEN'
            : 'NYSE';
      return {
        assetClass,
        source: base.source,
        label: known.label,
        mode: known.mode,
        session,
        status,
        lastMessageAt: last === null ? null : last.toISOString(),
      };
    });
    return FeedInfoResponse.parse({ ...base, demoMode: this.config.demoMode, sources });
  }
}

/** Public: which data source is active. No session is needed (the login page shows the source too). */
@Controller('v1/market')
export class FeedController {
  constructor(@Inject(FeedInfoService) private readonly feed: FeedInfoService) {}

  @Get('feed')
  info(): FeedInfoResponse {
    return this.feed.describe();
  }
}

/**
 * The provider factory: FIXTURE builds the FixtureProvider (which itself refuses staging/production); SIM builds the
 * simulated provider (stocks, ETFs and, with CRYPTO_FEED=sim, crypto); PROVIDER has no adapter yet (M3b), so the
 * provider is null and the startup step reports it clearly.
 */
@Module({
  controllers: [FeedController],
  providers: [
    {
      provide: PROVIDER,
      inject: [CONFIG, CLOCK],
      useFactory: (config: Config, clock: Clock): MarketDataProvider | null => {
        if (config.marketDataSource === 'FIXTURE') {
          return new FixtureProvider({ appEnv: config.appEnv, clock });
        }
        if (config.marketDataSource === 'SIM') {
          return new SimProvider({
            clock,
            seed: config.simSeed,
            crypto: config.cryptoFeed === 'sim',
            session: config.simSession,
          });
        }
        return null;
      },
    },
    FeedInfoService,
  ],
  exports: [PROVIDER, FeedInfoService],
})
export class FeedModule {}
