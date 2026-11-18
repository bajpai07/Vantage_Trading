// Trading reconciliation (TRADING_ENGINE section 11, D-52): ZERO tolerance, exact decimal comparison.
// I4  positions.qty = sum of open lot quantities, and closed_at is set iff qty_open = 0
// I5  orders.filled_qty = sum of executions.qty, FILLED = fully filled, REJECTED = nothing filled,
//     every execution matches its order
// I6  every execution has exactly one ledger transaction of the same account, and none is shared
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
