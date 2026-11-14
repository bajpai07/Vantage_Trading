// The candle source behind an interface (D-79). The only implementation is SimCandleProvider, which computes candles on
// demand from the pure SIM price function in @vantage/market-model: no table, no stored ticks, deterministic for
// (seed, symbol, interval, time range). A future real provider implements the same interface (and may need a table then).
import {
  SIM_UNIVERSE,
  buildCandles,
  referencePrice,
  sessionClosePrice,
} from '@vantage/market-model';
import type {
  Candle,
  CandleInterval,
  CandleSessions,
  PriceReference,
  SimInstrument,
} from '@vantage/market-model';
import type { SimSession } from '@vantage/config';
import type { CalendarService } from '../calendar.service.js';
import { SIM_SOURCE } from '../sim/sim.provider.js';

/** What a provider needs to know about an instrument (a row of the instrument master). */
export interface CandleInstrumentRef {
  readonly symbol: string;
  readonly exchange: string;
  readonly assetClass: string;
}

export interface CandleRequest {
  readonly instrument: CandleInstrumentRef;
  readonly interval: CandleInterval;
  /** Inclusive bounds on a candle's open time; null = open ended (to: until now). */
  readonly from: Date | null;
  readonly to: Date | null;
  /** 1 to 500: the newest `limit` candles of the range are returned. */
  readonly limit: number;
  /** The current instant, from the injected clock. */
  readonly now: Date;
}

export interface CandleBatch {
  /** The label of the data (SIM): a batch is never served without one. */
  readonly source: string;
  /** true when the candles and volumes are simulated, not market data. */
  readonly synthetic: boolean;
  /** Ascending by open time. */
  readonly candles: readonly Candle[];
  /** true when more candles matched than `limit`. */
  readonly truncated: boolean;
  /** Price evaluations the batch took (cost accounting; absent for providers that do not compute). */
  readonly evaluations: number;
}

export interface CandleProvider {
  readonly source: string;
  /** Can this provider serve candles for this instrument right now? */
  supports(instrument: CandleInstrumentRef): boolean;
  getCandles(req: CandleRequest): Promise<CandleBatch>;
  /** D-82: the reference price for the day change (previous session close, or the price 24 hours ago); null if none. */
  referencePrice(instrument: CandleInstrumentRef, now: Date): Promise<PriceReference | null>;
  /** D-83: the price of the instrument at an instant (a session close), as a decimal string; null if unknown. */
  priceAt(instrument: CandleInstrumentRef, instant: Date): Promise<string | null>;
}

export interface SimCandleProviderOptions {
  readonly seed: string;
  /** NYSE: stocks follow their exchange calendar. ALWAYS_OPEN (D-76): stocks are continuous. */
  readonly session: SimSession;
  /** CRYPTO_FEED=sim: crypto candles exist only when the crypto feed is on. */
  readonly crypto: boolean;
  readonly calendars: CalendarService;
}

const BY_SYMBOL: ReadonlyMap<string, SimInstrument> = new Map(
  SIM_UNIVERSE.map((i) => [i.symbol, i]),
);
const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);

export class SimCandleProvider implements CandleProvider {
  readonly source = SIM_SOURCE;
  readonly #opts: SimCandleProviderOptions;

  constructor(opts: SimCandleProviderOptions) {
    this.#opts = opts;
  }

  supports(i: CandleInstrumentRef): boolean {
    const def = BY_SYMBOL.get(i.symbol);
    return def !== undefined && (def.assetClass !== 'CRYPTO' || this.#opts.crypto);
  }

  /** Crypto and the 24/7 stock session are continuous; stocks otherwise follow the calendar of their exchange (D-81). */
  async #rule(
    def: SimInstrument,
    exchange: string,
  ): Promise<{ sessions: CandleSessions; gaps: boolean } | null> {
    if (def.assetClass === 'CRYPTO' || this.#opts.session === 'ALWAYS_OPEN') {
      return { sessions: { kind: 'CONTINUOUS' }, gaps: false };
    }
    const calendar = await this.#opts.calendars.get(exchange);
    if (calendar === undefined) return null;
    return { sessions: { kind: 'CALENDAR', calendar }, gaps: true };
  }

  async getCandles(req: CandleRequest): Promise<CandleBatch> {
    const def = BY_SYMBOL.get(req.instrument.symbol);
    const rule = def === undefined ? null : await this.#rule(def, req.instrument.exchange);
    if (def === undefined || rule === null) {
      return {
        source: this.source,
        synthetic: true,
        candles: [],
        truncated: false,
        evaluations: 0,
      };
    }
    const r = buildCandles({
      seed: this.#opts.seed,
      instrument: def,
      interval: req.interval,
      from: req.from === null ? null : seconds(req.from),
      to: req.to === null ? null : seconds(req.to),
      limit: req.limit,
      now: seconds(req.now),
      sessions: rule.sessions,
      gaps: rule.gaps,
    });
    return {
      source: this.source,
      synthetic: true,
      candles: r.candles,
      truncated: r.truncated,
      evaluations: r.evaluations,
    };
  }

  async referencePrice(i: CandleInstrumentRef, now: Date): Promise<PriceReference | null> {
    const def = BY_SYMBOL.get(i.symbol);
    if (def === undefined || !this.supports(i)) return null;
    const rule = await this.#rule(def, i.exchange);
    if (rule === null) return null;
    return referencePrice({
      seed: this.#opts.seed,
      instrument: def,
      now: seconds(now),
      sessions: rule.sessions,
      gaps: rule.gaps,
    });
  }

  async priceAt(i: CandleInstrumentRef, instant: Date): Promise<string | null> {
    const def = BY_SYMBOL.get(i.symbol);
    if (def === undefined || !this.supports(i)) return null;
    const rule = await this.#rule(def, i.exchange);
    if (rule === null) return null;
    return sessionClosePrice(this.#opts.seed, def, seconds(instant), rule.gaps);
  }
}
