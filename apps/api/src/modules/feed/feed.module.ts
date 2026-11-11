import { Inject, Injectable, Module } from '@nestjs/common';
import type { Config } from '@vantage/config';
import type { Entitlement } from '@vantage/market-model';
import type { Clock } from '../../tokens.js';
import { CLOCK, CONFIG, PROVIDER } from '../../tokens.js';
import { FixtureProvider } from '../market-data/fixture/fixture.provider.js';
import { ProviderNotInstalledError } from '../market-data/provider.js';
import type { MarketDataProvider } from '../market-data/provider.js';

export interface FeedInfo {
  /** The label every quote and instrument answer carries, e.g. FIXTURE. */
  readonly source: string;
  readonly entitlement: Entitlement;
  readonly delaySeconds: number;
  /** false when a kill switch has disabled the feed: quotes are then UNAVAILABLE. */
  readonly enabled: boolean;
}

/** Describes the active data feed. The one place the rest of the API learns about the source. */
@Injectable()
export class FeedInfoService {
  #enabled = true;

  constructor(@Inject(PROVIDER) private readonly provider: MarketDataProvider | null) {}

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
}

/**
 * The provider factory: FIXTURE builds the FixtureProvider (which itself refuses staging/production);
 * PROVIDER has no adapter yet (M3b), so the provider is null and the startup step reports it clearly.
 */
@Module({
  providers: [
    {
      provide: PROVIDER,
      inject: [CONFIG, CLOCK],
      useFactory: (config: Config, clock: Clock): MarketDataProvider | null =>
        config.marketDataSource === 'FIXTURE'
          ? new FixtureProvider({ appEnv: config.appEnv, clock })
          : null,
    },
    FeedInfoService,
  ],
  exports: [PROVIDER, FeedInfoService],
})
export class FeedModule {}
