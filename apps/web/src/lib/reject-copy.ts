import type { OrderRejectCode } from '@vantage/contracts';
import { formatQty } from './money';

/**
 * Plain-language sentences for every business reject code of the contract (13 today). The Record type makes a missing
 * code a compile error and a unit test compares the keys with the contract's own list. A code this app does not know
 * (a newer API) gets the generic sentence, never the raw code and never a blank.
 */
export const REJECT_COPY: Readonly<Record<OrderRejectCode, string>> = {
  TRADING_PAUSED: 'Trading is paused right now, so the order was not placed.',
  ACCOUNT_NOT_ACTIVE: 'Your account is not active, so orders cannot be placed.',
  INSTRUMENT_NOT_TRADABLE: 'This instrument cannot be traded at the moment.',
  INSTRUMENT_HALTED: 'Trading in this instrument is halted.',
  QTY_BELOW_MIN: 'The quantity is below the minimum allowed for this instrument.',
  QTY_STEP_VIOLATION: 'The quantity is not a multiple of the size this instrument trades in.',
  TICK_VIOLATION: 'The limit price is not a multiple of the price step this instrument trades in.',
  NO_ELIGIBLE_QUOTE: 'There was no usable price for this instrument, so the order was not filled.',
  MARKET_CLOSED: 'The market was closed, so the order was not filled.',
  STALE_QUOTE: 'The latest price was too old to trade against, so the order was not filled.',
  PRICE_MOVED:
    'The price moved more than 1% against you since you last saw it, so the order was not filled.',
  INSUFFICIENT_BUYING_POWER: 'You did not have enough cash to cover this purchase, including fees.',
  INSUFFICIENT_POSITION: 'You do not own enough shares to sell that quantity.',
  FEE_EXCEEDS_PROCEEDS:
    'The fee would have been larger than the sale proceeds, so the sale was not made.',
};

export const GENERIC_REJECT_COPY =
  'The order was rejected. If this keeps happening, contact support.';

/** What the page knows about the instrument: lets a reject say the instrument's own step, minimum or collar. */
export interface RejectContext {
  readonly qtyStep?: string;
  readonly minQty?: string;
  readonly assetClass?: string;
}

export function rejectMessage(code: string | null | undefined, context?: RejectContext): string {
  if (code === null || code === undefined) return GENERIC_REJECT_COPY;
  if (!Object.hasOwn(REJECT_COPY, code)) return GENERIC_REJECT_COPY;
  if (context !== undefined) {
    if (code === 'QTY_STEP_VIOLATION' && context.qtyStep !== undefined) {
      return `This instrument trades in steps of ${formatQty(context.qtyStep)}.`;
    }
    if (code === 'QTY_BELOW_MIN' && context.minQty !== undefined) {
      return `The smallest order for this instrument is ${formatQty(context.minQty)}.`;
    }
    if (code === 'PRICE_MOVED' && context.assetClass === 'CRYPTO') {
      return REJECT_COPY.PRICE_MOVED.replace('1%', '2%');
    }
  }
  return REJECT_COPY[code as OrderRejectCode];
}
