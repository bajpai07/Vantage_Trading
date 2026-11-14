// Portfolio, history and activity contracts (M5, read side). All money and quantities are decimal STRINGS.
// Money amounts are rounded to 2 decimals (HALF_EVEN) only at the API edge; every object that carries rounded amounts
// also carries an `exact` companion with the full-precision values (D-61). Prices are canonical (never rounded).
import { z } from 'zod';
import { FreshnessState, SymbolSchema } from './market.js';
import { MoneyString } from './money-string.js';
import { OrderSide } from './orders.js';

const decimalString = z.string().regex(/^[0-9]+(\.[0-9]+)?$/, 'must be a decimal string');
const nullableMoney = MoneyString.nullable();

export const MarkBasis = z.enum(['BID', 'LAST']);
export const ValuationState = z.enum(['VALUED', 'UNAVAILABLE']);

export const PortfolioPosition = z.strictObject({
  symbol: z.string(),
  qty: decimalString,
  /** Average cost per share of the open lots (canonical, not rounded). */
  avgCost: MoneyString,
  /** Sum over the open lots of qty x cost (2 dp). */
  costBasis: MoneyString,
  /** VALUED: has a mark. UNAVAILABLE: no usable quote; the position is EXCLUDED from the totals (see `incomplete`). */
  valuation: ValuationState,
  /** Why the position is UNAVAILABLE; null when VALUED. */
  unavailableReason: z.enum(['NO_QUOTE', 'NO_USABLE_PRICE']).nullable(),
  /** The mark (canonical): the bid, or the last price only when there is no bid. Null when UNAVAILABLE. */
  mark: nullableMoney,
  markBasis: MarkBasis.nullable(),
  marketValue: nullableMoney,
  unrealisedPnl: nullableMoney,
  /** Freshness of the quote behind the mark, from the shared market-model function. Never REAL_TIME unless it is. */
  quote: z.strictObject({
    freshness: FreshnessState,
    asOf: z.iso.datetime().nullable(),
    source: z.string().nullable(),
  }),
  exact: z.strictObject({
    costBasis: MoneyString,
    marketValue: nullableMoney,
    unrealisedPnl: nullableMoney,
  }),
});
export type PortfolioPosition = z.output<typeof PortfolioPosition>;

const totalsFields = {
  cash: MoneyString,
  /** Sum of the market values of the VALUED positions only. */
  positionsValue: MoneyString,
  /** Cost basis of ALL open positions, valued or not (reconciles with the ledger). */
  costBasis: MoneyString,
  /** Over the VALUED positions only. */
  unrealisedPnl: MoneyString,
  realisedPnl: MoneyString,
  fees: MoneyString,
  /** cash + positionsValue (valued positions only). */
  equity: MoneyString,
};

export const PortfolioResponse = z.strictObject({
  currency: z.literal('USD'),
  ...totalsFields,
  initialCapital: MoneyString,
  /** equity - initialCapital, ONLY when every position is valued; otherwise null. */
  totalReturn: nullableMoney,
  /** True when at least one position is UNAVAILABLE: it is excluded from positionsValue, unrealisedPnl and equity. */
  incomplete: z.boolean(),
  unvaluedCount: z.number().int().min(0),
  positions: z.array(PortfolioPosition),
  /** The oldest quote timestamp used for a valuation; null when no position was valued. */
  asOf: z.iso.datetime().nullable(),
  /** Server time of this answer. */
  generatedAt: z.iso.datetime(),
  /** The same amounts without display rounding. */
  exact: z.strictObject({ ...totalsFields, totalReturn: nullableMoney }),
});
export type PortfolioResponse = z.output<typeof PortfolioResponse>;

// ---- equity history ----------------------------------------------------------------------------------

export const HISTORY_MAX_ROWS = 366;
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'must be a real calendar date');

/** `from` and `to` are inclusive trading-day dates; at most 366 days apart. Defaults: to = today (UTC), from = to - 365 days. */
export const PortfolioHistoryQuery = z
  .strictObject({ from: isoDate.optional(), to: isoDate.optional() })
  .superRefine((q, ctx) => {
    if (q.from !== undefined && q.to !== undefined) {
      const span = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      if (span < 0)
        ctx.addIssue({ code: 'custom', path: ['from'], message: 'must not be after to' });
      else if (span > HISTORY_MAX_ROWS - 1) {
        ctx.addIssue({ code: 'custom', path: ['to'], message: 'range is at most 366 days' });
      }
    }
  });
