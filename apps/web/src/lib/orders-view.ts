// How an order is shown (M8b-1): status chips, the Limit/Market type label, and the sentence after a cancel. Strings in, strings out:
// no arithmetic, no number conversion. Colour is never the only signal: every chip has a glyph and a word.
import type { OrderResponse } from '@vantage/contracts';
import { formatMoney, formatPrice, formatQty, isZeroDecimal } from './money';

export type OrderStatusName = OrderResponse['status'];

export interface StatusChip {
  readonly label: string;
  readonly glyph: string;
  /** Tailwind text colour class (a token of the design system). */
  readonly tone: string;
}

export const STATUS_CHIPS: Readonly<Record<OrderStatusName, StatusChip>> = {
  ACCEPTED: { label: 'Accepted', glyph: '●', tone: 'text-accent' },
  FILLED: { label: 'Filled', glyph: '✓', tone: 'text-up' },
  CANCELLED: { label: 'Cancelled', glyph: '—', tone: 'text-text-2' },
  EXPIRED: { label: 'Expired', glyph: '◷', tone: 'text-text-2' },
  REJECTED: { label: 'Rejected', glyph: '✕', tone: 'text-down' },
};

/** "Limit 89,900.00 (GTC)" for a limit order, "Market" otherwise. */
export function typeLabel(o: Pick<OrderResponse, 'type' | 'limitPrice' | 'tif'>): string {
  if (o.type === 'LIMIT' && o.limitPrice !== null) {
    return `Limit ${formatPrice(o.limitPrice)} (${o.tif})`;
  }
  return 'Market';
}

/** What is held for an open order: cash for a BUY, the quantity for a SELL; null when nothing is held. */
export function heldLabel(
  o: Pick<OrderResponse, 'side' | 'reservedUsd' | 'qty' | 'symbol'>,
): string | null {
  if (o.side === 'BUY')
    return isZeroDecimal(o.reservedUsd) ? null : `${formatMoney(o.reservedUsd)} cash`;
  return `${formatQty(o.qty)} ${o.symbol}`;
}

/** The sentence shown after a cancel, from what the API says it released. */
export function releasedSentence(
  released: NonNullable<OrderResponse['released']>,
  symbol: string,
): string {
  return isZeroDecimal(released.usd)
    ? `Cancelled. ${formatQty(released.qty)} ${symbol} is free to sell again.`
    : `Cancelled. ${formatMoney(released.usd)} is back in your cash.`;
}
