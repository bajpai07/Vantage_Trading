// Quote validation (MARKET_DATA section 6). Reject and count; never fix a quote silently.
import type { Dec } from '@vantage/money';
import { add, compare, div, mul, negate, parse, sign, sub } from '@vantage/money';
import type { Quote, RawQuote } from './types.js';

export type RejectReason =
  | 'MALFORMED'
  | 'NON_POSITIVE_PRICE'
  | 'CROSSED'
  | 'FUTURE_TIMESTAMP'
  | 'NEGATIVE_SIZE'
  | 'OUT_OF_ORDER'
  | 'OUTLIER_UNCONFIRMED';

export type QuoteWarning = 'NOT_ON_TICK';

/** An outlier tick held until a second consecutive tick confirms it. */
export interface PendingGap {
  readonly quote: Quote;
  /** Mid price of the held tick, as a plain decimal string. */
  readonly mid: string;
}

export type ValidationResult =
  | {
      readonly accepted: true;
      readonly quote: Quote;
      readonly warnings: readonly QuoteWarning[];
      readonly nextPending: PendingGap | null;
    }
  | {
      readonly accepted: false;
      readonly reason: RejectReason;
      readonly nextPending: PendingGap | null;
    };

/** Equities: a move of more than 10% from the last accepted quote is an outlier. */
export const EQUITY_OUTLIER_PERCENT = '10';
/** A provider timestamp further ahead of "now" than this is rejected. */
export const MAX_FUTURE_SKEW_MS = 2000;

export interface ValidateOptions {
  /** Instrument tick size; a price that is not a multiple of it only produces a warning. */
  readonly tickSize?: string;
  readonly outlierPercent?: string;
}

const HUNDRED = parse('100');
const TWO = parse('2');
const MID_SCALE = 12;

function tryParse(value: string | undefined): Dec | undefined | null {
  if (value === undefined) return undefined;
  try {
    return parse(value);
  } catch {
    return null; // malformed
  }
}

const midOf = (bid: Dec, ask: Dec): Dec => div(add(bid, ask), TWO, MID_SCALE, 'HALF_EVEN');

/** True when |a - b| is more than `percent` percent of `b`. */
function movedMoreThan(a: Dec, b: Dec, percent: Dec): boolean {
  const diff = sub(a, b);
  const abs = sign(diff) < 0 ? negate(diff) : diff;
  return compare(mul(abs, HUNDRED), mul(b, percent)) > 0;
}

/**
 * Validates one raw quote against the last accepted quote and any pending outlier.
 *
 * Outlier rule: a mid-price move of more than 10% from the last accepted quote is HELD (returned as
 * rejected OUTLIER_UNCONFIRMED with `nextPending` set). If the very next tick is within 10% of the held
 * tick (the new level is confirmed) it is ACCEPTED with `gapConfirmed`. Any other tick is judged
 * normally, so an unconfirmed outlier is simply discarded. A tick rejected for another reason does not
 * change the pending state.
 */
export function validateQuote(
  raw: RawQuote,
  lastAccepted: Quote | null,
  pendingGap: PendingGap | null,
  now: Date,
  options: ValidateOptions = {},
): ValidationResult {
  const reject = (
    reason: RejectReason,
    nextPending: PendingGap | null = pendingGap,
  ): ValidationResult => ({
    accepted: false,
    reason,
    nextPending,
  });

  const bid = tryParse(raw.bid);
  const ask = tryParse(raw.ask);
  const last = tryParse(raw.last);
  const sizes = [tryParse(raw.bidSize), tryParse(raw.askSize), tryParse(raw.lastSize)];
  if (
    bid === undefined ||
    bid === null ||
    ask === undefined ||
    ask === null ||
    last === null ||
    sizes.includes(null) ||
    Number.isNaN(raw.providerTs.getTime())
  ) {
    return reject('MALFORMED');
  }
  if (sign(bid) <= 0 || sign(ask) <= 0 || (last !== undefined && sign(last) <= 0)) {
    return reject('NON_POSITIVE_PRICE');
  }
  if (compare(bid, ask) > 0) return reject('CROSSED');
  if (raw.providerTs.getTime() - now.getTime() > MAX_FUTURE_SKEW_MS)
    return reject('FUTURE_TIMESTAMP');
  if (sizes.some((s) => s !== undefined && s !== null && sign(s) < 0))
    return reject('NEGATIVE_SIZE');
  if (lastAccepted !== null && raw.providerTs.getTime() < lastAccepted.providerTs.getTime()) {
    return reject('OUT_OF_ORDER');
  }

  const mid = midOf(bid, ask);
  const percent = parse(options.outlierPercent ?? EQUITY_OUTLIER_PERCENT);
  let gapConfirmed = false;
  if (lastAccepted !== null) {
    const previousMid = midOf(parse(lastAccepted.bid), parse(lastAccepted.ask));
    if (movedMoreThan(mid, previousMid, percent)) {
      const confirms = pendingGap !== null && !movedMoreThan(mid, parse(pendingGap.mid), percent);
      if (!confirms) {
        return reject('OUTLIER_UNCONFIRMED', { quote: raw, mid: mid.toString() });
      }
      gapConfirmed = true;
    }
  }

  const warnings: QuoteWarning[] = [];
  if (options.tickSize !== undefined) {
    const tick = parse(options.tickSize);
    const onTick = (p: Dec): boolean => div(p, tick, 0, 'HALF_EVEN').mul(tick).equals(p);
    if (!onTick(bid) || !onTick(ask) || (last !== undefined && !onTick(last))) {
      warnings.push('NOT_ON_TICK');
    }
  }
  const quote: Quote = gapConfirmed ? { ...raw, gapConfirmed: true } : raw;
  return { accepted: true, quote, warnings, nextPending: null };
}
