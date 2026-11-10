/**
 * A small sliding-window counter, in memory. Pure apart from the injected clock.
 * LIMITATION: state lives in this process only. With several API processes each has its own counters,
 * and a restart clears them. A shared store (Redis) replaces this later.
 */
export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly now: () => number;
}

const SWEEP_EVERY = 500;

export class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #opts: RateLimiterOptions;
  #records = 0;

  constructor(opts: RateLimiterOptions) {
    this.#opts = opts;
  }

  /** Events for `key` inside the window. */
  count(key: string): number {
    return this.#live(key).length;
  }

  /** True when `key` has used up its allowance. */
  isBlocked(key: string): boolean {
    return this.count(key) >= this.#opts.limit;
  }

  /** Records one event. */
  record(key: string): void {
    const live = this.#live(key);
    live.push(this.#opts.now());
    this.#hits.set(key, live);
    this.#records += 1;
    if (this.#records % SWEEP_EVERY === 0) this.sweep();
  }

  /** Records one event unless blocked. Returns whether it was allowed. */
  tryConsume(key: string): boolean {
    if (this.isBlocked(key)) return false;
    this.record(key);
    return true;
  }

  /** Whole seconds until the oldest counted event leaves the window (at least 1). */
  retryAfterSeconds(key: string): number {
    const live = this.#live(key);
    const oldest = live[0];
    if (oldest === undefined) return 1;
    const ms = oldest + this.#opts.windowMs - this.#opts.now();
    return Math.max(1, Math.ceil(ms / 1000));
  }

  /** Drops keys whose events have all expired. */
  sweep(): void {
    for (const key of [...this.#hits.keys()]) this.#live(key);
  }

  get size(): number {
    return this.#hits.size;
  }

  #live(key: string): number[] {
    const cutoff = this.#opts.now() - this.#opts.windowMs;
    const live = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (live.length === 0) this.#hits.delete(key);
    else this.#hits.set(key, live);
    return live;
  }
}

export const LIMITS = {
  /** Failed logins per (IP, email) in 15 minutes. */
  loginPair: { limit: 5, windowMs: 15 * 60 * 1000 },
  /** Failed logins per IP in 15 minutes. */
  loginIp: { limit: 20, windowMs: 15 * 60 * 1000 },
  /** Registration attempts per IP in one hour. */
  register: { limit: 10, windowMs: 60 * 60 * 1000 },
} as const;
