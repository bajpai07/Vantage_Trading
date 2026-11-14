// The order ticket as a pure state machine (M6b T4). No React, no fetch, no clock, no money arithmetic: every number on
// the ticket is a string the API sent. The component only dispatches events and renders the state.
//
//   idle --openReview--> review --submitStart--> submitting --submitDone--> done (FILLED or REJECTED)
//                          ^  |                       |-- submitRetryable --> review (same attempt, same key)
//                          |  |-- cancelReview/edit --> idle   |-- submitFailed --> done (error, key discarded)
//
// D-72 (idempotency key lifecycle):
//   * a NEW key is created when the user opens the review step (openReview) and only then;
//   * the same attempt, and so the same key, is reused on every retry after a network error, timeout, 5xx or 429;
//   * the key is DISCARDED after a definitive answer (a fill, a reject, a 4xx) and whenever the user edits side,
//     quantity or symbol, or cancels the review: the next review gets a new key.
// D-71: the referencePrice of an attempt is the ask (BUY) or bid (SELL) of the quote behind the preview that was on
// screen when the user pressed Review; the user never types it.
import { MAX_ORDER_QTY } from '@vantage/contracts';
import type { OrderPreviewResponse, OrderResponse, QuoteItem } from '@vantage/contracts';
import type { ApiFailure } from './api-core';
import { formatQty } from './money';
import { statusView } from './market';
import type { InstrumentStatus } from './market';
import { rejectMessage } from './reject-copy';

export type Side = 'BUY' | 'SELL';

/** Most digits a quantity can have (MAX_ORDER_QTY has 7). */
export const MAX_QTY_DIGITS = String(MAX_ORDER_QTY).length;

/**
 * Keeps only digits, drops leading zeros and caps the length: a quantity is a whole number of shares, so decimals,
 * exponents, signs and spaces can never be entered (a paste of "1.5" becomes "15" in the field; the paste handler of
 * the component refuses such text outright instead, see isDigitsOnly).
 */
export function sanitizeQty(raw: string): string {
  return raw.replace(/\D/g, '').replace(/^0+/, '').slice(0, MAX_QTY_DIGITS);
}

export const isDigitsOnly = (text: string): boolean => /^\d+$/.test(text);

/** Is this digit string above the maximum order size? (String comparison: no number conversion.) */
export function qtyTooLarge(qty: string): boolean {
  const max = String(MAX_ORDER_QTY);
  return qty.length > max.length || (qty.length === max.length && qty > max);
}

export const qtyEmpty = (qty: string): boolean => qty === '' || /^0+$/.test(qty);

/** The price the order is judged against (D-71): the ask for a BUY, the bid for a SELL; null without a usable quote. */
export function referencePriceFor(
  side: Side,
  quote: Pick<QuoteItem, 'bid' | 'ask'>,
): string | null {
  const p = side === 'BUY' ? quote.ask : quote.bid;
  return p === undefined ? null : p;
}

// ---- state -------------------------------------------------------------------------------------------------------

export interface PreviewState {
  readonly status: 'none' | 'loading' | 'ready' | 'error';
  readonly data: OrderPreviewResponse | null;
  readonly failure: ApiFailure | null;
  /** What the preview on screen was asked for. A preview for anything else is not shown. */
  readonly for: {
    readonly side: Side;
    readonly qty: string;
    readonly referencePrice: string;
  } | null;
  /** Only the newest request may update the state. */
  readonly requestId: number;
}

export interface Attempt {
  readonly key: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: string;
  readonly referencePrice: string;
  /** The estimate the user reviewed (frozen: it does not change while they are reviewing). */
  readonly estimate: OrderPreviewResponse;
}

export type Outcome =
  | { readonly kind: 'filled' | 'rejected'; readonly order: OrderResponse }
  | { readonly kind: 'retryable'; readonly failure: ApiFailure }
  | { readonly kind: 'failed'; readonly failure: ApiFailure };

export type Phase = 'idle' | 'review' | 'submitting' | 'done';

export interface TicketState {
  readonly side: Side;
  readonly qty: string;
  readonly preview: PreviewState;
  readonly phase: Phase;
  readonly attempt: Attempt | null;
  readonly outcome: Outcome | null;
}

export const initialPreview: PreviewState = {
  status: 'none',
  data: null,
  failure: null,
  for: null,
  requestId: 0,
};

