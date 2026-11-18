// Order and position contracts (M4b). All money and quantities are decimal STRINGS, never numbers.
// The client sends only what D-59 lists: symbol, side, type, qty and the reference price it saw. The server
// decides the account, the quote, the fee schedule, the trading switch and the time.
import { z } from 'zod';
import { MoneyString } from './money-string.js';
import { FreshnessState, SymbolSchema, changeFields } from './market.js';

/** Largest quantity accepted for one order (shares or crypto units). Larger values are a validation error, not a reject. */
export const MAX_ORDER_QTY = 1_000_000;
/** Most decimal places a quantity may have (D-86). The instrument's own step is checked by the engine. */
export const MAX_QTY_DECIMALS = 8;
/** A plain positive decimal: no sign, no exponent, no leading zeros, 1 to 7 integer digits, at most 8 decimals. */
export const QTY_PATTERN = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,8})?$/;
/** Largest reference price digits accepted: up to 12 integer digits and 8 decimals. */
export const REFERENCE_PRICE_PATTERN = /^[0-9]{1,12}(\.[0-9]{1,8})?$/;

export const ORDERS_PAGE = { defaultLimit: 50, maxLimit: 100 } as const;

/** Header `Idempotency-Key` (D-58 amendment): 8-128 characters from [A-Za-z0-9._:-]. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
export const IdempotencyKey = z.string().regex(IDEMPOTENCY_KEY_PATTERN);

export const OrderSide = z.enum(['BUY', 'SELL']);
export const OrderType = z.enum(['MARKET', 'LIMIT']);
/** Time in force of a LIMIT order (D-93): DAY and GTC only; IOC and FOK are not supported. */
export const OrderTif = z.enum(['DAY', 'GTC']);
/**
 * Order states (D-91). A MARKET order is FILLED or REJECTED. A LIMIT order is REJECTED, or ACCEPTED (resting) and later FILLED,
 * CANCELLED or EXPIRED; the last three are terminal.
 */
export const OrderStatus = z.enum(['ACCEPTED', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED']);
/** The orders list filter (T5): one exact status, or open (ACCEPTED), closed (every terminal state) or all (the default). */
export const OrderStatusFilter = z.enum([...OrderStatus.options, 'open', 'closed', 'all']);

/**
 * Business reject codes, in the order the engine checks them (first failure wins). A reject is an order with
 * status REJECTED, never an HTTP error. Kept equal to the engine's REJECT_RULE_ORDER by a test in apps/api.
 */
export const ORDER_REJECT_CODES = [
  'TRADING_PAUSED',
  'ACCOUNT_NOT_ACTIVE',
  'INSTRUMENT_NOT_TRADABLE',
  'INSTRUMENT_HALTED',
  'QTY_BELOW_MIN',
  'QTY_STEP_VIOLATION',
  'TICK_VIOLATION', // LIMIT orders: the limit price is not a multiple of the instrument's tick
  'NO_ELIGIBLE_QUOTE',
  'MARKET_CLOSED',
  'STALE_QUOTE',
  'PRICE_MOVED',
  'INSUFFICIENT_BUYING_POWER',
  'INSUFFICIENT_POSITION',
  'FEE_EXCEEDS_PROCEEDS',
] as const;
export const OrderRejectCode = z.enum(ORDER_REJECT_CODES);
export type OrderRejectCode = z.output<typeof OrderRejectCode>;

/** Error codes of the order endpoints (HTTP errors, in the standard error envelope). */
export const ORDER_ERROR_CODES = [
  'VALIDATION_ERROR', // 400 body, query or path
  'IDEMPOTENCY_KEY_INVALID', // 400 missing or malformed Idempotency-Key
  'UNAUTHENTICATED', // 401
  'CSRF_REJECTED', // 403 bad Origin
  'INSTRUMENT_NOT_FOUND', // 404
  'ORDER_NOT_FOUND', // 404 (also another user's order)
  'ORDER_NOT_OPEN', // 409 cancel of an order that is no longer open (filled, cancelled or expired)
  'IDEMPOTENCY_MISMATCH', // 422 same key, different request
  'RATE_LIMITED', // 429
  'INTERNAL_ERROR', // 500 (with a request id; nothing is stored)
] as const;

/**
 * A quantity as the client sends it: a decimal STRING with at most 8 decimals (or a JSON integer). It is normalised to
 * the canonical text (trailing zeros and a bare dot removed: "0.0025000" becomes "0.0025", "10.0" becomes "10"), so the
 * same quantity always has one spelling (the idempotency hash relies on that). The browser never does arithmetic on it.
 */
const qtyInput = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const text = typeof v === 'number' ? (Number.isSafeInteger(v) ? String(v) : '') : v;
    if (!QTY_PATTERN.test(text)) {
      ctx.addIssue({
        code: 'custom',
        message: `must be a positive decimal number with at most ${String(MAX_QTY_DECIMALS)} decimals`,
      });
      return z.NEVER;
    }
    const canonical = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
    if (!/[1-9]/.test(canonical)) {
      ctx.addIssue({ code: 'custom', message: 'must be greater than zero' });
      return z.NEVER;
    }
    return canonical;
  })
  .refine(
    (t) => {
      const [whole = '0', frac = ''] = t.split('.');
      const n = Number(whole); // at most 10 digits: exact. The fraction is compared as text.
      return n < MAX_ORDER_QTY || (n === MAX_ORDER_QTY && frac === '');
    },
    { message: `must be at most ${String(MAX_ORDER_QTY)}` },
  );

