import type { FreshnessState as FreshnessStateSchema } from '@vantage/contracts';
import type { z } from 'zod';

/** The freshness states of the API contract. */
export type FreshnessState = z.output<typeof FreshnessStateSchema>;

export interface FreshnessView {
  /** The label shown in the badge. */
  readonly label: string;
  /** What the state means, in a sentence (badge tooltip). */
  readonly description: string;
  /** Design token family for the dot and text. */
  readonly tone: 'up' | 'warn' | 'stale' | 'muted' | 'down';
}

/**
 * Every freshness state the API can send has a label, a tone and a meaning. The Record type makes a missing state a
 * compile error, and a unit test enumerates the contract's own list.
 */
export const FRESHNESS: Readonly<Record<FreshnessState, FreshnessView>> = {
  REAL_TIME: { label: 'REAL-TIME', description: 'A live quote.', tone: 'up' },
  DELAYED: {
    label: 'DELAYED',
    description: 'A quote delayed by the data feed (it is labelled with its own time).',
    tone: 'warn',
  },
  STALE: {
    label: 'STALE',
    description: 'The latest quote is older than it should be. It is shown, but do not rely on it.',
    tone: 'stale',
  },
  CLOSED: {
    label: 'CLOSED',
    description: 'The market is closed: this is the last price from the close.',
    tone: 'muted',
  },
  UNAVAILABLE: {
    label: 'UNAVAILABLE',
    description: 'No usable price. This position is not included in the totals.',
    tone: 'down',
  },
};

export const freshnessView = (state: FreshnessState): FreshnessView => FRESHNESS[state];