export const initialTicket: TicketState = {
  side: 'BUY',
  qty: '',
  preview: initialPreview,
  phase: 'idle',
  attempt: null,
  outcome: null,
};

export type TicketAction =
  | { type: 'setSide'; side: Side }
  | { type: 'setQty'; qty: string }
  | { type: 'previewStart'; requestId: number; for: NonNullable<PreviewState['for']> }
  | { type: 'previewOk'; requestId: number; data: OrderPreviewResponse }
  | { type: 'previewFail'; requestId: number; failure: ApiFailure }
  | { type: 'previewClear' }
  | { type: 'openReview'; key: string; symbol: string }
  | { type: 'cancelReview' }
  | { type: 'submitStart' }
  | { type: 'submitDone'; order: OrderResponse }
  | { type: 'submitRetryable'; failure: ApiFailure }
  | { type: 'submitFailed'; failure: ApiFailure }
  | { type: 'reviewAgain' }
  | { type: 'reset' };

/** Failures after which the order may or may not have been placed: retrying with the SAME key is safe (D-72). */
export function isRetryable(f: ApiFailure): boolean {
  return (
    f.kind === 'network' ||
    f.kind === 'server' ||
    f.kind === 'rate_limited' ||
    f.kind === 'invalid_response'
  );
}

/** An edit while reviewing closes the review and discards the attempt and the estimate it showed. */
function edited(s: TicketState, patch: Partial<Pick<TicketState, 'side' | 'qty'>>): TicketState {
  const changed =
    (patch.side !== undefined && patch.side !== s.side) ||
    (patch.qty !== undefined && patch.qty !== s.qty);
  if (!changed) return s;
  return {
    ...s,
    ...patch,
    phase: 'idle',
    attempt: null,
    outcome: null,
    // the estimate belongs to the old side and quantity: it is not shown any more
    preview: { ...initialPreview, requestId: s.preview.requestId },
  };
}

export function ticketReducer(s: TicketState, a: TicketAction): TicketState {
  switch (a.type) {
    case 'setSide':
      return s.phase === 'submitting' || s.phase === 'done' ? s : edited(s, { side: a.side });
    case 'setQty':
      return s.phase === 'submitting' || s.phase === 'done' ? s : edited(s, { qty: a.qty });
    case 'previewStart':
      if (s.phase === 'review' || s.phase === 'submitting') return s; // the review is frozen
      return {
        ...s,
        preview: {
          status: 'loading',
          // a re-preview for the same side and quantity (only the price moved) keeps showing the previous estimate,
          // marked as updating; any other change started from an empty preview (see edited())
          data:
            s.preview.for?.side === a.for.side && s.preview.for.qty === a.for.qty
              ? s.preview.data
              : null,
          failure: null,
          for: a.for,
          requestId: a.requestId,
        },
      };
    case 'previewOk':
      if (a.requestId !== s.preview.requestId || s.preview.for === null) return s; // a newer request exists
      return { ...s, preview: { ...s.preview, status: 'ready', data: a.data, failure: null } };
    case 'previewFail':
      if (a.requestId !== s.preview.requestId) return s;
      return { ...s, preview: { ...s.preview, status: 'error', data: null, failure: a.failure } };
    case 'previewClear':
      return { ...s, preview: { ...initialPreview, requestId: s.preview.requestId } };
    case 'openReview': {
      const p = s.preview;
      if (s.phase !== 'idle' || p.status !== 'ready' || p.data === null || p.for === null) return s;
      if (!p.data.wouldFill) return s; // a preview that would be rejected cannot be reviewed
      if (p.for.side !== s.side || p.for.qty !== s.qty) return s; // not the estimate of what is on the form
      return {
        ...s,
        phase: 'review',
        outcome: null,
        attempt: {
          key: a.key,
          symbol: a.symbol,
          side: s.side,
          qty: s.qty,
          referencePrice: p.for.referencePrice,
          estimate: p.data,
        },
      };
    }
    case 'cancelReview':
      return s.phase === 'review' ? { ...s, phase: 'idle', attempt: null, outcome: null } : s;
    case 'submitStart':
      if (s.attempt === null || (s.phase !== 'review' && s.phase !== 'submitting')) return s;
      if (s.phase === 'submitting') return s; // already in flight: a second click does nothing
      return { ...s, phase: 'submitting', outcome: null };
    case 'submitDone':
      if (s.phase !== 'submitting') return s;
      return {
        ...s,
        phase: 'done',
        attempt: null, // a definitive answer: the key is discarded
        outcome: { kind: a.order.status === 'FILLED' ? 'filled' : 'rejected', order: a.order },
      };
    case 'submitRetryable':
      if (s.phase !== 'submitting' || s.attempt === null) return s;
      // the attempt (and its key) stays: the retry is the same order
      return { ...s, phase: 'review', outcome: { kind: 'retryable', failure: a.failure } };
    case 'submitFailed':
      if (s.phase !== 'submitting') return s;
      return {
        ...s,
        phase: 'done',
        attempt: null,
        outcome: { kind: 'failed', failure: a.failure },
      };
    case 'reviewAgain': // after PRICE_MOVED (or any reject): back to the form, with a fresh estimate, no auto-resubmit
      return s.phase === 'done'
        ? {
            ...s,
            phase: 'idle',
            attempt: null,
            outcome: null,
            preview: { ...initialPreview, requestId: s.preview.requestId },
          }
        : s;
    case 'reset':
      return {
        ...initialTicket,
        side: s.side,
        preview: { ...initialPreview, requestId: s.preview.requestId },
      };
  }
}