/**
 * A limit price: a plain decimal string, greater than zero, at most 12 integer digits and 8 decimals, normalised to one canonical
 * spelling ("89900.00" and "89900" are the same request: trailing zeros are removed), so the idempotency hash is stable. Whether it
 * is a multiple of the instrument's tick is decided by the server (a persisted TICK_VIOLATION reject), not here.
 */
const limitPriceInput = z
  .string()
  .regex(REFERENCE_PRICE_PATTERN, 'must be a plain decimal string')
  .refine((p) => /[1-9]/.test(p), { message: 'must be greater than zero' })
  .transform((p) => (p.includes('.') ? p.replace(/0+$/, '').replace(/\.$/, '') : p));

/**
 * Static, input-free explanations for the two validation errors a user is most likely to hit with a LIMIT order (M8b-1): an
 * unsupported order type (stop orders and the rest) and an unsupported time in force (IOC and FOK). The API appends these to its
 * "Invalid request: field" message so the 400 says what is supported.
 */
export const ORDER_TYPE_ERROR =
  'type must be MARKET or LIMIT (stop and other order types are not supported yet)';
export const ORDER_TIF_ERROR = 'must be DAY or GTC (IOC and FOK are not supported)';
export const CLEAR_VALIDATION_MESSAGES: ReadonlySet<string> = new Set([
  ORDER_TYPE_ERROR,
  ORDER_TIF_ERROR,
]);

const orderBase = { symbol: SymbolSchema, side: OrderSide, qty: qtyInput };

/** A MARKET order: the price the user saw (the ask for a BUY, the bid for a SELL) feeds the price collar. */
const MarketOrderRequest = z.strictObject({
  ...orderBase,
  type: z.literal('MARKET'),
  /** A plain decimal string, greater than zero. */
  referencePrice: z
    .string()
    .regex(REFERENCE_PRICE_PATTERN, 'must be a plain decimal string')
    .refine((p) => /[1-9]/.test(p), { message: 'must be greater than zero' }),
});

/** A LIMIT order (M8b-1, D-93): a limit price and a time in force (DAY by default). No reference price: limits have no collar. */
const LimitOrderRequest = z.strictObject({
  ...orderBase,
  type: z.literal('LIMIT'),
  limitPrice: limitPriceInput,
  tif: z.enum(OrderTif.options, { error: ORDER_TIF_ERROR }).default('DAY'),
});

