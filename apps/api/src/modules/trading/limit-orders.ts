// LIMIT orders on Postgres (M8b-1; D-91 to D-97): accept, fill a resting order, cancel, expire. Every function runs inside the
// CALLER's open transaction as the app role and posts exact double-entry ledger transactions.
//
// LOCK ORDER, everywhere (the same as executeMarketOrder, with the order row inserted between CASH and the position):
//   1. the accounts row  2. the CASH ledger account row  3. the order row  4. the position row  5. its open lots (opened_at, id)
// All order processing for ONE account is serialised by lock 1, so a fill, a cancel, an expiry and a market order of one
// account can never interleave, and orders of different accounts never wait for each other. The matcher and the HTTP paths
// therefore cannot deadlock with the market path: they take the same locks in the same order, and a path that touches fewer
// of them (a cancel of a BUY never reads lots) simply stops earlier in the sequence.
//
// Orders change state ONLY through the guarded transition
//   UPDATE orders SET status = $new, ..., version = version + 1 WHERE id = $id AND version = $v AND status = 'ACCEPTED'
// (D-91); a database trigger enforces the same rules for every role. The reserve that is released at cancel, expiry or fill is
// ALWAYS the stored `reserved_usd` of the order, never recomputed.
import type { ClientBase } from 'pg';
import {
  buyFillFromReserveLegs,
  consumeLotsFIFO,
  decideLimitOrder,
  evaluateOpenOrders,
  releaseLegs,
  reserveLegs,
  sellFillLegs,
} from '@vantage/engine';
import type { LotConsumption, OpenLot, OrderSide, Pricing, RejectCode } from '@vantage/engine';
import type { FreshnessState } from '@vantage/market-model';
import { add, parse, sign, sub } from '@vantage/money';
import { newId } from '../../ids.js';
import { postTransaction } from '../ledger/repository.js';
import { persistFillEffects } from './fill-effects.js';
import type { FillQuote } from './fill-effects.js';
import {
  AccountNotFoundError,
  ClientOrderIdMismatchError,
  FillAlreadyPostedError,
  LostRaceError,
  OrderNotFoundError,
} from './errors.js';
import { insertEvents } from './execute-market-order.js';
import type {
  ExecuteHooks,
  ExecuteOptions,
  ExecutionRecord,
  FeeScheduleSnapshot,
  MarketOrderCommand,
  QuoteSnapshot,
} from './execute-market-order.js';

type Queryable = Pick<ClientBase, 'query'>;

export type LimitStatus = 'ACCEPTED' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';

export interface LimitOrderRecord {
  readonly id: string;
  readonly accountId: string;
  readonly instrumentId: string;
  readonly clientOrderId: string;
  readonly side: OrderSide;
  readonly type: 'LIMIT';
  readonly tif: 'DAY' | 'GTC';
  readonly qty: string;
  readonly limitPrice: string;
  readonly filledQty: string;
  readonly reservedUsd: string;
  readonly status: LimitStatus;
  readonly rejectCode: string | null;
  readonly expiresAt: Date | null;
  readonly version: number;
}

/** Already-resolved facts for accepting a LIMIT order (the HTTP layer resolves them; the function reads account state itself). */
export interface LimitOrderCommand {
  readonly orderId: string;
  readonly accountId: string;
  readonly clientOrderId: string;
  readonly instrument: MarketOrderCommand['instrument'];
  readonly side: OrderSide;
  readonly qty: string;
  readonly limitPrice: string;
  readonly tif: 'DAY' | 'GTC';
  /** D-94: computed by the caller from the calendar and the config (the engine's expiresAt). */
  readonly expiresAt: Date;
  readonly quote: QuoteSnapshot | null;
  readonly freshness: FreshnessState;
  readonly feeSchedule: FeeScheduleSnapshot;
  readonly allowExecutionOnDelayed: boolean;
  readonly tradingEnabled: boolean;
  readonly now: Date;
}

