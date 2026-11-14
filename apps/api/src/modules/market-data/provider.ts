// The provider abstraction (MARKET_DATA section 4), trimmed to what M3a needs: no candles, no subscriptions.
import type { Entitlement, InstrumentStatus, RawQuote } from '@vantage/market-model';

export interface ProviderCapabilities {
  readonly assetClasses: readonly string[];
  readonly entitlement: Entitlement;
  /** Declared vendor delay in seconds (0 for real time). */
  readonly delaySeconds: number;
  readonly maxSymbols: number;
}

/** One instrument as a provider describes it. The sync job reconciles these into `instruments`. */
export interface InstrumentMasterEntry {
  readonly symbol: string;
  readonly name: string;
  readonly assetClass: 'EQUITY' | 'ETF' | 'CRYPTO';
  /** Crypto only: the base asset, for example BTC. */
  readonly baseAsset?: string;
  /** Market identifier code, e.g. XNAS. */
  readonly exchange: string;
  readonly quoteCurrency: string;
  readonly tickSize: string;
  readonly qtyStep: string;
  readonly minQty: string;
  readonly fractionalOk: boolean;
  /** DELISTED means the provider explicitly reports the delisting. Absence from the master does not. */
  readonly status: InstrumentStatus;
  readonly providerSymbol: string;
  readonly tradableIn?: readonly string[];
  readonly attrs: Readonly<Record<string, unknown>>;
}

export interface ProviderHealth {
  readonly status: 'OK' | 'DEGRADED' | 'DOWN';
  readonly asOf: Date;
}

export interface MarketDataProvider {
  /** Also the `source` label on every quote and the key in `instrument_provider_map.provider`. */
  readonly id: string;
  capabilities(): ProviderCapabilities;
  loadInstrumentMaster(): Promise<InstrumentMasterEntry[]>;
  /** Takes provider symbols, returns raw (unvalidated) quotes. */
  getSnapshot(symbols: readonly string[]): Promise<RawQuote[]>;
  health(): Promise<ProviderHealth>;
}

export class ProviderNotInstalledError extends Error {
  constructor() {
    super('no provider adapter installed; M3b');
    this.name = 'ProviderNotInstalledError';
  }
}
