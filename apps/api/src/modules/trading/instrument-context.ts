// The instrument and the fee schedule an order is decided with: ONE lookup shared by the order API (market and limit orders,
// previews) and the matcher, so a fill can never be priced with a different schedule than the order was accepted under.
import type pg from 'pg';
import type { InstrumentStatus } from '@vantage/market-model';
import type { FeeScheduleSnapshot, MarketOrderCommand } from './execute-market-order.js';

export interface InstrumentContext {
  readonly instrument: MarketOrderCommand['instrument'] & {
    readonly exchange: string;
    assetClass: string;
  };
  readonly feeSchedule: FeeScheduleSnapshot;
}

interface Row {
  id: string;
  symbol: string;
  status: string;
  tradable_in: string[];
  tick_size: string;
  min_qty: string;
  qty_step: string;
  asset_class: string;
  exchange: string;
  commission_bps: string | null;
  commission_min_local: string | null;
  slippage_base_bps: string | null;
  slippage_size_coef: string | null;
  model_version: string | null;
}

/**
 * The instrument (by upper-case symbol or by id) with the fee schedule in force at `now` (the exchange-specific schedule first,
 * else the latest global version). Undefined when the instrument does not exist. A missing fee schedule is a configuration
 * error (an internal error, never the client's).
 */
export async function loadInstrumentContext(
  pool: Pick<pg.Pool, 'query'>,
  key: { readonly symbol: string } | { readonly id: string },
  now: Date,
): Promise<InstrumentContext | undefined> {
  const where = 'symbol' in key ? 'upper(i.symbol) = $1' : 'i.id = $1::uuid';
  const r = await pool.query<Row>(
    `SELECT i.id, i.symbol, i.status::text AS status, i.tradable_in::text[] AS tradable_in, i.tick_size,
            i.min_qty, i.qty_step, i.asset_class::text AS asset_class, e.code AS exchange,
            fs.commission_bps, fs.commission_min_local, fs.slippage_base_bps, fs.slippage_size_coef,
            fs.model_version
       FROM instruments i
       JOIN exchanges e ON e.id = i.exchange_id
       LEFT JOIN LATERAL (
         SELECT f.* FROM fee_schedules f
          WHERE f.asset_class = i.asset_class AND (f.exchange_id = i.exchange_id OR f.exchange_id IS NULL)
            AND f.effective_from <= $2::timestamptz
          ORDER BY (f.exchange_id IS NOT NULL) DESC, f.version DESC
          LIMIT 1) fs ON true
      WHERE ${where}`,
    ['symbol' in key ? key.symbol : key.id, now],
  );
  const x = r.rows[0];
  if (x === undefined) return undefined;
  if (x.commission_bps === null) {
    throw new Error(`no fee schedule for asset class ${x.asset_class}`);
  }
  return {
    instrument: {
      id: x.id,
      symbol: x.symbol,
      status: x.status as InstrumentStatus,
      tradableIn: x.tradable_in,
      tickSize: x.tick_size,
      minQty: x.min_qty,
      qtyStep: x.qty_step,
      exchange: x.exchange,
      assetClass: x.asset_class,
    },
    feeSchedule: {
      commissionBps: x.commission_bps,
      commissionMinLocal: x.commission_min_local ?? '0',
      slippageBaseBps: x.slippage_base_bps ?? '0',
      slippageSizeCoef: x.slippage_size_coef ?? '0',
      modelVersion: x.model_version ?? '',
    },
  };
}
