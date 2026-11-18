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
import { formatPrice, formatQty } from './money';
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

// ---- order type, limit price and time in force (M8b-1) ----------------------------------------------------------------

export type OrderKind = 'MARKET' | 'LIMIT';

/**
 * The body of POST /v1/orders and of the preview, from the form: a MARKET order carries the price the user saw, a LIMIT order
 * carries its limit price and time in force (and no reference price). One function, so the preview and the order cannot differ.
 */
export function orderRequestBody(i: {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly kind: OrderKind;
  readonly qty: string;
  readonly referencePrice: string;
  readonly limitPrice: string;
  readonly tif: 'DAY' | 'GTC';
}): Record<string, string> {
  return i.kind === 'LIMIT'
    ? {
        symbol: i.symbol,
        side: i.side,
        type: 'LIMIT',
        qty: i.qty,
        limitPrice: i.limitPrice,
        tif: i.tif,
      }
    : {
        symbol: i.symbol,
        side: i.side,
        type: 'MARKET',
        qty: i.qty,
        referencePrice: i.referencePrice,
      };
}
export type Tif = 'DAY' | 'GTC';

/** Most integer digits of a limit price (the contract allows 12) and decimals (8). */
export const MAX_LIMIT_INT_DIGITS = 12;

/**
 * What a limit price field may hold: digits and one dot, at most 12 integer digits and 8 decimals, no sign, no exponent. Text in,
 * text out: nothing is converted to a number. Whether the price is a multiple of the tick is checked by tickMessage (the obvious
 * case) and by the server.
 */
export function sanitizeLimitPrice(raw: string): string {
  const dot = raw.indexOf('.');
  const intPart = (dot === -1 ? raw : raw.slice(0, dot))
    .replace(/\D/g, '')
    .replace(/^0+/, '')
    .slice(0, MAX_LIMIT_INT_DIGITS);
  if (dot === -1) return intPart;
  const frac = raw
    .slice(dot + 1)
    .replace(/\D/g, '')
    .slice(0, MAX_QTY_DECIMALS);
  return `${intPart === '' ? '0' : intPart}.${frac}`;
}

/** The tick message, or null: a limit price with more decimals than the tick has cannot be a multiple of it. */
export function tickMessage(limitPrice: string, tickSize: string | undefined): string | null {
  if (tickSize === undefined) return null;
  const decimals = (limitPrice.split('.')[1] ?? '').length;
  return decimals > stepDecimals(tickSize)
    ? `The limit price must be a multiple of ${formatPrice(tickSize)}.`
    : null;
}

// ---- decimal quantities (M8, D-86) ---------------------------------------------------------------------------------
// A quantity is TEXT: digits, at most one dot, at most 8 decimals. Everything below works on the characters; nothing is
// converted to a number and nothing is calculated (the server decides every rule and the browser only blocks the obvious).

/** Most decimals a quantity may have (the contract's limit). */
export const MAX_QTY_DECIMALS = 8;

/** How many decimals the instrument's step allows: "1" -> 0, "0.00001" -> 5, "0.00000001" -> 8. */
export function stepDecimals(step: string | undefined): number {
  if (step === undefined) return 0;
  const frac = step.split('.')[1] ?? '';
  return frac.length < MAX_QTY_DECIMALS ? frac.length : MAX_QTY_DECIMALS;
}

/**
 * What a quantity field may hold: digits and one dot, no exponent, no sign, no separators. For an instrument that trades
 * in fractions the decimals are capped at what its step allows. For a whole-share instrument a typed dot and decimals are
 * KEPT (never silently turned into a different number): the ticket then blocks the order with the step message.
 */
export function sanitizeQtyFor(raw: string, step: string | undefined): string {
  const dot = raw.indexOf('.');
  const intPart = (dot === -1 ? raw : raw.slice(0, dot))
    .replace(/\D/g, '')
    .replace(/^0+/, '')
    .slice(0, MAX_QTY_DIGITS);
  if (dot === -1) return intPart;
  const allowed = stepDecimals(step);
  const frac = raw
    .slice(dot + 1)
    .replace(/\D/g, '')
    .slice(0, allowed > 0 ? allowed : MAX_QTY_DECIMALS);
  return `${intPart === '' ? '0' : intPart}.${frac}`;
}