export type AcceptResult =
  | {
      /** Resting: reserved (BUY: cash moved to RESERVED; SELL: qty_reserved) and waiting for the matcher. */
      readonly outcome: 'ACCEPTED';
      readonly replayed: boolean;
      readonly order: LimitOrderRecord;
    }
  | {
      /** D-97: marketable at accept: reserved and filled in the SAME transaction, never visible as resting. */
      readonly outcome: 'FILLED';
      readonly replayed: boolean;
      readonly order: LimitOrderRecord;
      readonly execution: ExecutionRecord;
    }
  | {
      readonly outcome: 'REJECTED';
      readonly replayed: boolean;
      readonly order: LimitOrderRecord;
      readonly rejectCode: RejectCode;
    };

interface OrderRow {
  id: string;
  account_id: string;
  instrument_id: string;
  client_order_id: string;
  side: OrderSide;
  tif: 'DAY' | 'GTC';
  qty: string;
  filled_qty: string;
  limit_price: string | null;
  status: LimitStatus;
  reject_code: string | null;
  reserved_usd: string;
  expires_at: Date | null;
  version: number;
  type: string;
}

const ORDER_COLUMNS = `id, account_id, instrument_id, client_order_id, side::text AS side, tif::text AS tif, qty, filled_qty,
  limit_price, status::text AS status, reject_code, reserved_usd, expires_at, version, type::text AS type`;

export const toLimitRecord = (r: OrderRow): LimitOrderRecord => ({
  id: r.id,
  accountId: r.account_id,
  instrumentId: r.instrument_id,
  clientOrderId: r.client_order_id,
  side: r.side,
  type: 'LIMIT',
  tif: r.tif,
  qty: parse(r.qty).toString(),
  limitPrice: parse(r.limit_price ?? '0').toString(),
  filledQty: parse(r.filled_qty).toString(),
  reservedUsd: parse(r.reserved_usd).toString(),
  status: r.status,
  rejectCode: r.reject_code,
  expiresAt: r.expires_at,
  version: r.version,
});

// ---- shared steps --------------------------------------------------------------------------------------------------------

async function lockAccount(
  client: Queryable,
  accountId: string,
  accountLocked: boolean,
): Promise<boolean> {
  if (!accountLocked) await client.query(`SELECT lock_account_for_order($1::uuid)`, [accountId]);
  const acct = await client.query<{ account_status: string; user_status: string }>(
    `SELECT a.status AS account_status, u.status::text AS user_status
       FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.id = $1::uuid`,
    [accountId],
  );
  const a = acct.rows[0];
  if (a === undefined) throw new AccountNotFoundError('account not found');
  return a.account_status === 'ACTIVE' && a.user_status === 'ACTIVE';
}

async function lockAndReadCash(client: Queryable, accountId: string): Promise<string> {
  await client.query(`SELECT lock_cash_balance($1::uuid)`, [accountId]);
  const r = await client.query<{ balance: string }>(
    `SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'CASH' AND currency = 'USD'`,
    [accountId],
  );
  return r.rows[0]?.balance ?? '0';
}

