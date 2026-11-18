// SIM provider (D-74, D-75, D-78): simulated quotes for stocks, ETFs and crypto, computed by the pure model in
// @vantage/market-model. It is an ordinary MarketDataProvider: a future live adapter (a licensed vendor, or a public
// exchange feed once its terms are confirmed in writing) implements the same interface and replaces it, with no change
// to the engine, the quote store, the validator or the API contracts.
//
// Every quote is labelled SIM and carries entitlement REAL_TIME (so the shared freshness function works unchanged);
// its price at an instant is a pure function of (seed, symbol, time). The clock is injected, never read here.
import { SIM_CRYPTO_QTY_STEP, SIM_UNIVERSE, simQuoteAt, tickString } from '@vantage/market-model';
import type { RawQuote, SimInstrument } from '@vantage/market-model';
import type { SimSession } from '@vantage/config';
import type { Clock } from '../../../tokens.js';
import type {
  InstrumentMasterEntry,
  MarketDataProvider,
  ProviderCapabilities,
  ProviderHealth,
} from '../provider.js';

export const SIM_SOURCE = 'SIM';

export interface SimProviderOptions {
  readonly clock: Clock;
  /** D-78: the price model is a function of this seed. */
  readonly seed: string;
  /** Publish simulated crypto quotes (CRYPTO_FEED=sim). Stocks and ETFs are always simulated by this provider. */
  readonly crypto: boolean;
  /** NYSE adds the small overnight gap at the open; ALWAYS_OPEN (D-76) is a session setting handled by the calendar. */
  readonly session: SimSession;
}

/** The attrs every simulated instrument carries (also written by migration 0024 for the crypto rows). */
export const SIM_INSTRUMENT_ATTRS = { source: SIM_SOURCE, simulated: true } as const;

export class SimProvider implements MarketDataProvider {
  readonly id = SIM_SOURCE;
  readonly #opts: SimProviderOptions;
  readonly #bySymbol: ReadonlyMap<string, SimInstrument>;

  constructor(opts: SimProviderOptions) {
    this.#opts = opts;
    this.#bySymbol = new Map(this.#active().map((i) => [i.symbol, i]));
  }

  #active(): SimInstrument[] {
    return SIM_UNIVERSE.filter((i) => i.assetClass !== 'CRYPTO' || this.#opts.crypto);
  }

  capabilities(): ProviderCapabilities {
    return {
      assetClasses: this.#opts.crypto ? ['EQUITY', 'ETF', 'CRYPTO'] : ['EQUITY', 'ETF'],
      entitlement: 'REAL_TIME',
      delaySeconds: 0,
      maxSymbols: 500,
    };
  }

  loadInstrumentMaster(): Promise<InstrumentMasterEntry[]> {
    return Promise.resolve(
      this.#active().map((i): InstrumentMasterEntry => {
        const crypto = i.assetClass === 'CRYPTO';
        return {
          symbol: i.symbol,
          name: i.name,
          assetClass: i.assetClass,
          exchange: i.exchange,
          quoteCurrency: 'USD',
          tickSize: tickString(i.tickDp),
          // stocks trade in whole shares (D-33); crypto trades in steps of 0.00000001 (M8, D-86)
          qtyStep: crypto ? SIM_CRYPTO_QTY_STEP : '1',
          minQty: crypto ? SIM_CRYPTO_QTY_STEP : '1',
          fractionalOk: crypto,
          status: 'ACTIVE',
          providerSymbol: i.symbol,
          tradableIn: ['MVP'], // stocks since M4b, crypto since M8 (D-89)
          ...(i.baseAsset === undefined ? {} : { baseAsset: i.baseAsset }),
          attrs: SIM_INSTRUMENT_ATTRS,
        };
      }),
    );
  }

  getSnapshot(symbols: readonly string[]): Promise<RawQuote[]> {
    const now = this.#opts.clock.now();
    const t = Math.floor(now.getTime() / 1000);
    const providerTs = new Date(t * 1000);
    const out: RawQuote[] = [];
    for (const symbol of symbols) {
      const inst = this.#bySymbol.get(symbol);
      if (inst === undefined) continue; // unknown to the simulation: no quote (never a made-up price)
      const q = simQuoteAt(this.#opts.seed, inst, t, { gaps: this.#opts.session === 'NYSE' });
      out.push({
        symbol,
        bid: q.bid,
        ask: q.ask,
        last: q.last,
        providerTs,
        receivedAt: now,
        source: SIM_SOURCE,
        entitlement: 'REAL_TIME',
        delaySeconds: 0,
      });
    }
    return Promise.resolve(out);
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({ status: 'OK', asOf: this.#opts.clock.now() });
  }
}
