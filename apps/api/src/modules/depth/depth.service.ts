// Simulated market depth (M8b-2, D-98 to D-102). READ-ONLY and INFORMATIONAL: this module builds a book from the current
// validated quote with the pure `buildDepth`, and never writes anything. No order, reservation, fill, matcher tick or ledger
// posting reads from here (a test proves that fills are byte-identical with and without this module).
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import {
  DEPTH_DEFAULT_LEVELS,
  DEPTH_NOTE,
  DepthResponse,
  MyDepthOrdersResponse,
} from '@vantage/contracts';
import type { Config } from '@vantage/config';
import {
  EngineInputError,
  buildDepth,
  depthBucket,
  samePrice,
  spreadAndMid,
} from '@vantage/engine';
import type { Depth, DepthAssetClass } from '@vantage/engine';
import { parse } from '@vantage/money';
import { AppError } from '../../common/errors.js';
import { CLOCK, CONFIG, DEPTH_LIMITER, POOL } from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { InstrumentsService } from '../instruments/instruments.module.js';
import { QuoteService } from '../market-data/quote.service.js';

/** The freshness states a book is offered for (D-100): the feed's tradable states. */
const OFFERED = new Set(['REAL_TIME', 'DELAYED']);

/** The answer cache holds at most this many books (D-101): bounded memory, least recently used out first. */
export const DEPTH_CACHE_MAX = 256;

/** Cost points of one request (D-101): a book of up to 15 levels costs 1, a bigger one costs 2. */
export function depthCost(levels: number): number {
  return levels <= 15 ? 1 : 2;
}

const assetClassOf = (c: string): DepthAssetClass =>
  c === 'CRYPTO' ? 'CRYPTO' : c === 'ETF' ? 'ETF' : 'EQUITY';

interface CachedBook {
  readonly depth: Depth;
  readonly spread: string;
  readonly mid: string;
}

/** One resolved symbol: the answer, plus the ladder (null without levels) for the my-orders comparison. */
interface Resolved {
  readonly body: DepthResponse;
  readonly ladder: Depth | null;
}

@Injectable()
export class DepthService {
  readonly #cache = new Map<string, CachedBook>();
  hits = 0;
  misses = 0;