async function lockOrder(client: Queryable, orderId: string): Promise<OrderRow | undefined> {
  const r = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1::uuid FOR UPDATE`,
    [orderId],
  );
  return r.rows[0];
}

/** The guarded transition (D-91): zero rows updated means the order is no longer ACCEPTED at that version. */
async function transition(
  client: Queryable,
  o: Pick<OrderRow, 'id' | 'version' | 'qty'>,
  status: 'FILLED' | 'CANCELLED' | 'EXPIRED',
  now: Date,
): Promise<void> {
  const r = await client.query(
    `UPDATE orders SET status = $3::order_status, filled_qty = $4::numeric, reserved_usd = 0,
                       version = version + 1, updated_at = $5
      WHERE id = $1::uuid AND version = $2 AND status = 'ACCEPTED'`,
    [o.id, o.version, status, status === 'FILLED' ? o.qty : '0', now],
  );
  if (r.rowCount !== 1)
    throw new LostRaceError('the order is no longer ACCEPTED at the version that was read');
}

async function readFreePosition(
  client: Queryable,
  accountId: string,
  instrumentId: string,
): Promise<{ total: string; reserved: string; free: string }> {
  const r = await client.query<{ qty: string; qty_reserved: string }>(
    `SELECT qty, qty_reserved FROM positions WHERE account_id = $1::uuid AND instrument_id = $2::uuid FOR UPDATE`,
    [accountId, instrumentId],
  );
  const total = r.rows[0]?.qty ?? '0';
  const reserved = r.rows[0]?.qty_reserved ?? '0';
  return { total, reserved, free: sub(parse(total), parse(reserved)).toString() };
}

async function readLots(
  client: Queryable,
  accountId: string,
  instrumentId: string,
): Promise<OpenLot[]> {
  const r = await client.query<{
    id: string;
    qty_open: string;
    cost_remaining: string;
    opened_at: Date;
  }>(
    `SELECT id, qty_open, cost_remaining, opened_at FROM position_lots
      WHERE account_id = $1::uuid AND instrument_id = $2::uuid AND qty_open > 0
      ORDER BY opened_at, id FOR UPDATE`,
    [accountId, instrumentId],
  );
  return r.rows.map((l) => ({
    id: l.id,
    openedAt: l.opened_at,
    qtyOpen: l.qty_open,
    costRemaining: l.cost_remaining,
  }));
}

/** Moves the reservation of a resting SELL (qty_reserved) by `delta` (positive to hold, negative to release). */
async function moveQtyReserved(
  client: Queryable,
  accountId: string,
  instrumentId: string,
  delta: string,
  now: Date,
): Promise<void> {
  const r = await client.query(
    `UPDATE positions SET qty_reserved = qty_reserved + $3::numeric, version = version + 1, updated_at = $4
      WHERE account_id = $1::uuid AND instrument_id = $2::uuid`,
    [accountId, instrumentId, delta, now],
  );
  if (r.rowCount !== 1) throw new Error('a SELL reservation needs a position row'); // unreachable: free quantity > 0 was checked
}

// ---- the fill of an order that holds a reservation ----------------------------------------------------------------------------

interface FillContext {
  readonly order: OrderRow;
  readonly symbol: string;
  readonly pricing: Pricing;
  readonly quote: FillQuote;
  readonly modelVersion: string;
  readonly now: Date;
}

/**
 * The fill of an ACCEPTED order, under the locks account -> CASH -> order (already held by the caller). Reads the position
 * and the lots (locks 4 and 5), posts the FILL ledger transaction with key fill:{orderId}:1 (the RESERVED amount is released
 * through the FILL recipe: CASH +(R - C - f)), writes the execution, lot or closures and position, and takes the guarded
 * transition ACCEPTED -> FILLED. Throws (and the caller rolls back) on anything unexpected; nothing is half-done.
 */
async function fillLocked(
  client: Queryable,
  ctx: FillContext,
  hooks: ExecuteHooks,
): Promise<ExecutionRecord> {
  const o = ctx.order;
  const { price, notional, fee, slippageBps } = ctx.pricing;
  const executionId = newId();
  const pos = await readFreePosition(client, o.account_id, o.instrument_id);
  const openLots = await readLots(client, o.account_id, o.instrument_id);

  let consumptions: LotConsumption[] = [];
  let basis = '0';
  if (o.side === 'SELL') {
    consumptions = consumeLotsFIFO(openLots, o.qty);
    basis = consumptions.reduce((acc, c) => add(acc, parse(c.cost)), parse('0')).toString();
  }
  const legs =
    o.side === 'BUY'
      ? buyFillFromReserveLegs({ qty: o.qty, price, fee, reserved: o.reserved_usd })
      : sellFillLegs({ qty: o.qty, price, fee, basis });
  // ONE cost number (D-85): the BUY lot's cost is the POSITION_COST leg that is posted
  const costLeg = legs.find((l) => l.ledgerAccountType === 'POSITION_COST');
  const buyCost = o.side === 'BUY' ? (costLeg?.amount ?? '0') : '0';
  if (o.side === 'BUY' && sign(parse(buyCost)) <= 0)
    throw new Error('a BUY lot needs a positive cost');

  const posted = await postTransaction(client, {
    accountId: o.account_id,
    kind: 'FILL',
    idempotencyKey: `fill:${o.id}:1`,
    description: `${o.side} ${o.qty} ${ctx.symbol} @ ${price} (limit ${parse(o.limit_price ?? '0').toString()})`,
    orderId: o.id,
    executionId,
    legs,
  });
  // a fill replay hits the unique ledger key. The order row is locked and still ACCEPTED, so a transaction with this key
  // cannot belong to a completed fill: refuse loudly rather than skip
  if (!posted.created)
    throw new FillAlreadyPostedError('a fill transaction already exists for an open order');
  await hooks.afterLedgerPost?.();

  await persistFillEffects(client, {
    orderId: o.id,
    accountId: o.account_id,
    instrumentId: o.instrument_id,
    executionId,
    side: o.side,
    qty: o.qty,
    price,
    notional,
    fee,
    slippageBps,
    quote: ctx.quote,
    modelVersion: ctx.modelVersion,
    ledgerTxId: posted.transactionId,
    now: ctx.now,
    openLots,
    positionQty: pos.total,
    buyCost,
    consumptions,
    basis,
    qtyReservedDelta: o.side === 'SELL' ? parse(o.qty).negate().toString() : '0',
  });
  await transition(client, o, 'FILLED', ctx.now);
  await insertEvents(
    client,
    o.id,
    [
      {
        type: 'FILLED',
        payload: { executionId, price, qty: o.qty, ledgerTxId: posted.transactionId },
      },
    ],
    ctx.now,
  );
  return {
    id: executionId,
    orderId: o.id,
    price,
    qty: parse(o.qty).toString(),
    feeLocal: fee,
    grossUsd: notional,
    slippageBps,
    ledgerTxId: posted.transactionId,
    modelVersion: ctx.modelVersion,
    executedAt: ctx.now,
  };
}

// ---- release (cancel and expire) --------------------------------------------------------------------------------------------------

export interface Released {
  /** What went back to CASH (BUY). */
  readonly usd: string;
  /** What qty_reserved gave back (SELL). */
  readonly qty: string;
}

/**
 * ORDER_RELEASE: RESERVED -R, CASH +R with R the STORED reserved_usd (a BUY), or qty_reserved -= qty (a SELL), then the guarded
 * transition ACCEPTED -> CANCELLED or EXPIRED with reserved_usd = 0. Under the locks account -> CASH -> order.
 */
async function releaseLocked(
  client: Queryable,
  o: OrderRow,
  terminal: 'CANCELLED' | 'EXPIRED',
  now: Date,
  hooks: ExecuteHooks,
): Promise<Released> {
  let released: Released;
  if (o.side === 'BUY') {
    await postTransaction(client, {
      accountId: o.account_id,
      kind: 'ORDER_RELEASE',
      idempotencyKey: `release:${o.id}`,
      description: `release the reservation of order ${o.id} (${terminal})`,
      orderId: o.id,
      legs: releaseLegs({ amount: o.reserved_usd }),
    });
    released = { usd: parse(o.reserved_usd).toString(), qty: '0' };
  } else {
    await readFreePosition(client, o.account_id, o.instrument_id); // lock 4, in order
    await moveQtyReserved(
      client,
      o.account_id,
      o.instrument_id,
      parse(o.qty).negate().toString(),
      now,
    );
    released = { usd: '0', qty: parse(o.qty).toString() };
  }
  await hooks.afterLedgerPost?.();
  await transition(client, o, terminal, now);
  await insertEvents(
    client,
    o.id,
    [{ type: terminal, payload: { releasedUsd: released.usd, releasedQty: released.qty } }],
    now,
  );
  return released;
}

// ---- accept ------------------------------------------------------------------------------------------------------------------------

async function insertLimitOrder(
  client: Queryable,
  cmd: LimitOrderCommand,
  status: 'ACCEPTED' | 'REJECTED',
  reservedUsd: string,
  rejectCode: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO orders (id, account_id, instrument_id, client_order_id, side, type, tif, qty, filled_qty, limit_price,
                         status, reject_code, reserved_usd, expires_at, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::order_side, 'LIMIT', $6::time_in_force, $7::numeric, 0, $8::numeric,
             $9::order_status, $10, $11::numeric, $12, $13, $13)`,
    [
      cmd.orderId,
      cmd.accountId,
      cmd.instrument.id,
      cmd.clientOrderId,
      cmd.side,
      cmd.tif,
      cmd.qty,
      cmd.limitPrice,
      status,
      rejectCode,
      reservedUsd,
      status === 'ACCEPTED' ? cmd.expiresAt : null,
      cmd.now,
    ],
  );
}

