// Trading reconciliation (TRADING_ENGINE section 11, D-52): ZERO tolerance, exact decimal comparison.
// I4  positions.qty = sum of open lot quantities, and closed_at is set iff qty_open = 0
// I5  orders.filled_qty = sum of executions.qty, FILLED = fully filled, REJECTED = nothing filled,
//     every execution matches its order
// I6  every execution has exactly one ledger transaction of the same account, and none is shared; no execution on an
//     order that was cancelled or expired (M8b-1: there are no partial fills, so such an order never has one)
// I4' positions.qty_reserved = sum of the remaining quantity of the open SELL orders (M8b-1, D-96); qty_reserved <= qty
// I5' a terminal order has reserved_usd = 0; an open BUY holds a positive reserve, an open SELL none (M8b-1, D-91)
// I7  the RESERVED ledger balance = sum of reserved_usd over the open orders (M8b-1)
// POSITION_COST  the ledger POSITION_COST balance = sum over lots of cost_remaining, EXACTLY (D-85)
// REALIZED_PNL   the ledger REALIZED_PNL balance = -(sum of lot closure trading_pnl_usd), and the positions cache agrees
import { negate, parse } from '@vantage/money';
import type { Queryable } from './repository.js';
import type { Violation } from './reconcile.js';

export async function reconcileTrading(client: Queryable, accountId: string): Promise<Violation[]> {
  const out: Violation[] = [];
  const add = (invariant: Violation['invariant'], message: string): void => {
    out.push({ invariant, message });
  };

  // I4: the positions cache equals the lots
  const i4 = await client.query<{ instrument_id: string; pos_qty: string; lot_qty: string }>(
    `SELECT instrument_id, COALESCE(p.qty, 0) AS pos_qty, COALESCE(l.q, 0) AS lot_qty
       FROM (SELECT instrument_id, qty FROM positions WHERE account_id = $1::uuid) p
       FULL JOIN (SELECT instrument_id, SUM(qty_open) AS q FROM position_lots
                   WHERE account_id = $1::uuid GROUP BY instrument_id) l USING (instrument_id)
      WHERE COALESCE(p.qty, 0) <> COALESCE(l.q, 0)`,
    [accountId],
  );
  for (const r of i4.rows) {
    add(
      'I4',
      `instrument ${r.instrument_id}: positions.qty ${r.pos_qty} but open lots hold ${r.lot_qty}`,
    );
  }
  const lots = await client.query<{ id: string }>(
    `SELECT id FROM position_lots
      WHERE account_id = $1::uuid
        AND ((qty_open = 0) <> (closed_at IS NOT NULL) OR qty_open > qty_initial OR qty_open < 0
             OR cost_remaining < 0 OR (cost_remaining = 0) <> (qty_open = 0))`,
    [accountId],
  );
  for (const r of lots.rows)
    add(
      'I4',
      `lot ${r.id}: closed_at and qty_open disagree, qty_open is out of range, or cost_remaining is negative or zero only on one side`,
    );

  // I5: orders against executions
  const i5 = await client.query<{
    id: string;
    status: string;
    qty: string;
    filled_qty: string;
    exec_qty: string;
  }>(
    `SELECT o.id, o.status::text AS status, o.qty, o.filled_qty, COALESCE(e.q, 0) AS exec_qty
       FROM orders o
       LEFT JOIN (SELECT order_id, SUM(qty) AS q, COUNT(*) AS n FROM executions
                   WHERE account_id = $1::uuid GROUP BY order_id) e ON e.order_id = o.id
      WHERE o.account_id = $1::uuid
        AND (o.filled_qty <> COALESCE(e.q, 0)
             OR (o.status = 'FILLED' AND o.filled_qty <> o.qty)
             OR (o.status = 'REJECTED' AND (o.filled_qty <> 0 OR COALESCE(e.n, 0) <> 0)))`,
    [accountId],
  );
  for (const r of i5.rows) {
    add(
      'I5',
      `order ${r.id} (${r.status}): qty ${r.qty}, filled_qty ${r.filled_qty}, executions sum ${r.exec_qty}`,
    );
  }
  const mismatch = await client.query<{ id: string }>(
    `SELECT e.id FROM executions e JOIN orders o ON o.id = e.order_id
      WHERE e.account_id = $1::uuid
        AND (o.account_id <> e.account_id OR o.instrument_id <> e.instrument_id OR o.side <> e.side)`,
    [accountId],
  );
  for (const r of mismatch.rows) add('I5', `execution ${r.id} does not match its order`);

  // I6: executions and ledger transactions
  const noTx = await client.query<{ id: string }>(
    `SELECT e.id FROM executions e LEFT JOIN ledger_transactions t ON t.id = e.ledger_tx_id
      WHERE e.account_id = $1::uuid AND (t.id IS NULL OR t.account_id <> e.account_id)`,
    [accountId],
  );
  for (const r of noTx.rows)
    add('I6', `execution ${r.id} has no ledger transaction of this account`);
  const shared = await client.query<{ ledger_tx_id: string; n: string }>(
    `SELECT ledger_tx_id, COUNT(*) AS n FROM executions WHERE account_id = $1::uuid
      GROUP BY ledger_tx_id HAVING COUNT(*) > 1`,
    [accountId],
  );
  for (const r of shared.rows)
    add('I6', `ledger transaction ${r.ledger_tx_id} is shared by ${r.n} executions`);

  // I4' (M8b-1): the reserved quantity of each position against its open SELL orders
  const reservedQty = await client.query<{
    instrument_id: string;
    held: string;
    open_sells: string;
  }>(
    `SELECT instrument_id, COALESCE(p.qty_reserved, 0) AS held, COALESCE(o.q, 0) AS open_sells
       FROM (SELECT instrument_id, qty_reserved FROM positions WHERE account_id = $1::uuid) p
       FULL JOIN (SELECT instrument_id, SUM(qty - filled_qty) AS q FROM orders
                   WHERE account_id = $1::uuid AND side = 'SELL'
                     AND status IN ('ACCEPTED','PARTIALLY_FILLED','CANCEL_REQUESTED') GROUP BY instrument_id) o
         USING (instrument_id)
      WHERE COALESCE(p.qty_reserved, 0) <> COALESCE(o.q, 0)`,
    [accountId],
  );
  for (const r of reservedQty.rows) {
    add(
      'I4',
      `instrument ${r.instrument_id}: positions.qty_reserved ${parse(r.held).toString()} but the open SELL orders hold ${parse(r.open_sells).toString()}`,
    );
  }
  const overReserved = await client.query<{ instrument_id: string }>(
    `SELECT instrument_id FROM positions WHERE account_id = $1::uuid AND qty_reserved > qty`,
    [accountId],
  );
  for (const r of overReserved.rows)
    add('I4', `instrument ${r.instrument_id}: qty_reserved exceeds the position quantity`);

  // I5' and I6 (M8b-1): the reserve of terminal and open orders, executions on cancelled or expired orders
  const reserveShape = await client.query<{
    id: string;
    status: string;
    side: string;
    reserved_usd: string;
  }>(
    `SELECT id, status::text AS status, side::text AS side, reserved_usd FROM orders
      WHERE account_id = $1::uuid
        AND ((status IN ('FILLED','CANCELLED','REJECTED','EXPIRED') AND reserved_usd <> 0)
             OR (status IN ('ACCEPTED','PARTIALLY_FILLED','CANCEL_REQUESTED')
                 AND ((side = 'BUY' AND reserved_usd <= 0) OR (side = 'SELL' AND reserved_usd <> 0))))`,
    [accountId],
  );
  for (const r of reserveShape.rows) {
    add(
      'I5',
      `order ${r.id} (${r.status} ${r.side}): reserved_usd is ${parse(r.reserved_usd).toString()}, which does not fit its state`,
    );
  }
  const afterEnd = await client.query<{ id: string; status: string }>(
    `SELECT o.id, o.status::text AS status FROM orders o
      WHERE o.account_id = $1::uuid AND o.status IN ('CANCELLED','EXPIRED')
        AND EXISTS (SELECT 1 FROM executions e WHERE e.order_id = o.id)`,
    [accountId],
  );
  for (const r of afterEnd.rows) add('I6', `order ${r.id} is ${r.status} but has an execution`);

  // I7 (M8b-1): the RESERVED ledger balance against the open orders
  const reserved = await client.query<{ ledger: string | null; orders: string }>(
    `SELECT (SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'RESERVED' AND currency = 'USD') AS ledger,
            COALESCE((SELECT SUM(reserved_usd) FROM orders WHERE account_id = $1::uuid
                       AND status IN ('ACCEPTED','PARTIALLY_FILLED','CANCEL_REQUESTED')), 0) AS orders`,
    [accountId],
  );
  const rv = reserved.rows[0];
  if (rv !== undefined && !parse(rv.ledger ?? '0').equals(parse(rv.orders))) {
    add(
      'I7',
      `ledger RESERVED ${parse(rv.ledger ?? '0').toString()} but the open orders hold ${parse(rv.orders).toString()}`,
    );
  }

  // position cost: the ledger against the lots
  const cost = await client.query<{ ledger: string | null; lots: string }>(
    `SELECT (SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'POSITION_COST' AND currency = 'USD') AS ledger,
            COALESCE((SELECT SUM(cost_remaining) FROM position_lots WHERE account_id = $1::uuid), 0) AS lots`,
    [accountId],
  );
  const c = cost.rows[0];
  if (c !== undefined && c.ledger !== null && !parse(c.ledger).equals(parse(c.lots))) {
    add(
      'POSITION_COST',
      `ledger POSITION_COST ${parse(c.ledger).toString()} but open lots cost ${parse(c.lots).toString()}`,
    );
  }

  // realised P&L: the ledger against the lot closures (and the positions cache)
  const pnl = await client.query<{ ledger: string | null; closures: string; cached: string }>(
    `SELECT (SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'REALIZED_PNL' AND currency = 'USD') AS ledger,
            COALESCE((SELECT SUM(c.trading_pnl_usd) FROM lot_closures c JOIN position_lots l ON l.id = c.lot_id
                       WHERE l.account_id = $1::uuid), 0) AS closures,
            COALESCE((SELECT SUM(realized_trading_pnl_usd) FROM positions WHERE account_id = $1::uuid), 0) AS cached`,
    [accountId],
  );
  const p = pnl.rows[0];
  if (p !== undefined) {
    if (p.ledger !== null && !parse(p.ledger).equals(negate(parse(p.closures)))) {
      add(
        'REALIZED_PNL',
        `ledger REALIZED_PNL ${parse(p.ledger).toString()} but lot closures give ${negate(parse(p.closures)).toString()}`,
      );
    }
    if (!parse(p.cached).equals(parse(p.closures))) {
      add(
        'REALIZED_PNL',
        `positions cache realised P&L ${parse(p.cached).toString()} but lot closures sum to ${parse(p.closures).toString()}`,
      );
    }
  }
  return out;
}