  constructor(
    @Inject(InstrumentsService) private readonly instruments: InstrumentsService,
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(DEPTH_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  /** Spends the cost of a request from `key`'s allowance or answers 429 (the candles style). */
  spend(key: string, levels: number): void {
    const cost = depthCost(levels);
    if (this.limiter.count(key) + cost > this.config.depthRateLimitPerMinute) {
      const retryAfter = this.limiter.retryAfterSeconds(key);
      throw new AppError(429, 'RATE_LIMITED', 'Too many depth requests. Try again shortly.', {
        'Retry-After': String(retryAfter),
      });
    }
    for (let i = 0; i < cost; i += 1) this.limiter.record(key);
  }

  cacheSize(): number {
    return this.#cache.size;
  }

  async #resolve(symbol: string, levels: number): Promise<Resolved> {
    const [row] = await this.instruments.findBySymbols([symbol]);
    if (row === undefined) throw new AppError(404, 'INSTRUMENT_NOT_FOUND', 'Instrument not found');
    const now = this.clock.now();
    const snap = await this.quotes.snapshotFor(row, now);
    const base = {
      symbol: row.symbol.toUpperCase(),
      freshness: snap.freshness,
      simulated: true as const,
      note: DEPTH_NOTE,
    };
    const none = (quoteAt: string | null): Resolved => ({
      body: DepthResponse.parse({ ...base, quoteAt, spread: null, mid: null, levels: null }),
      ladder: null,
    });
    // D-100: never a book from a stale, closed or missing quote
    if (snap.quote === null || !OFFERED.has(snap.freshness)) {
      return none(snap.quote === null ? null : snap.quote.providerTs.toISOString());
    }
    const q = snap.quote;
    const quoteAt = q.providerTs.toISOString();
    const bucket = depthBucket(q.providerTs.getTime());
    // The sizes depend on the bucket; the best bid and ask must be exactly the current quote, so they are part of the key.
    const key = `${base.symbol}|${bucket}|${levels}|${q.bid}|${q.ask}`;
    let book = this.#cache.get(key);
    if (book !== undefined) {
      this.#cache.delete(key); // refresh its place (least recently used goes first)
      this.#cache.set(key, book);
      this.hits += 1;
    } else {
      this.misses += 1;
      try {
        const depth = buildDepth(
          { bid: q.bid, ask: q.ask },
          {
            symbol: base.symbol,
            assetClass: assetClassOf(row.assetClass),
            tickSize: row.tickSize,
            qtyStep: row.qtyStep,
            minQty: row.minQty,
          },
          this.config.simSeed,
          levels,
          bucket,
        );
        const sm = spreadAndMid({ bid: q.bid, ask: q.ask });
        book = { depth, spread: sm.spread, mid: sm.mid };
      } catch (e) {
        // an off-grid or crossed quote cannot be shown as a book: the same answer as a quote with no book
        if (e instanceof EngineInputError) return none(quoteAt);
        throw e;
      }
      this.#cache.set(key, book);
      while (this.#cache.size > DEPTH_CACHE_MAX) {
        const oldest = this.#cache.keys().next().value;
        if (oldest === undefined) break;
        this.#cache.delete(oldest);
      }
    }
    return {
      body: DepthResponse.parse({
        ...base,
        quoteAt,
        spread: book.spread,
        mid: book.mid,
        levels: {
          bids: book.depth.bids.map((l) => ({ ...l })),
          asks: book.depth.asks.map((l) => ({ ...l })),
        },
      }),
      ladder: book.depth,
    };
  }

  async depth(symbol: string, levels: number = DEPTH_DEFAULT_LEVELS): Promise<DepthResponse> {
    return (await this.#resolve(symbol, levels)).body;
  }

  /**
   * The caller's OWN open LIMIT orders on `symbol` and where they sit on the displayed ladder (D-102). The comparison is exact
   * decimal equality of the limit price with a ladder price of the order's side (bids for a BUY, asks for a SELL): no
   * rounding, no tolerance. The query is scoped to the caller's MAIN account, so another user's orders are never read.
   */
  async myOrders(
    userId: string,
    symbol: string,
    levels: number = DEPTH_DEFAULT_LEVELS,
  ): Promise<MyDepthOrdersResponse> {
    const resolved = await this.#resolve(symbol, levels);
    const r = await this.pool.query<{
      id: string;
      side: 'BUY' | 'SELL';
      limit_price: string;
      qty: string;
    }>(
      `SELECT o.id, o.side::text AS side, o.limit_price, o.qty
         FROM orders o
         JOIN accounts a ON a.id = o.account_id
         JOIN instruments i ON i.id = o.instrument_id
        WHERE a.user_id = $1::uuid AND a.kind = 'MAIN' AND upper(i.symbol) = $2
          AND o.type = 'LIMIT' AND o.status = 'ACCEPTED'
        ORDER BY o.created_at, o.id`,
      [userId, resolved.body.symbol],
    );
    const orders = r.rows.map((o) => {
      const ladder =
        resolved.ladder === null
          ? []
          : o.side === 'BUY'
            ? resolved.ladder.bids
            : resolved.ladder.asks;
      const idx = ladder.findIndex((l) => samePrice(l.price, o.limit_price));
      return {
        orderId: o.id,
        side: o.side,
        price: parse(o.limit_price).toCanonicalString(),
        qty: parse(o.qty).toString(),
        onBook: idx >= 0,
        level: idx >= 0 ? idx + 1 : null,
      };
    });
    return MyDepthOrdersResponse.parse({
      symbol: resolved.body.symbol,
      freshness: resolved.body.freshness,
      orders,
    });
  }
}

export function newDepthLimiter(config: Config, clock: Clock): RateLimiter {
  return new RateLimiter({
    limit: config.depthRateLimitPerMinute,
    windowMs: 60_000,
    now: () => clock.now().getTime(),
  });
}
