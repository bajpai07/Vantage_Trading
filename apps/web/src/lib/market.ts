// Small, pure helpers for the search box and the instrument page: wording only, no money arithmetic.
import type { InstrumentItem, MarketStatusResponse } from '@vantage/contracts';
import type { z } from 'zod';
import type { InstrumentStatus as InstrumentStatusSchema } from '@vantage/contracts';
import { formatUtc } from './format';

export type InstrumentStatus = z.output<typeof InstrumentStatusSchema>;

export interface StatusView {
  readonly label: string;
  /** Shown on the instrument page: what the status means for you. null when there is nothing to explain. */
  readonly explanation: string | null;
  readonly tone: 'ok' | 'warn' | 'down';
  /** Orders to BUY are impossible in this status (a hard rule of the engine, not a hint). */
  readonly blocksBuy: boolean;
  readonly blocksSell: boolean;
}

/** Every instrument status of the API contract, explained. The Record type makes a missing one a compile error. */
export const STATUS_VIEWS: Readonly<Record<InstrumentStatus, StatusView>> = {
  ACTIVE: { label: 'Active', explanation: null, tone: 'ok', blocksBuy: false, blocksSell: false },
  HALTED: {
    label: 'Halted',
    explanation: 'Trading in this instrument is halted. Orders are not accepted until it resumes.',
    tone: 'down',
    blocksBuy: true,
    blocksSell: true,
  },
  SELL_ONLY: {
    label: 'Sell only',
    explanation: 'You can sell shares you already own, but you cannot buy more.',
    tone: 'warn',
    blocksBuy: true,
    blocksSell: false,
  },
  DELISTED: {
    label: 'Delisted',
    explanation: 'This instrument is delisted and can no longer be traded.',
    tone: 'down',
    blocksBuy: true,
    blocksSell: true,
  },
};

export const statusView = (s: InstrumentStatus): StatusView => STATUS_VIEWS[s];

/** "14 s ago", "3 min ago", "2 h ago". The input is the API's own ageSeconds; null means there is no quote. */
export function ageText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'no quote';
  if (seconds < 120) return `${String(seconds)} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 120) return `${String(minutes)} min ago`;
  return `${String(Math.floor(minutes / 60))} h ago`;
}

export const ASSET_CLASS_LABELS: Readonly<Record<InstrumentItem['assetClass'], string>> = {
  EQUITY: 'Stock',
  ETF: 'ETF',
  CRYPTO: 'Crypto',
  INDEX: 'Index',
  FX: 'Currency',
  COMMODITY: 'Commodity',
};

export interface MarketLine {
  readonly state: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  readonly text: string;
}

/** The open/closed line for one exchange from /v1/market/status. A missing exchange is UNKNOWN, never "open". */
export function marketLine(exchange: string, status: MarketStatusResponse | null): MarketLine {
  const e = status?.exchanges.find((x) => x.exchange === exchange);
  if (e === undefined) return { state: 'UNKNOWN', text: 'Market hours are not available.' };
  if (e.state === 'OPEN') {
    return {
      state: 'OPEN',
      text:
        e.nextClose === null
          ? `${e.name} is open.`
          : `${e.name} is open until ${formatUtc(e.nextClose)}${e.session === 'EARLY_CLOSE' ? ' (early close)' : ''}.`,
    };
  }
  const why = e.note === null ? '' : ` (${e.note})`;
  return {
    state: 'CLOSED',
    text:
      e.nextOpen === null
        ? `${e.name} is closed${why}.`
        : `${e.name} is closed${why}. Next open: ${formatUtc(e.nextOpen)}.`,
  };
}