/**
 * POST /v1/orders body. Unknown fields (an account id, a price, a time, a fee) are rejected, and so is a field of the other order
 * type: a limit price on a MARKET order, a reference price or a time in force where they do not belong. Stop orders and every
 * other type are a 400 with a clear message.
 */
export const PlaceOrderRequest = z.discriminatedUnion(
  'type',
  [MarketOrderRequest, LimitOrderRequest],
  {
    error: ORDER_TYPE_ERROR,
  },
);
export type PlaceOrderRequest = z.output<typeof PlaceOrderRequest>;
export type LimitPlaceOrderRequest = Extract<PlaceOrderRequest, { type: 'LIMIT' }>;
export type MarketPlaceOrderRequest = Extract<PlaceOrderRequest, { type: 'MARKET' }>;

const decimalString = z.string().regex(/^[0-9]+(\.[0-9]+)?$/, 'must be a decimal string');

export const ExecutionResponse = z.strictObject({
  id: z.uuid(),
  qty: decimalString,
  /** Fill price per share (after slippage), USD. */
  price: MoneyString,
  /** qty x price, USD. */
  notional: MoneyString,
  fee: MoneyString,
  slippageBps: decimalString,
  executedAt: z.iso.datetime(),
  quoteSource: z.string(),
});
export type ExecutionResponse = z.output<typeof ExecutionResponse>;

export const OrderResponse = z.strictObject({
  id: z.uuid(),
  symbol: z.string(),
  side: OrderSide,
  type: OrderType,
  status: OrderStatus,
  /** Time in force (DAY for a market order, where it has no effect). */
  tif: OrderTif,
  qty: decimalString,
  filledQty: decimalString,
  /** The limit price of a LIMIT order (canonical), null for a MARKET order. */
  limitPrice: MoneyString.nullable(),
  /** Cash held back for an open limit BUY (the stored amount that a cancel or expiry releases); "0.00" otherwise. */
  reservedUsd: MoneyString,
  /** When an open limit order expires; null for a MARKET order and for a rejected order. */
  expiresAt: z.iso.datetime().nullable(),
  /** Increases by one with every state change (the guarded transition of D-91). */
  version: z.number().int().min(1),
  /** Only on the answer to a cancel: what was released (cash for a BUY, quantity for a SELL). */
  released: z.strictObject({ usd: MoneyString, qty: decimalString }).nullable().optional(),
  /** Set when status is REJECTED, otherwise null. */
  rejectCode: OrderRejectCode.nullable(),
  createdAt: z.iso.datetime(),
  /** The single fill of a FILLED market order, otherwise null. */
  execution: ExecutionResponse.nullable(),
});
export type OrderResponse = z.output<typeof OrderResponse>;

/** GET /v1/orders query: newest first, cursor pagination. */
export const ListOrdersQuery = z.strictObject({
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(ORDERS_PAGE.maxLimit))
    .optional(),
  /** Opaque: pass `nextCursor` from the previous page unchanged. */
  cursor: z.string().min(1).max(200).optional(),
  status: OrderStatusFilter.optional(),
  symbol: SymbolSchema.optional(),
});
export type ListOrdersQuery = z.output<typeof ListOrdersQuery>;

export const ListOrdersResponse = z.strictObject({
  orders: z.array(OrderResponse).max(ORDERS_PAGE.maxLimit),
  /** null on the last page. */
  nextCursor: z.string().nullable(),
});
export type ListOrdersResponse = z.output<typeof ListOrdersResponse>;

/** An open position from the positions cache. No market value and no P&L yet (M5). */
export const PositionResponse = z.strictObject({
  symbol: z.string(),
  qty: decimalString,
  /** Quantity committed to open SELL limit orders (M8b-1, D-96); a SELL, market or limit, may only use qtyAvailable. */
  qtyReserved: decimalString,
  /** qty - qtyReserved. */
  qtyAvailable: decimalString,
  /** Average cost per share of the open lots, USD (8 decimals at most). */
  avgCost: MoneyString,
});
export type PositionResponse = z.output<typeof PositionResponse>;

