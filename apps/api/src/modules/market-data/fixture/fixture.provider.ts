// FIXTURE provider: deterministic, synthetic, for local and test ONLY. It refuses to be built in
// staging or production, and every quote it emits is labelled source FIXTURE.
import type { AppEnv } from '@vantage/config';
import type { RawQuote } from '@vantage/market-model';
import { add, mul, parse, sub } from '@vantage/money';
import type { Clock } from '../../../tokens.js';
import type {
  InstrumentMasterEntry,
  MarketDataProvider,
  ProviderCapabilities,
  ProviderHealth,
} from '../provider.js';
import { FIXTURE_INSTRUMENTS, FIXTURE_PRICE_STEP, FIXTURE_SPREAD } from './fixture.data.js';

export const FIXTURE_SOURCE = 'FIXTURE';
export const FIXTURE_DELAY_SECONDS = 900;

export class FixtureForbiddenError extends Error {
  constructor(appEnv: string) {
    super(`FixtureProvider must not be constructed when APP_ENV is ${appEnv}`);
    this.name = 'FixtureForbiddenError';
  }
}

/** What the next snapshot of one symbol should look like. Used by tests to exercise bad feeds. */
export type FixtureStep =
  | { readonly kind: 'normal' }
  | { readonly kind: 'stale'; readonly extraSeconds?: number }
  | { readonly kind: 'crossed' }
  | { readonly kind: 'outlier'; readonly factor: string }
  | { readonly kind: 'future'; readonly seconds?: number }
  | { readonly kind: 'out_of_order'; readonly seconds?: number }
  | { readonly kind: 'negative_size' }
  | { readonly kind: 'non_positive' };

export class FixtureProvider implements MarketDataProvider {
  readonly id = FIXTURE_SOURCE;
  readonly #clock: Clock;
  readonly #scripts = new Map<string, FixtureStep[]>();
  #extraEntries: InstrumentMasterEntry[] = [];

  constructor(opts: { appEnv: AppEnv; clock: Clock }) {
    if (opts.appEnv === 'staging' || opts.appEnv === 'production') {
      throw new FixtureForbiddenError(opts.appEnv);
    }
    this.#clock = opts.clock;
  }

  capabilities(): ProviderCapabilities {
    return {
      assetClasses: ['EQUITY', 'ETF'],
      entitlement: 'DELAYED',
      delaySeconds: FIXTURE_DELAY_SECONDS,
      maxSymbols: 500,
    };
  }

  /** Queue steps for a symbol; each getSnapshot consumes one step for it (then back to normal). */
  script(symbol: string, steps: readonly FixtureStep[]): void {
    this.#scripts.set(symbol, [...steps]);
  }

  /** Test helper: add or replace master entries (e.g. an explicit delisting). */
  setExtraEntries(entries: readonly InstrumentMasterEntry[]): void {
    this.#extraEntries = [...entries];
  }

  loadInstrumentMaster(): Promise<InstrumentMasterEntry[]> {
    const base: InstrumentMasterEntry[] = FIXTURE_INSTRUMENTS.map((i) => ({
      symbol: i.symbol,
      name: i.name,
      assetClass: i.assetClass,
      exchange: i.exchange,
      quoteCurrency: 'USD',
      tickSize: '0.01',
      qtyStep: '1',
      minQty: '1',
      fractionalOk: false,
      status: 'ACTIVE',
      providerSymbol: i.symbol,
      tradableIn: ['MVP'],
      attrs: { source: FIXTURE_SOURCE, synthetic: true },
    }));
    const extra = new Map(this.#extraEntries.map((e) => [`${e.exchange}:${e.symbol}`, e]));
    const merged = base.map((b) => extra.get(`${b.exchange}:${b.symbol}`) ?? b);
    for (const e of this.#extraEntries) {
      if (!base.some((b) => b.exchange === e.exchange && b.symbol === e.symbol)) merged.push(e);
    }
    return Promise.resolve(merged);
  }

  getSnapshot(symbols: readonly string[]): Promise<RawQuote[]> {
    const now = this.#clock.now();
    const out: RawQuote[] = [];
    for (const symbol of symbols) {
      const index = FIXTURE_INSTRUMENTS.findIndex((i) => i.symbol === symbol);
      if (index < 0) continue; // unknown to the fixture: no quote (never a made-up price)
      const step = this.#scripts.get(symbol)?.shift() ?? { kind: 'normal' as const };
      out.push(this.#quote(symbol, index, step, now));
    }
    return Promise.resolve(out);
  }

  health(): Promise<ProviderHealth> {
    return Promise.resolve({ status: 'OK', asOf: this.#clock.now() });
  }

  #quote(symbol: string, index: number, step: FixtureStep, now: Date): RawQuote {
    const delayMs = FIXTURE_DELAY_SECONDS * 1000;
    // The provider timestamp of a delayed feed is the delay in the past.
    let ts = new Date(now.getTime() - delayMs);
    const base = mul(parse(String(index + 1)), parse(FIXTURE_PRICE_STEP));
    let bid = base;
    let ask = add(base, parse(FIXTURE_SPREAD));
    let bidSize: string | undefined;
    switch (step.kind) {
      case 'normal':
        break;
      case 'stale':
        ts = new Date(ts.getTime() - (step.extraSeconds ?? 120) * 1000);
        break;
      case 'crossed':
        bid = add(base, parse('0.05'));
        ask = base;
        break;
      case 'outlier': {
        const f = parse(step.factor);
        bid = mul(base, f).round(2, 'HALF_EVEN');
        ask = add(bid, parse(FIXTURE_SPREAD));
        break;
      }
      case 'future':
        ts = new Date(now.getTime() + (step.seconds ?? 10) * 1000);
        break;
      case 'out_of_order':
        ts = new Date(ts.getTime() - (step.seconds ?? 300) * 1000);
        break;
      case 'negative_size':
        bidSize = '-1';
        break;
      case 'non_positive':
        bid = sub(base, base);
        break;
    }
    return {
      symbol,
      bid: bid.toString(),
      ask: ask.toString(),
      last: bid.toString(),
      ...(bidSize === undefined ? {} : { bidSize }),
      providerTs: ts,
      receivedAt: now,
      source: FIXTURE_SOURCE,
      entitlement: 'DELAYED',
      delaySeconds: FIXTURE_DELAY_SECONDS,
    };
  }
}