/**
 * Accepts a LIMIT order in the caller's transaction: lock the account row, replay check, lock CASH and read the free cash and
 * the free quantity, decide (the engine), then either a persisted REJECTED order, or the order inserted ACCEPTED with its
 * reservation (BUY: ORDER_RESERVE; SELL: qty_reserved) and, when the quote makes it marketable, the fill in the same
 * transaction (D-97: the ledger shows ORDER_RESERVE and then FILL, and the order is never visible as resting).
 */
export async function acceptLimitOrder(
  client: Queryable,
  cmd: LimitOrderCommand,
  hooks: ExecuteHooks = {},
  options: ExecuteOptions = {},
): Promise<AcceptResult> {
  const accountActive = await lockAccount(client, cmd.accountId, options.accountLocked === true);

  const existing = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE account_id = $1::uuid AND client_order_id = $2`,
    [cmd.accountId, cmd.clientOrderId],
  );
  if (existing.rows[0] !== undefined) return replayAccept(cmd, existing.rows[0]);

  const cash = await lockAndReadCash(client, cmd.accountId);
  const pos = await readFreePosition(client, cmd.accountId, cmd.instrument.id);

  const decision = decideLimitOrder({
    side: cmd.side,
    qty: cmd.qty,
    limitPrice: cmd.limitPrice,
    instrument: cmd.instrument,
    quote: cmd.quote === null ? null : { bid: cmd.quote.bid, ask: cmd.quote.ask },
    freshness: cmd.freshness,
    allowExecutionOnDelayed: cmd.allowExecutionOnDelayed,
    schedule: cmd.feeSchedule,
    account: { active: accountActive, tradingEnabled: cmd.tradingEnabled },
    freeCash: cash,
    freeQty: pos.free,
  });
  const created = {
    type: 'LIMIT',
    side: cmd.side,
    qty: cmd.qty,
    limitPrice: cmd.limitPrice,
    tif: cmd.tif,
    expiresAt: cmd.expiresAt.toISOString(),
    instrumentId: cmd.instrument.id,
    symbol: cmd.instrument.symbol,
    clientOrderId: cmd.clientOrderId,
  };
  const record = (
    status: LimitStatus,
    reservedUsd: string,
    rejectCode: string | null,
    version: number,
  ): LimitOrderRecord => ({
    id: cmd.orderId,
    accountId: cmd.accountId,
    instrumentId: cmd.instrument.id,
    clientOrderId: cmd.clientOrderId,
    side: cmd.side,
    type: 'LIMIT',
    tif: cmd.tif,
    qty: parse(cmd.qty).toString(),
    limitPrice: parse(cmd.limitPrice).toString(),
    filledQty: status === 'FILLED' ? parse(cmd.qty).toString() : '0',
    reservedUsd,
    status,
    rejectCode,
    expiresAt: status === 'REJECTED' ? null : cmd.expiresAt,
    version,
  });

  if (decision.decision === 'REJECT') {
    await insertLimitOrder(client, cmd, 'REJECTED', '0', decision.code);
    await insertEvents(
      client,
      cmd.orderId,
      [
        { type: 'CREATED', payload: created },
        {
          type: 'REJECTED',
          payload: {
            code: decision.code,
            facts: {
              freshness: cmd.freshness,
              quote:
                cmd.quote === null
                  ? null
                  : { bid: cmd.quote.bid, ask: cmd.quote.ask, source: cmd.quote.source },
              cash,
              freeQty: pos.free,
              tradingEnabled: cmd.tradingEnabled,
              accountActive,
            },
          },
        },
      ],
      cmd.now,
    );
    return {
      outcome: 'REJECTED',
      replayed: false,
      order: record('REJECTED', '0', decision.code, 1),
      rejectCode: decision.code,
    };
  }

  // ACCEPT: insert resting, reserve
  await insertLimitOrder(client, cmd, 'ACCEPTED', decision.reserveUsd, null);
  await insertEvents(
    client,
    cmd.orderId,
    [
      { type: 'CREATED', payload: created },
      {
        type: 'ACCEPTED',
        payload: { reserveUsd: decision.reserveUsd, reserveQty: decision.reserveQty },
      },
    ],
    cmd.now,
  );
  if (cmd.side === 'BUY') {
    await postTransaction(client, {
      accountId: cmd.accountId,
      kind: 'ORDER_RESERVE',
      idempotencyKey: `reserve:${cmd.orderId}`,
      description: `reserve for BUY ${cmd.qty} ${cmd.instrument.symbol} limit ${cmd.limitPrice}`,
      orderId: cmd.orderId,
      legs: reserveLegs({ amount: decision.reserveUsd }),
    });
  } else {
    await moveQtyReserved(client, cmd.accountId, cmd.instrument.id, cmd.qty, cmd.now);
  }
  await hooks.afterLedgerPost?.();

  if (decision.fill === null || cmd.quote === null) {
    return {
      outcome: 'ACCEPTED',
      replayed: false,
      order: record('ACCEPTED', decision.reserveUsd, null, 1),
    };
  }

  // D-97: marketable at accept, filled in the same transaction
  const row = await lockOrder(client, cmd.orderId);
  if (row === undefined) throw new Error('the order that was just inserted is missing');
  const execution = await fillLocked(
    client,
    {
      order: row,
      symbol: cmd.instrument.symbol,
      pricing: decision.fill,
      quote: cmd.quote,
      modelVersion: cmd.feeSchedule.modelVersion,
      now: cmd.now,
    },
    hooks,
  );
  return { outcome: 'FILLED', replayed: false, order: record('FILLED', '0', null, 2), execution };
}

function replayAccept(cmd: LimitOrderCommand, row: OrderRow): AcceptResult {
  const same =
    row.instrument_id === cmd.instrument.id &&
    row.side === cmd.side &&
    row.type === 'LIMIT' &&
    row.tif === cmd.tif &&
    parse(row.qty).equals(parse(cmd.qty)) &&
    parse(row.limit_price ?? '0').equals(parse(cmd.limitPrice));
  if (!same)
    throw new ClientOrderIdMismatchError(
      'clientOrderId was already used with different parameters',
    );
  const order = toLimitRecord(row);
  if (row.status === 'REJECTED') {
    return {
      outcome: 'REJECTED',
      replayed: true,
      order,
      rejectCode: row.reject_code as RejectCode,
    };
  }
  if (row.status === 'FILLED') {
    // the stored execution is read by the HTTP layer from the idempotency response; the executor guard returns the order
    return { outcome: 'ACCEPTED', replayed: true, order };
  }
  return { outcome: 'ACCEPTED', replayed: true, order };
}

// ---- fill a resting order (the matcher) --------------------------------------------------------------------------------------------

export interface RestingFillInput {
  readonly orderId: string;
  readonly instrument: { readonly id: string; readonly symbol: string; readonly tickSize: string };
  /** The eligible quote the matcher evaluated, with the freshness the shared function gave it. */
  readonly quote: QuoteSnapshot;
  readonly freshness: FreshnessState;
  readonly allowExecutionOnDelayed: boolean;
  readonly feeSchedule: FeeScheduleSnapshot;
  readonly now: Date;
}

export type RestingFillResult =
  | {
      readonly outcome: 'FILLED';
      readonly order: LimitOrderRecord;
      readonly execution: ExecutionRecord;
    }
  | { readonly outcome: 'EXPIRED'; readonly order: LimitOrderRecord }
  /** Not ACCEPTED any more (filled, cancelled or expired by someone else): lost the race, nothing done. */
  | { readonly outcome: 'SKIPPED'; readonly status: LimitStatus }
  /** The quote does not satisfy the limit (any more), or the quote is not evaluable: nothing done. */
  | { readonly outcome: 'NOT_MARKETABLE' }
  /** A BUY fill that would exceed its reserve: refused and left intact (unreachable by construction, D-92). */
  | { readonly outcome: 'REFUSED' };

/**
 * Fills one resting order against the quote the matcher evaluated, in its own transaction (the caller's): lock the account
 * row, CASH, then the order row, re-read the status and version INSIDE the lock, apply the lazy expiry, re-evaluate
 * marketability with the engine on the SAME quote, fill. Whoever takes the account lock first wins a race with a cancel.
 */
export async function fillRestingOrder(
  client: Queryable,
  input: RestingFillInput,
  hooks: ExecuteHooks = {},
): Promise<RestingFillResult> {
  const first = await client.query<{ account_id: string }>(
    `SELECT account_id FROM orders WHERE id = $1::uuid`,
    [input.orderId],
  );
  const accountId = first.rows[0]?.account_id;
  if (accountId === undefined) throw new OrderNotFoundError('order not found');
  await lockAccount(client, accountId, false);
  await lockAndReadCash(client, accountId);
  const o = await lockOrder(client, input.orderId);
  if (o === undefined) throw new OrderNotFoundError('order not found');
  if (o.status !== 'ACCEPTED') return { outcome: 'SKIPPED', status: o.status };

  // lazy expiry (D-94): an order past its expiry is expired in this very transaction, before it can be matched
  if (o.expires_at !== null && o.expires_at.getTime() <= input.now.getTime()) {
    await releaseLocked(client, o, 'EXPIRED', input.now, hooks);
    const after = await client.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1::uuid`,
      [o.id],
    );
    return { outcome: 'EXPIRED', order: toLimitRecord(after.rows[0] as OrderRow) };
  }

  const ev = evaluateOpenOrders(
    { bid: input.quote.bid, ask: input.quote.ask },
    input.freshness,
    input.allowExecutionOnDelayed,
    [
      {
        id: o.id,
        createdAt: input.now,
        side: o.side,
        qty: o.qty,
        limitPrice: o.limit_price ?? '0',
        reservedUsd: o.reserved_usd,
      },
    ],
    input.feeSchedule,
    input.instrument.tickSize,
  );
  if (ev.refused.length > 0) return { outcome: 'REFUSED' };
  const fill = ev.fills[0];
  if (fill === undefined) return { outcome: 'NOT_MARKETABLE' };

  const execution = await fillLocked(
    client,
    {
      order: o,
      symbol: input.instrument.symbol,
      pricing: fill.pricing,
      quote: input.quote,
      modelVersion: input.feeSchedule.modelVersion,
      now: input.now,
    },
    hooks,
  );
  const after = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1::uuid`,
    [o.id],
  );
  return { outcome: 'FILLED', order: toLimitRecord(after.rows[0] as OrderRow), execution };
}

// ---- cancel and expire ---------------------------------------------------------------------------------------------------------------

export type CancelResult =
  | { readonly outcome: 'CANCELLED'; readonly order: LimitOrderRecord; readonly released: Released }
  /** Not open: already terminal (or expired lazily right now). The HTTP layer answers 409 ORDER_NOT_OPEN. */
  | { readonly outcome: 'NOT_OPEN'; readonly order: LimitOrderRecord };

/**
 * Synchronous cancel (D-93): ACCEPTED -> CANCELLED. The caller supplies the account it authenticated; an order of another
 * account is OrderNotFoundError (no leak). Locks account -> CASH -> order, re-checks the status inside the lock, applies the
 * lazy expiry first, then releases exactly the stored reservation.
 */
export async function cancelOrder(
  client: Queryable,
  input: { readonly orderId: string; readonly accountId: string; readonly now: Date },
  hooks: ExecuteHooks = {},
  options: ExecuteOptions = {},
): Promise<CancelResult> {
  await lockAccount(client, input.accountId, options.accountLocked === true);
  await lockAndReadCash(client, input.accountId);
  const o = await lockOrder(client, input.orderId);
  if (o === undefined || o.account_id !== input.accountId)
    throw new OrderNotFoundError('order not found');
  const reread = async (): Promise<LimitOrderRecord> => {
    const r = await client.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1::uuid`,
      [o.id],
    );
    return toLimitRecord(r.rows[0] as OrderRow);
  };
  if (o.status !== 'ACCEPTED') return { outcome: 'NOT_OPEN', order: toLimitRecord(o) };
  if (o.expires_at !== null && o.expires_at.getTime() <= input.now.getTime()) {
    await releaseLocked(client, o, 'EXPIRED', input.now, hooks); // lazily expired: the cancel arrived too late
    return { outcome: 'NOT_OPEN', order: await reread() };
  }
  const released = await releaseLocked(client, o, 'CANCELLED', input.now, hooks);
  return { outcome: 'CANCELLED', order: await reread(), released };
}

