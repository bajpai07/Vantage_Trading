// provider quote -> normalise -> validate -> store, with per-feed counters and a degradation signal.
import { validateQuote } from '@vantage/market-model';
import type { RawQuote, RejectReason, ValidationResult } from '@vantage/market-model';
import type { Logger } from '../../log.js';
import type { Clock } from '../../tokens.js';
import type { QuoteStore } from './quote.store.js';

export type FeedStatus = 'HEALTHY' | 'DEGRADED';

export interface FeedCounters {
  received: number;
  accepted: number;
  rejected: Partial<Record<RejectReason, number>>;
  /** Same as rejected.OUT_OF_ORDER, kept as its own counter as MARKET_DATA section 6 asks. */
  outOfOrder: number;
  /** Accepted quotes whose price was off the tick (warning only). */
  warnings: number;
}

export interface IngestOptions {
  /** Rolling window for the rejection rate. MARKET_DATA section 6 says 5 minutes. */
  readonly windowMs?: number;
}

/** A feed is DEGRADED when rejected > 1% of received inside the window (integer arithmetic). */
const DEGRADED_PERCENT = 1;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

export class QuoteIngest {
  readonly #counters = new Map<string, FeedCounters>();
  readonly #window = new Map<string, Array<{ t: number; rejected: boolean }>>();
  readonly #status = new Map<string, FeedStatus>();
  readonly #windowMs: number;

  constructor(
    private readonly store: QuoteStore,
    private readonly clock: Clock,
    private readonly logger: Logger,
    options: IngestOptions = {},
  ) {
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * Ingests one raw quote. `symbol` is the canonical symbol the store is keyed by (the provider symbol is
   * mapped by the caller). The provider timestamp is already an absolute UTC instant (Date); a Date that
   * is invalid is rejected as MALFORMED by the validator.
   */
  async ingest(symbol: string, raw: RawQuote, tickSize?: string): Promise<ValidationResult> {
    const now = this.clock.now();
    const normalised: RawQuote = { ...raw, symbol, receivedAt: now };
    const state = await this.store.get(symbol);
    const result = validateQuote(
      normalised,
      state?.lastAccepted ?? null,
      state?.pending ?? null,
      now,
      tickSize === undefined ? {} : { tickSize },
    );
    await this.store.set(symbol, {
      lastAccepted: result.accepted ? result.quote : (state?.lastAccepted ?? null),
      pending: result.nextPending,
    });
    this.#count(raw.source, symbol, result, now.getTime());
    return result;
  }

  counters(source: string): FeedCounters {
    const c = this.#counters.get(source);
    return c === undefined
      ? { received: 0, accepted: 0, rejected: {}, outOfOrder: 0, warnings: 0 }
      : { ...c, rejected: { ...c.rejected } };
  }

  feedStatus(source: string): FeedStatus {
    this.#prune(source, this.clock.now().getTime());
    return this.#evaluate(source);
  }

  #count(source: string, symbol: string, result: ValidationResult, nowMs: number): void {
    const c = this.#counters.get(source) ?? {
      received: 0,
      accepted: 0,
      rejected: {},
      outOfOrder: 0,
      warnings: 0,
    };
    c.received += 1;
    if (result.accepted) {
      c.accepted += 1;
      if (result.warnings.length > 0) c.warnings += 1;
    } else {
      c.rejected[result.reason] = (c.rejected[result.reason] ?? 0) + 1;
      if (result.reason === 'OUT_OF_ORDER') c.outOfOrder += 1;
      // symbol and reason only: never prices or raw payloads in logs
      this.logger.debug('quote_rejected', { source, symbol, reason: result.reason });
    }
    this.#counters.set(source, c);

    const events = this.#window.get(source) ?? [];
    events.push({ t: nowMs, rejected: !result.accepted });
    this.#window.set(source, events);
    this.#prune(source, nowMs);
    const before = this.#status.get(source) ?? 'HEALTHY';
    const after = this.#evaluate(source);
    if (after !== before) {
      this.logger.warn('feed_status_changed', { source, from: before, to: after });
    }
    this.#status.set(source, after);
  }

  #prune(source: string, nowMs: number): void {
    const events = this.#window.get(source);
    if (events === undefined) return;
    const cutoff = nowMs - this.#windowMs;
    this.#window.set(
      source,
      events.filter((e) => e.t > cutoff),
    );
  }

  #evaluate(source: string): FeedStatus {
    const events = this.#window.get(source) ?? [];
    const rejected = events.filter((e) => e.rejected).length;
    return events.length > 0 && rejected * 100 > events.length * DEGRADED_PERCENT
      ? 'DEGRADED'
      : 'HEALTHY';
  }
}