// ---- disabled reasons --------------------------------------------------------------------------------------------

export interface ReasonInput {
  readonly symbol: string;
  readonly side: Side;
  readonly qty: string;
  /** false when orders cannot be placed for this instrument yet (crypto before M8): prices only. */
  readonly tradable?: boolean;
  readonly status: InstrumentStatus;
  readonly quote: Pick<QuoteItem, 'freshness' | 'bid' | 'ask'>;
  /** The last price refresh failed (the quote on screen may be old). */
  readonly refreshFailed: boolean;
  /** Shares held: null or undefined when unknown. */
  readonly positionQty: string | null | undefined;
  readonly preview: PreviewState;
  readonly submitting: boolean;
}

/**
 * Why Buy/Sell/Review is disabled, in words, or null when it is allowed. Checked in this order: in flight, instrument
 * status, quote state, quantity, position, then the preview's own answer (which carries every API reject code). A
 * disabled button always has one of these reasons next to it.
 */
/** Shown for instruments that have prices but no trading yet (crypto before M8). */
export const NOT_TRADABLE_YET =
  'This instrument is not tradable yet: its prices are shown, but trading it arrives in a later update.';

export function disabledReason(i: ReasonInput): string | null {
  if (i.submitting) return 'Placing your order…';
  if (i.tradable === false) return NOT_TRADABLE_YET;

  const sv = statusView(i.status);
  if ((i.side === 'BUY' && sv.blocksBuy) || (i.side === 'SELL' && sv.blocksSell)) {
    return sv.explanation ?? 'This instrument cannot be traded right now.';
  }

  switch (i.quote.freshness) {
    case 'UNAVAILABLE':
      return 'There is no usable price right now, so orders cannot be placed.';
    case 'CLOSED':
      return 'The market is closed, so orders cannot be placed.';
    case 'STALE':
      return 'The latest price is too old to trade on, so orders cannot be placed.';
    case 'REAL_TIME':
    case 'DELAYED':
      break;
  }
  if (i.quote.bid === undefined || i.quote.ask === undefined) {
    return 'There is no usable price right now, so orders cannot be placed.';
  }
  if (i.refreshFailed)
    return "We can't refresh the price right now, so orders are paused until we can.";

  if (qtyEmpty(i.qty)) return 'Enter a quantity.';
  if (qtyTooLarge(i.qty))
    return `The most you can order at once is ${formatQty(String(MAX_ORDER_QTY))} shares.`;
  // an unknown position (undefined) is not blocked here: the preview then answers INSUFFICIENT_POSITION if it is wrong
  const noShares =
    i.positionQty === null ||
    (i.positionQty !== undefined && qtyEmpty(i.positionQty.replace(/\.0+$/, '')));
  if (i.side === 'SELL' && noShares) {
    return `You do not own any ${i.symbol} to sell.`;
  }

  const p = i.preview;
  if (p.status === 'none' || p.status === 'loading') return 'Calculating the estimate…';
  if (p.status === 'error') return "We couldn't calculate the estimate. Please try again.";
  if (p.data !== null && !p.data.wouldFill) return rejectMessage(p.data.rejectCode);
  return null;
}
