// Serves candles (M7b T2): validates nothing itself (the controller's pipe did), resolves the instrument, asks the candle
// provider, labels the answer, and keeps a small bounded cache of answers that can never change again.
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_CANDLES_PER_REQUEST } from '@vantage/contracts';
import type { CandlesQuery, CandlesResponse } from '@vantage/contracts';
import { maxEvaluations } from '@vantage/market-model';
import type { CandleInterval, PriceReference } from '@vantage/market-model';
import { AppError } from '../../../common/errors.js';
import { CANDLE_PROVIDER, CLOCK } from '../../../tokens.js';
import type { Clock } from '../../../tokens.js';
import { FeedInfoService } from '../../feed/feed.module.js';
import { InstrumentsService } from '../../instruments/instruments.module.js';
import type { CandleInstrumentRef, CandleProvider } from './candle.provider.js';

export interface CandlesResult {
  readonly body: CandlesResponse;
  /**
   * true when every candle is closed AND the range is fully in the past: the answer can never change (D-81), so it may
   * be cached by the client and carries an ETag.
   */
  readonly immutable: boolean;
  /** Strong ETag of the body (immutable answers only). */
  readonly etag: string | null;
  /** Rate-limit cost points of this request. */
  readonly cost: number;
  /** Price evaluations this answer took (0 on a cache hit). */
  readonly evaluations: number;
  readonly cacheHit: boolean;
}

/** Cost points per request: proportional to the most work it can need (a maximum daily request is 8). */
export function candleCost(interval: CandleInterval, limit: number): number {
  return Math.max(1, Math.ceil(maxEvaluations(interval, limit) / 20_000));
}

/** At most this many candles are held in the answer cache (bounded memory: about 60,000 small objects). */
export const CANDLE_CACHE_MAX_CANDLES = 60_000;

@Injectable()
export class CandleService {
  readonly #cache = new Map<string, { body: CandlesResponse; etag: string }>();
  #cached = 0;

  constructor(
    @Inject(CANDLE_PROVIDER) private readonly provider: CandleProvider | null,
    @Inject(InstrumentsService) private readonly instruments: InstrumentsService,
    @Inject(FeedInfoService) private readonly feed: FeedInfoService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The provider, if it can serve this instrument right now (the feed switched on, the class served). */
  #providerFor(instrument: CandleInstrumentRef): CandleProvider | null {
    if (this.provider === null || !this.feed.get().enabled) return null;
    return this.provider.supports(instrument) ? this.provider : null;
  }

  async candles(q: CandlesQuery): Promise<CandlesResult> {
    const [row] = await this.instruments.findBySymbols([q.symbol]);
    if (row === undefined) throw new AppError(404, 'INSTRUMENT_NOT_FOUND', 'Instrument not found');
    const ref: CandleInstrumentRef = {
      symbol: row.symbol,
      exchange: row.exchange,
      assetClass: row.assetClass,
    };
    const provider = this.#providerFor(ref);
    if (provider === null) {
      throw new AppError(
        404,
        'CANDLES_UNAVAILABLE',
        'There is no candle history for this instrument right now',
      );
    }
    const limit = q.limit ?? DEFAULT_CANDLES_PER_REQUEST;
    const now = this.clock.now();
    const cost = candleCost(q.interval, limit);
    const inPast = q.to !== undefined && Date.parse(q.to) <= now.getTime();
    const key = [row.symbol, q.interval, q.from ?? '', q.to ?? '', limit].join('|');
    if (inPast) {
      const hit = this.#cache.get(key);
      if (hit !== undefined) {
        this.#cache.delete(key); // refresh its place (least recently used goes first)
        this.#cache.set(key, hit);
        return {
          body: hit.body,
          immutable: true,
          etag: hit.etag,
          cost,
          evaluations: 0,
          cacheHit: true,
        };
      }
    }
    const batch = await provider.getCandles({
      instrument: ref,
      interval: q.interval,
      from: q.from === undefined ? null : new Date(q.from),
      to: q.to === undefined ? null : new Date(q.to),
      limit,
      now,
    });
    const body: CandlesResponse = {
      symbol: row.symbol,
      interval: q.interval,
      source: batch.source,
      synthetic: batch.synthetic,
      truncated: batch.truncated,
      candles: batch.candles.map((c) => ({
        t: new Date(c.t * 1000).toISOString(),
        o: c.o,
        h: c.h,
        l: c.l,
        c: c.c,
        v: c.v,
        closed: c.closed,
      })),
    };
    const immutable = inPast && batch.candles.every((c) => c.closed);
    let etag: string | null = null;
    if (immutable) {
      etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('base64url')}"`;
      this.#remember(key, body, etag);
    }
    return { body, immutable, etag, cost, evaluations: batch.evaluations, cacheHit: false };
  }

  #remember(key: string, body: CandlesResponse, etag: string): void {
    this.#cache.set(key, { body, etag });
    this.#cached += body.candles.length;
    for (const [k, v] of this.#cache) {
      if (this.#cached <= CANDLE_CACHE_MAX_CANDLES || this.#cache.size <= 1) break;
      this.#cache.delete(k);
      this.#cached -= v.body.candles.length;
    }
  }

  /** Candles currently held in the cache (a test reads it to show the bound). */
  cachedCandles(): number {
    return this.#cached;
  }

  /** D-82: the reference price for an instrument, or null (no provider, no history, feed off). */
  async referencePrice(ref: CandleInstrumentRef, now: Date): Promise<PriceReference | null> {
    return (await this.#providerFor(ref)?.referencePrice(ref, now)) ?? null;
  }

  /** D-83: the price of an instrument at an instant (a session close), or null. */
  async priceAt(ref: CandleInstrumentRef, instant: Date): Promise<string | null> {
    return (await this.#providerFor(ref)?.priceAt(ref, instant)) ?? null;
  }
}