export const PositionsResponse = z.strictObject({ positions: z.array(PositionResponse) });
export type PositionsResponse = z.output<typeof PositionsResponse>;

// ---- order preview (M6b, D-70) --------------------------------------------------------------------------------

/** POST /v1/orders/preview takes exactly the body of POST /v1/orders (and no Idempotency-Key: nothing is stored). */
export const PreviewOrderRequest = PlaceOrderRequest;
export type PreviewOrderRequest = z.output<typeof PreviewOrderRequest>;

export const ORDER_PREVIEW_DISCLAIMER =
  'Estimate only: the final price is decided when the order executes.';

export const OrderPreviewQuote = z.strictObject({
  bid: MoneyString.nullable(),
  ask: MoneyString.nullable(),
  last: MoneyString.nullable(),
  /** The provider timestamp of the quote the estimate used. */
  asOf: z.iso.datetime().nullable(),
  source: z.string().nullable(),
  /** From the shared freshness function. UNAVAILABLE (no quote) has null prices. */
  freshness: FreshnessState,
  // the same day-change fields as a quote (M7b, D-82), from the same server function
  ...changeFields,
});
export type OrderPreviewQuote = z.output<typeof OrderPreviewQuote>;

/**
 * What the order would do if it were placed now, decided by the same engine function as the real order, on the current
 * quote, fee schedule, cash and position. ADVISORY: nothing is stored or locked, and the real order decides again.
 * Estimates are null when the order cannot be priced honestly (paused, halted, market closed, no usable quote, bad
 * quantity); for a reject that comes after the price check (price moved, not enough cash or shares, fee above the
 * proceeds) they show what the order would have cost.
 */
export const OrderPreviewResponse = z.strictObject({
  wouldFill: z.boolean(),
  /** The reason the order would be rejected (plain-language copy is the client's), or null when it would fill. */
  rejectCode: OrderRejectCode.nullable(),
  /** Fill price per share after slippage, rounded to the tick. */
  estimatedPrice: MoneyString.nullable(),
  estimatedNotional: MoneyString.nullable(),
  estimatedFee: MoneyString.nullable(),
  /** Cash after the order; negative for a purchase that could not be paid. */
  estimatedCashAfter: MoneyString.nullable(),
  /** SELL only: notional minus fee. */
  estimatedProceeds: MoneyString.nullable(),
  slippageBps: z
    .string()
    .regex(/^[0-9]+(\.[0-9]+)?$/)
    .nullable(),
  /**
   * D-90: the largest quantity this account could order right now, rounded DOWN to the instrument's step, decided by the
   * server with the same engine code as the order (BUY: what the cash pays for at the estimated price and fee; SELL: the
   * position). "0" when not even the minimum fits; null when it cannot be known (no usable quote, not tradable, paused).
   * The browser only fills this string into the form; it never computes it.
   */
  maxQty: z
    .string()
    .regex(/^[0-9]+(\.[0-9]+)?$/)
    .nullable()
    .optional(),
  /**
   * LIMIT orders only (M8b-1): the cash that would be held back (a BUY's reserve R, D-92; "0.00" for a SELL, which reserves
   * quantity), whether the order is marketable on the current eligible quote (it would then fill now at the estimated price,
   * otherwise it would rest), and when it would expire. For a LIMIT preview `wouldFill` means "would fill now" and
   * `rejectCode` says why it would be rejected, so an order with no reject code and wouldFill false would REST.
   */
  reserveUsd: MoneyString.nullable().optional(),
  marketable: z.boolean().nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  quote: OrderPreviewQuote,
  disclaimer: z.literal(ORDER_PREVIEW_DISCLAIMER),
  /** Server time of this preview. */
  generatedAt: z.iso.datetime(),
});
export type OrderPreviewResponse = z.output<typeof OrderPreviewResponse>;