export type ExpireResult =
  | { readonly outcome: 'EXPIRED'; readonly order: LimitOrderRecord; readonly released: Released }
  | { readonly outcome: 'SKIPPED'; readonly status: LimitStatus };

/** Expires one order whose expiry has passed (the periodic job). Same locks and the same release as a cancel. */
export async function expireOrder(
  client: Queryable,
  input: { readonly orderId: string; readonly now: Date },
  hooks: ExecuteHooks = {},
): Promise<ExpireResult> {
  const first = await client.query<{ account_id: string }>(
    `SELECT account_id FROM orders WHERE id = $1::uuid`,
    [input.orderId],
  );
  const accountId = first.rows[0]?.account_id;
  if (accountId === undefined) throw new OrderNotFoundError('order not found');
  await lockAccount(client, accountId, false);
  await lockAndReadCash(client, accountId);
  const o = await lockOrder(client, input.orderId);
  if (o === undefined) throw new OrderNotFoundError('order not found');
  if (
    o.status !== 'ACCEPTED' ||
    o.expires_at === null ||
    o.expires_at.getTime() > input.now.getTime()
  ) {
    return { outcome: 'SKIPPED', status: o.status };
  }
  const released = await releaseLocked(client, o, 'EXPIRED', input.now, hooks);
  const after = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1::uuid`,
    [o.id],
  );
  return { outcome: 'EXPIRED', order: toLimitRecord(after.rows[0] as OrderRow), released };
}