export type PortfolioHistoryQuery = z.output<typeof PortfolioHistoryQuery>;

export const EquitySnapshot = z.strictObject({
  date: isoDate,
  cash: MoneyString,
  positionsValue: MoneyString,
  equity: MoneyString,
  /** false: at least one position could not be valued that day; positionsValue and equity exclude it. */
  valuedComplete: z.boolean(),
  /** The oldest quote timestamp used; null when no position was valued. */
  quoteAsOf: z.iso.datetime().nullable(),
  /**
   * Where the marks came from (M7b, D-83): SIM_CANDLE when every valued position was marked at the simulated candle price
   * at that session's close; null for stored quotes of that day (M5) or when nothing was valued.
   */
  markSource: z.string().min(1).nullable(),
  exact: z.strictObject({ cash: MoneyString, positionsValue: MoneyString, equity: MoneyString }),
});
export type EquitySnapshot = z.output<typeof EquitySnapshot>;

export const PortfolioHistoryResponse = z.strictObject({
  snapshots: z.array(EquitySnapshot).max(HISTORY_MAX_ROWS),
});
export type PortfolioHistoryResponse = z.output<typeof PortfolioHistoryResponse>;

// ---- executions and activity -------------------------------------------------------------------------

export const PAGE = { defaultLimit: 50, maxLimit: 100 } as const;

const pageQuery = {
  limit: z
    .string()
    .regex(/^[0-9]{1,3}$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(PAGE.maxLimit))
    .optional(),
  /** Opaque: pass `nextCursor` from the previous page unchanged. */
  cursor: z.string().min(1).max(200).optional(),
};

export const ListExecutionsQuery = z.strictObject({
  ...pageQuery,
  symbol: SymbolSchema.optional(),
});
export type ListExecutionsQuery = z.output<typeof ListExecutionsQuery>;

export const ExecutionItem = z.strictObject({
  id: z.uuid(),
  orderId: z.uuid(),
  symbol: z.string(),
  side: OrderSide,
  qty: decimalString,
  /** Fill price per share (canonical). */
  price: MoneyString,
  notional: MoneyString,
  fee: MoneyString,
  slippageBps: decimalString,
  executedAt: z.iso.datetime(),
  /** The quote the fill was simulated against. */
  quote: z.strictObject({
    bid: MoneyString.nullable(),
    ask: MoneyString.nullable(),
    last: MoneyString.nullable(),
    asOf: z.iso.datetime(),
    source: z.string(),
    entitlement: z.enum(['REAL_TIME', 'DELAYED']),
  }),
  /** SELL: the realised trading P&L of the lots it closed (gross of fees). BUY: null. */
  realisedPnl: nullableMoney,
  exact: z.strictObject({ notional: MoneyString, fee: MoneyString, realisedPnl: nullableMoney }),
});
export type ExecutionItem = z.output<typeof ExecutionItem>;

export const ListExecutionsResponse = z.strictObject({
  executions: z.array(ExecutionItem).max(PAGE.maxLimit),
  nextCursor: z.string().nullable(),
});
export type ListExecutionsResponse = z.output<typeof ListExecutionsResponse>;

export const ListActivityQuery = z.strictObject(pageQuery);
export type ListActivityQuery = z.output<typeof ListActivityQuery>;

export const ACTIVITY_KINDS = [
  'GRANT',
  'ORDER_RESERVE',
  'ORDER_RELEASE',
  'FILL',
  'FEE',
  'CORPORATE_ACTION',
  'ADJUSTMENT',
  'COMPETITION_GRANT',
] as const;

export const ActivityItem = z.strictObject({
  id: z.uuid(),
  kind: z.enum(ACTIVITY_KINDS),
  /** A plain-language label for the kind, e.g. "Trade". */
  title: z.string(),
  /** For a trade, e.g. "BUY 10 AAPL @ 190.04". May be null. */
  description: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** The signed effect on the cash balance: negative when cash went out. */
  cashEffect: MoneyString,
  orderId: z.uuid().nullable(),
  exact: z.strictObject({ cashEffect: MoneyString }),
});
export type ActivityItem = z.output<typeof ActivityItem>;

export const ListActivityResponse = z.strictObject({
  activity: z.array(ActivityItem).max(PAGE.maxLimit),
  nextCursor: z.string().nullable(),
});
export type ListActivityResponse = z.output<typeof ListActivityResponse>;
