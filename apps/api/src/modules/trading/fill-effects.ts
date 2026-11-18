// What a fill writes besides the ledger transaction and the order row: the execution, the lot (BUY) or the lot updates and
// closures (SELL), and the position. ONE implementation shared by MARKET orders (executeMarketOrder) and LIMIT orders
// (accept-time fills and the matcher), so the cost rules of D-85 and the rounding of the average cost exist exactly once.
// The caller has already posted the ledger transaction (so `ledgerTxId` and the legs exist) and holds the locks
// account -> CASH -> (order) -> position -> lots.
import type { ClientBase } from 'pg';
import { allocateProceeds } from '@vantage/engine';
import type { LotConsumption, OpenLot, OrderSide } from '@vantage/engine';
import type { Entitlement } from '@vantage/market-model';
import { add, div, parse, sub } from '@vantage/money';
import { newId } from '../../ids.js';

type Queryable = Pick<ClientBase, 'query'>;

export interface FillQuote {
  readonly bid: string;
  readonly ask: string;
  readonly last?: string;
  readonly providerTs: Date;
  readonly source: string;
  readonly entitlement: Entitlement;
}

export interface FillEffectsInput {
  readonly orderId: string;
  readonly accountId: string;
  readonly instrumentId: string;
  readonly executionId: string;
  readonly side: OrderSide;
  readonly qty: string;
  readonly price: string;
  readonly notional: string;
  readonly fee: string;
  readonly slippageBps: string;
  readonly quote: FillQuote;
  readonly modelVersion: string;
  readonly ledgerTxId: string;
  readonly now: Date;
  /** The open lots read under the lock (oldest first) and the position's TOTAL quantity. */
  readonly openLots: readonly OpenLot[];
  readonly positionQty: string;
  /** BUY: the lot's cost, the POSITION_COST leg that was posted. */
  readonly buyCost: string;
  /** SELL: the FIFO consumption and its summed cost (the basis that was posted). */
  readonly consumptions: readonly LotConsumption[];
  readonly basis: string;
  /** Added to positions.qty_reserved (negative to release: a resting SELL that fills gives its reservation back). */
  readonly qtyReservedDelta: string;
}

/** Sum(cost_remaining) / Sum(qty_open) over lots, 8 decimal places HALF_EVEN; 0 when no quantity is left (D-85). */
export function averageCost(lots: ReadonlyArray<{ qty: string; cost: string }>): string {
  let qty = parse('0');
  let cost = parse('0');
  for (const l of lots) {
    qty = add(qty, parse(l.qty));
    cost = add(cost, parse(l.cost));
  }
  return qty.isZero() ? '0' : div(cost, qty, 8, 'HALF_EVEN').toString();
}

export async function persistFillEffects(client: Queryable, f: FillEffectsInput): Promise<void> {
  await client.query(
    `INSERT INTO executions (id, order_id, account_id, instrument_id, seq, side, qty, price, currency, fee_local,
                             gross_usd, fee_usd, slippage_bps, quote_bid, quote_ask, quote_last, quote_ts,
                             quote_source, quote_entitlement, model_version, ledger_tx_id, executed_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::order_side, $6::numeric, $7::numeric, 'USD', $8::numeric,
             $9::numeric, $8::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14,
             $15, $16::quote_entitlement, $17, $18::uuid, $19)`,
    [
      f.executionId,
      f.orderId,
      f.accountId,
      f.instrumentId,
      f.side,
      f.qty,
      f.price,
      f.fee,
      f.notional,
      f.slippageBps,
      f.quote.bid,
      f.quote.ask,
      f.quote.last ?? null,
      f.quote.providerTs,
      f.quote.source,
      f.quote.entitlement,
      f.modelVersion,
      f.ledgerTxId,
      f.now,
    ],
  );

  let realisedDelta = '0';
  let remainingLots: Array<{ qty: string; cost: string }>;
  if (f.side === 'BUY') {
    await client.query(
      `INSERT INTO position_lots (id, account_id, instrument_id, open_execution_id, qty_initial, qty_open,
                                  cost_local_per_unit, cost_usd_per_unit, opened_at, cost_remaining)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $5::numeric, $6::numeric, $6::numeric, $7,
               $8::numeric)`,
      [newId(), f.accountId, f.instrumentId, f.executionId, f.qty, f.price, f.now, f.buyCost],
    );
    remainingLots = [
      ...f.openLots.map((l) => ({ qty: l.qtyOpen, cost: l.costRemaining })),
      { qty: f.qty, cost: f.buyCost },
    ];
  } else {
    const proceeds = allocateProceeds(f.notional, f.consumptions);
    for (const [i, c] of f.consumptions.entries()) {
      await client.query(
        `UPDATE position_lots SET qty_open = $2::numeric, cost_remaining = $3::numeric, closed_at = $4
          WHERE id = $1::uuid`,
        [
          c.lotId,
          c.qtyOpenAfter,
          c.costRemainingAfter,
          parse(c.qtyOpenAfter).isZero() ? f.now : null,
        ],
      );
      const p = proceeds[i] ?? '0';
      await client.query(
        `INSERT INTO lot_closures (lot_id, close_execution_id, qty, proceeds_local, cost_local, proceeds_usd,
                                   cost_usd, trading_pnl_usd, fx_pnl_usd)
         VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::numeric, $4::numeric, $5::numeric,
                 $6::numeric, 0)`,
        [c.lotId, f.executionId, c.qty, p, c.cost, sub(parse(p), parse(c.cost)).toString()],
      );
    }
    realisedDelta = sub(parse(f.notional), parse(f.basis)).toString();
    const after = new Map(f.consumptions.map((c) => [c.lotId, c.qtyOpenAfter]));
    const costAfter = new Map(f.consumptions.map((c) => [c.lotId, c.costRemainingAfter]));
    remainingLots = f.openLots.map((l) => ({
      qty: after.get(l.id) ?? l.qtyOpen,
      cost: costAfter.get(l.id) ?? l.costRemaining,
    }));
  }

  const newQty = (
    f.side === 'BUY'
      ? add(parse(f.positionQty), parse(f.qty))
      : sub(parse(f.positionQty), parse(f.qty))
  ).toString();
  await client.query(
    `INSERT INTO positions (account_id, instrument_id, qty, avg_cost_local, realized_trading_pnl_usd, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::numeric, $6)
     ON CONFLICT (account_id, instrument_id) DO UPDATE
       SET qty = EXCLUDED.qty, avg_cost_local = EXCLUDED.avg_cost_local,
           realized_trading_pnl_usd = positions.realized_trading_pnl_usd + EXCLUDED.realized_trading_pnl_usd,
           qty_reserved = positions.qty_reserved + $7::numeric,
           version = positions.version + 1, updated_at = EXCLUDED.updated_at`,
    [
      f.accountId,
      f.instrumentId,
      newQty,
      averageCost(remainingLots),
      realisedDelta,
      f.now,
      f.qtyReservedDelta,
    ],
  );
}