/** A complete positive quantity: "5", "0.0025", "10.5" (not "", "0", "0.", "1.", "0.000"). */
export const qtyComplete = (qty: string): boolean =>
  /^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/.test(qty);

/** Compares two plain decimal strings by their digits (-1, 0, 1). No number conversion. */
export function compareDecimalText(a: string, b: string): -1 | 0 | 1 {
  const [ai = '', af = ''] = a.split('.');
  const [bi = '', bf = ''] = b.split('.');
  const ax = ai.replace(/^0+/, '');
  const bx = bi.replace(/^0+/, '');
  if (ax.length !== bx.length) return ax.length < bx.length ? -1 : 1;
  if (ax !== bx) return ax < bx ? -1 : 1;
  const w = af.length > bf.length ? af.length : bf.length;
  const x = af.padEnd(w, '0');
  const y = bf.padEnd(w, '0');
  return x === y ? 0 : x < y ? -1 : 1;
}

/** The step message, or null. Only the obvious case is checked here (more decimals than the step has); the server checks the rest. */
export function stepMessage(qty: string, step: string | undefined): string | null {
  if (step === undefined) return null;
  const decimals = (qty.split('.')[1] ?? '').length;
  return decimals > stepDecimals(step)
    ? `This instrument trades in steps of ${formatQty(step)}.`
    : null;
}

/** Is this digit string above the maximum order size? (String comparison: no number conversion.) */
export function qtyTooLarge(qty: string): boolean {
  const max = String(MAX_ORDER_QTY);
  const [whole = '', frac = ''] = qty.split('.');
  if (whole.length !== max.length) return whole.length > max.length;
  return whole > max || (whole === max && /[1-9]/.test(frac));
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
    /** The ask or bid the user saw (MARKET orders; "" for a LIMIT order, which has no reference price). */
    readonly referencePrice: string;
    readonly kind: OrderKind;
    readonly limitPrice: string;
    readonly tif: Tif;
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
  readonly kind: OrderKind;
  readonly limitPrice: string;
  readonly tif: Tif;
  /** The estimate the user reviewed (frozen: it does not change while they are reviewing). */
  readonly estimate: OrderPreviewResponse;
}

export type Outcome =
  | { readonly kind: 'filled' | 'rejected' | 'accepted'; readonly order: OrderResponse }
  | { readonly kind: 'retryable'; readonly failure: ApiFailure }
  | { readonly kind: 'failed'; readonly failure: ApiFailure };

export type Phase = 'idle' | 'review' | 'submitting' | 'done';

export interface TicketState {
  readonly side: Side;
  readonly qty: string;
  readonly kind: OrderKind;
  readonly limitPrice: string;
  readonly tif: Tif;
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
  kind: 'MARKET',
  limitPrice: '',
  tif: 'DAY',
  preview: initialPreview,
  phase: 'idle',
  attempt: null,
  outcome: null,
};

