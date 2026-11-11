import type { PendingGap, Quote } from '@vantage/market-model';

/** Everything the pipeline remembers about one symbol. */
export interface QuoteState {
  /** The last ACCEPTED quote; null if none has ever been accepted. */
  readonly lastAccepted: Quote | null;
  /** An outlier tick held until a second consecutive tick confirms it. */
  readonly pending: PendingGap | null;
}

/**
 * Where validated quotes live (D-46). The interface is async so a Redis implementation can replace the
 * in-memory one when real-time fan-out or several processes need it.
 */
export interface QuoteStore {
  get(symbol: string): Promise<QuoteState | undefined>;
  set(symbol: string, state: QuoteState): Promise<void>;
  symbols(): Promise<string[]>;
}

/** Single-process store. State is lost on restart, which only means UNAVAILABLE until the next snapshot. */
export class InMemoryQuoteStore implements QuoteStore {
  readonly #states = new Map<string, QuoteState>();

  get(symbol: string): Promise<QuoteState | undefined> {
    return Promise.resolve(this.#states.get(symbol));
  }
  set(symbol: string, state: QuoteState): Promise<void> {
    this.#states.set(symbol, state);
    return Promise.resolve();
  }
  symbols(): Promise<string[]> {
    return Promise.resolve([...this.#states.keys()]);
  }
}