export type TicketAction =
  | { type: 'setSide'; side: Side }
  | { type: 'setQty'; qty: string }
  | { type: 'setKind'; kind: OrderKind }
  | { type: 'setLimitPrice'; limitPrice: string }
  | { type: 'setTif'; tif: Tif }
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
function edited(
  s: TicketState,
  patch: Partial<Pick<TicketState, 'side' | 'qty' | 'kind' | 'limitPrice' | 'tif'>>,
): TicketState {
  const changed =
    (patch.side !== undefined && patch.side !== s.side) ||
    (patch.qty !== undefined && patch.qty !== s.qty) ||
    (patch.kind !== undefined && patch.kind !== s.kind) ||
    (patch.limitPrice !== undefined && patch.limitPrice !== s.limitPrice) ||
    (patch.tif !== undefined && patch.tif !== s.tif);
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
    case 'setKind':
      return s.phase === 'submitting' || s.phase === 'done' ? s : edited(s, { kind: a.kind });
    case 'setLimitPrice':
      return s.phase === 'submitting' || s.phase === 'done'
        ? s
        : edited(s, { limitPrice: a.limitPrice });
    case 'setTif':
      return s.phase === 'submitting' || s.phase === 'done' ? s : edited(s, { tif: a.tif });
    case 'previewStart':
      if (s.phase === 'review' || s.phase === 'submitting') return s; // the review is frozen
      return {
        ...s,
        preview: {
          status: 'loading',
          // a re-preview for the same side and quantity (only the price moved) keeps showing the previous estimate,
          // marked as updating; any other change started from an empty preview (see edited())
          data:
            s.preview.for?.side === a.for.side &&
            s.preview.for.qty === a.for.qty &&
            s.preview.for.kind === a.for.kind &&
            s.preview.for.limitPrice === a.for.limitPrice &&
            s.preview.for.tif === a.for.tif
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
      // a preview that would be rejected cannot be reviewed; a LIMIT order that would REST (no reject code, wouldFill false) can
      if (p.data.rejectCode !== null) return s;
      if (
        p.for.side !== s.side ||
        p.for.qty !== s.qty ||
        p.for.kind !== s.kind ||
        p.for.limitPrice !== s.limitPrice ||
        p.for.tif !== s.tif
      ) {
        return s; // not the estimate of what is on the form
      }
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
          kind: s.kind,
          limitPrice: s.limitPrice,
          tif: s.tif,
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
        outcome: {
          kind:
            a.order.status === 'FILLED'
              ? 'filled'
              : a.order.status === 'ACCEPTED'
                ? 'accepted'
                : 'rejected',
          order: a.order,
        },
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
  /** MARKET (default) or LIMIT (M8b-1): a limit order rests, so a stale or closed quote does not block it. */
  readonly kind?: OrderKind;
  readonly limitPrice?: string;
  readonly tickSize?: string;
  /** What a SELL may still use: the position minus the quantity reserved for open orders (D-96). */
  readonly positionAvailable?: string | null | undefined;
  /** false when orders cannot be placed for this instrument (the MVP gate is missing): prices only. */
  readonly tradable?: boolean;
  /** The instrument's step and minimum quantity (M8); absent in older callers: only the whole-number rules apply. */
  readonly qtyStep?: string;
  readonly minQty?: string;
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
/** Shown for instruments that have prices but no trading (no MVP gate in tradable_in). */
export const NOT_TRADABLE_YET =
  'This instrument is not tradable yet: its prices are shown, but trading it arrives in a later update.';

export function disabledReason(i: ReasonInput): string | null {
  if (i.submitting) return 'Placing your order…';
  if (i.tradable === false) return NOT_TRADABLE_YET;

  const sv = statusView(i.status);
  if ((i.side === 'BUY' && sv.blocksBuy) || (i.side === 'SELL' && sv.blocksSell)) {
    return sv.explanation ?? 'This instrument cannot be traded right now.';
  }

  const limit = i.kind === 'LIMIT';
  if (!limit) {
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
  }

  if (!qtyComplete(i.qty)) return 'Enter a quantity.';
  if (qtyTooLarge(i.qty)) {
    const unit = stepDecimals(i.qtyStep) > 0 ? 'units' : 'shares';
    return `The most you can order at once is ${formatQty(String(MAX_ORDER_QTY))} ${unit}.`;
  }
  const step = stepMessage(i.qty, i.qtyStep);
  if (step !== null) return step;
  if (i.minQty !== undefined && compareDecimalText(i.qty, i.minQty) < 0) {
    return `The smallest order for ${i.symbol} is ${formatQty(i.minQty)}.`;
  }
  if (limit) {
    if (!qtyComplete(i.limitPrice ?? '')) return 'Enter a limit price.';
    const tick = tickMessage(i.limitPrice ?? '', i.tickSize);
    if (tick !== null) return tick;
  }
  // an unknown position (undefined) is not blocked here: the preview then answers INSUFFICIENT_POSITION if it is wrong
  const empty = (q: string | null | undefined): boolean =>
    q === null || (q !== undefined && qtyEmpty(q.replace(/\.0+$/, '')));
  if (i.side === 'SELL' && empty(i.positionQty)) {
    return `You do not own any ${i.symbol} to sell.`;
  }
  if (i.side === 'SELL' && empty(i.positionAvailable)) {
    return `All of your ${i.symbol} is already committed to open orders.`;
  }

  const p = i.preview;
  if (p.status === 'none' || p.status === 'loading') return 'Calculating the estimate…';
  if (p.status === 'error') return "We couldn't calculate the estimate. Please try again.";
  if (p.data !== null && p.data.rejectCode !== null) return rejectMessage(p.data.rejectCode);
  return null;
}
