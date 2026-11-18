// executeMarketOrder: turns one MARKET order request into exact, permanent records, inside the caller's
// open database transaction (M4b adds idempotency-key storage in the same transaction).
//
// Lock order, ALWAYS: 1. the accounts row, 2. the CASH ledger account row, 3. the position row, 4. its open
// lots (ordered by opened_at, id). All order processing for one account is serialised by lock 1, so two
// orders on one account can never interleave, and orders on different accounts never wait for each other.
//
// Any unexpected error aborts the whole transaction (the caller rolls back). Nothing is swallowed.
import type { ClientBase } from 'pg';
import {
  buyFillLegs,
  collarPercentFor,
  consumeLotsFIFO,
  decideMarketOrder,
  sellFillLegs,
} from '@vantage/engine';
import type {
  LotConsumption,
  MarketOrderDecision,
  OpenLot,
  OrderSide,
  RejectCode,
} from '@vantage/engine';
import type { Entitlement, FreshnessState, InstrumentStatus } from '@vantage/market-model';
import { add, parse, sign, sub } from '@vantage/money';
import { newId } from '../../ids.js';
import { postTransaction } from '../ledger/repository.js';
import { persistFillEffects } from './fill-effects.js';
import {
  AccountNotFoundError,
  ClientOrderIdMismatchError,
  DuplicateClientOrderIdError,
} from './errors.js';

type Queryable = Pick<ClientBase, 'query'>;

export interface QuoteSnapshot {
  readonly bid: string;
  readonly ask: string;
  readonly last?: string;
  readonly providerTs: Date;
  readonly source: string;
  readonly entitlement: Entitlement;
  readonly delaySeconds: number;
}

export interface FeeScheduleSnapshot {
  readonly commissionBps: string;
  readonly commissionMinLocal: string;
  readonly slippageBaseBps: string;
  readonly slippageSizeCoef: string;
  readonly modelVersion: string;
}

/** Already-resolved facts. The function reads only the account, cash, position and lots itself. */
export interface MarketOrderCommand {
  readonly orderId: string;
  readonly accountId: string;
  readonly clientOrderId: string;
  readonly instrument: {
    readonly id: string;
    readonly symbol: string;
    readonly status: InstrumentStatus;
    readonly tradableIn: readonly string[];
    readonly tickSize: string;
    readonly minQty: string;
    readonly qtyStep: string;
    /** Selects the collar (D-88: 2% for CRYPTO, 1% otherwise). Absent means the equity collar. */
    readonly assetClass?: string;
  };
  readonly side: OrderSide;
  readonly qty: string;
  /** The ask the user saw for a BUY, the bid for a SELL (D-51). */
  readonly referencePrice: string;
  readonly quote: QuoteSnapshot | null;
  readonly freshness: FreshnessState;
  readonly feeSchedule: FeeScheduleSnapshot;
  readonly allowExecutionOnDelayed: boolean;
  readonly tradingEnabled: boolean;
  readonly now: Date;
}

export interface OrderRecord {
  readonly id: string;
  readonly accountId: string;
  readonly instrumentId: string;
  readonly clientOrderId: string;
  readonly side: OrderSide;
  readonly qty: string;
  readonly filledQty: string;
  readonly status: 'FILLED' | 'REJECTED';
  readonly rejectCode: string | null;
}

export interface ExecutionRecord {
  readonly id: string;
  readonly orderId: string;
  readonly price: string;
  readonly qty: string;
  readonly feeLocal: string;
  readonly grossUsd: string;
  readonly slippageBps: string;
  readonly ledgerTxId: string;
  readonly modelVersion: string;
  readonly executedAt: Date;
}

export type ExecutionResult =
  | {
      readonly outcome: 'FILLED';
      /** true when this is the stored result of an earlier call with the same clientOrderId. */
      readonly replayed: boolean;
      readonly order: OrderRecord;
      readonly execution: ExecutionRecord;
      readonly ledgerTxId: string;
    }
  | {
      readonly outcome: 'REJECTED';
      readonly replayed: boolean;
      readonly order: OrderRecord;
      readonly rejectCode: RejectCode;
    };

/**
 * `accountLocked`: the caller already called lock_account_for_order for THIS account in THIS transaction (the HTTP
 * layer does, to check its idempotency key under the lock), so the lock is not taken a second time. Never set it
 * without having taken the lock: the lock order account -> CASH -> position -> lots is what serialises an account.
 */
export interface ExecuteOptions {
  readonly accountLocked?: boolean;
}

/** Test-only seams. Production callers pass nothing. */
export interface ExecuteHooks {
  /** Runs after the ledger transaction was posted and before the rest of the fill (to prove atomicity). */
  readonly afterLedgerPost?: () => void | Promise<void>;
}

interface OrderRow {
  id: string;
  account_id: string;
  instrument_id: string;
  client_order_id: string;
  side: OrderSide;
  qty: string;
  filled_qty: string;
  status: 'FILLED' | 'REJECTED';
  reject_code: string | null;
}

const toOrder = (r: OrderRow): OrderRecord => ({
  id: r.id,
  accountId: r.account_id,
  instrumentId: r.instrument_id,
  clientOrderId: r.client_order_id,
  side: r.side,
  qty: parse(r.qty).toString(),
  filledQty: parse(r.filled_qty).toString(),
  status: r.status,
  rejectCode: r.reject_code,
});

const ORDER_COLUMNS = `id, account_id, instrument_id, client_order_id, side::text AS side, qty, filled_qty,
  status::text AS status, reject_code`;

/** What the decision depends on besides the command itself: read under the account locks by the executor. */
export interface DecisionState {
  readonly accountActive: boolean;
  /** CASH balance (USD), a plain decimal string. */
  readonly cash: string;
  /** Open quantity of this instrument. */
  readonly positionQty: string;
}

/**
 * The ONE place a command and the account state become a decision. The executor calls it under its locks, and the order
 * preview (D-70) calls it on a plain read, so the preview can never use different rules from the real order.
 */
export function decideForCommand(
  cmd: MarketOrderCommand,
  state: DecisionState,
): MarketOrderDecision {
  return decideMarketOrder({
    side: cmd.side,
    qty: cmd.qty,
    instrument: cmd.instrument,
    quote: cmd.quote === null ? null : { bid: cmd.quote.bid, ask: cmd.quote.ask },
    freshness: cmd.freshness,
    allowExecutionOnDelayed: cmd.allowExecutionOnDelayed,
    schedule: cmd.feeSchedule,
    referencePrice: cmd.referencePrice,
    account: { active: state.accountActive, tradingEnabled: cmd.tradingEnabled },
    cash: state.cash,
    positionQty: state.positionQty,
    collarPercent: collarPercentFor(cmd.instrument.assetClass),
  });
}

export async function executeMarketOrder(
  client: Queryable,
  cmd: MarketOrderCommand,
  hooks: ExecuteHooks = {},
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  // 1. LOCK the account row first, always (via a SECURITY DEFINER function that only locks and returns nothing:
  //    the app role has no UPDATE on accounts, D-55). The status is then read with a NEW statement, so it is the
  //    latest committed state after the wait for the lock.
  if (options.accountLocked !== true) {
    await client.query(`SELECT lock_account_for_order($1::uuid)`, [cmd.accountId]);
  }
  const acct = await client.query<{ account_status: string; user_status: string }>(
    `SELECT a.status AS account_status, u.status::text AS user_status
       FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.id = $1::uuid`,
    [cmd.accountId],
  );
  const account = acct.rows[0];
  if (account === undefined) throw new AccountNotFoundError('account not found');
  const accountActive = account.account_status === 'ACTIVE' && account.user_status === 'ACTIVE';

  // 2. REPLAY: an order with this clientOrderId already exists
  const existing = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE account_id = $1::uuid AND client_order_id = $2`,
    [cmd.accountId, cmd.clientOrderId],
  );
  if (existing.rows[0] !== undefined) return replay(client, cmd, existing.rows[0]);

  // 3. READ and lock cash, then the position, then its open lots (oldest first)
  await client.query(`SELECT lock_cash_balance($1::uuid)`, [cmd.accountId]);
  const cashRow = await client.query<{ balance: string }>(
    `SELECT balance FROM ledger_accounts
      WHERE account_id = $1::uuid AND type = 'CASH' AND currency = 'USD'`,
    [cmd.accountId],
  );
  const cash = cashRow.rows[0]?.balance ?? '0';
  const posRow = await client.query<{ qty: string; qty_reserved: string }>(
    `SELECT qty, qty_reserved FROM positions WHERE account_id = $1::uuid AND instrument_id = $2::uuid FOR UPDATE`,
    [cmd.accountId, cmd.instrument.id],
  );
  const positionTotal = posRow.rows[0]?.qty ?? '0';
  // D-96 (M8b-1): a SELL, market or limit, may only use the FREE quantity: positions.qty - positions.qty_reserved
  const positionQty = sub(
    parse(positionTotal),
    parse(posRow.rows[0]?.qty_reserved ?? '0'),
  ).toString();
  const lotRows = await client.query<{
    id: string;
    qty_open: string;
    cost_remaining: string;
    opened_at: Date;
  }>(
    `SELECT id, qty_open, cost_remaining, opened_at FROM position_lots
      WHERE account_id = $1::uuid AND instrument_id = $2::uuid AND qty_open > 0
      ORDER BY opened_at, id FOR UPDATE`,
    [cmd.accountId, cmd.instrument.id],
  );
  const openLots: OpenLot[] = lotRows.rows.map((l) => ({
    id: l.id,
    openedAt: l.opened_at,
    qtyOpen: l.qty_open,
    costRemaining: l.cost_remaining,
  }));

  // 4. DECIDE (the engine is the only place that decides)
  const decision = decideForCommand(cmd, { accountActive, cash, positionQty });

  const created = {
    type: 'MARKET',
    side: cmd.side,
    qty: cmd.qty,
    instrumentId: cmd.instrument.id,
    symbol: cmd.instrument.symbol,
    referencePrice: cmd.referencePrice,
    clientOrderId: cmd.clientOrderId,
  };

  try {
    if (decision.decision === 'REJECT') {
      await insertOrder(client, cmd, 'REJECTED', '0', decision.code);
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
                    : {
                        bid: cmd.quote.bid,
                        ask: cmd.quote.ask,
                        ts: cmd.quote.providerTs.toISOString(),
                        source: cmd.quote.source,
                        entitlement: cmd.quote.entitlement,
                      },
                cash,
                positionQty,
                allowExecutionOnDelayed: cmd.allowExecutionOnDelayed,
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
        order: orderRecord(cmd, 'REJECTED', '0', decision.code),
        rejectCode: decision.code,
      };
    }

    // 5. FILL
    if (cmd.quote === null) throw new Error('a FILL decision needs a quote'); // unreachable: the engine rejects first
    const { price, notional, fee, slippageBps } = decision;
    const executionId = newId();

    let consumptions: LotConsumption[] = [];
    let basis = '0';
    if (cmd.side === 'SELL') {
      consumptions = consumeLotsFIFO(openLots, cmd.qty);
      basis = consumptions.reduce((acc, c) => add(acc, parse(c.cost)), parse('0')).toString();
    }
    const legs =
      cmd.side === 'BUY'
        ? buyFillLegs({ qty: cmd.qty, price, fee })
        : sellFillLegs({ qty: cmd.qty, price, fee, basis });
    // ONE cost number: the BUY lot's cost is the POSITION_COST leg that is posted, and a SELL's basis is the sum of the
    // consumed lot costs (D-85). Nothing recomputes either of them.
    const positionCostLeg = legs.find((l) => l.ledgerAccountType === 'POSITION_COST');
    const buyCost = cmd.side === 'BUY' ? (positionCostLeg?.amount ?? '0') : '0';
    if (cmd.side === 'BUY' && sign(parse(buyCost)) <= 0) {
      throw new Error('a BUY lot needs a positive cost'); // unreachable: the engine rejects a zero-cost BUY first
    }
    const posted = await postTransaction(client, {
      accountId: cmd.accountId,
      kind: 'FILL',
      idempotencyKey: `fill:${cmd.orderId}:1`,
      description: `${cmd.side} ${cmd.qty} ${cmd.instrument.symbol} @ ${price}`,
      orderId: cmd.orderId,
      executionId,
      legs,
    });
    await hooks.afterLedgerPost?.();

    await insertOrder(client, cmd, 'FILLED', cmd.qty, null);
    await insertEvents(
      client,
      cmd.orderId,
      [
        { type: 'CREATED', payload: created },
        { type: 'ACCEPTED', payload: {} },
        {
          type: 'FILLED',
          payload: { executionId, price, qty: cmd.qty, ledgerTxId: posted.transactionId },
        },
      ],
      cmd.now,
    );
    await persistFillEffects(client, {
      orderId: cmd.orderId,
      accountId: cmd.accountId,
      instrumentId: cmd.instrument.id,
      executionId,
      side: cmd.side,
      qty: cmd.qty,
      price,
      notional,
      fee,
      slippageBps,
      quote: cmd.quote,
      modelVersion: cmd.feeSchedule.modelVersion,
      ledgerTxId: posted.transactionId,
      now: cmd.now,
      openLots,
      positionQty: positionTotal,
      buyCost,
      consumptions,
      basis,
      qtyReservedDelta: '0',
    });

    return {
      outcome: 'FILLED',
      replayed: false,
      order: orderRecord(cmd, 'FILLED', cmd.qty, null),
      ledgerTxId: posted.transactionId,
      execution: {
        id: executionId,
        orderId: cmd.orderId,
        price,
        qty: cmd.qty,
        feeLocal: fee,
        grossUsd: notional,
        slippageBps,
        ledgerTxId: posted.transactionId,
        modelVersion: cmd.feeSchedule.modelVersion,
        executedAt: cmd.now,
      },
    };
  } catch (e) {
    throw mapDbError(e);
  }
}

function orderRecord(
  cmd: MarketOrderCommand,
  status: 'FILLED' | 'REJECTED',
  filledQty: string,
  rejectCode: string | null,
): OrderRecord {
  return {
    id: cmd.orderId,
    accountId: cmd.accountId,
    instrumentId: cmd.instrument.id,
    clientOrderId: cmd.clientOrderId,
    side: cmd.side,
    qty: cmd.qty,
    filledQty,
    status,
    rejectCode,
  };
}

async function insertOrder(
  client: Queryable,
  cmd: MarketOrderCommand,
  status: 'FILLED' | 'REJECTED',
  filledQty: string,
  rejectCode: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO orders (id, account_id, instrument_id, client_order_id, side, type, qty, filled_qty, status,
                         reject_code, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::order_side, 'MARKET', $6::numeric, $7::numeric,
             $8::order_status, $9, $10, $10)`,
    [
      cmd.orderId,
      cmd.accountId,
      cmd.instrument.id,
      cmd.clientOrderId,
      cmd.side,
      cmd.qty,
      filledQty,
      status,
      rejectCode,
      cmd.now,
    ],
  );
}

/** Appends events in one statement; `seq` continues from the highest existing one (1, 2, 3 ... for a new order), contiguous. */
export async function insertEvents(
  client: Queryable,
  orderId: string,
  events: ReadonlyArray<{ type: string; payload: unknown }>,
  at: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO order_events (order_id, seq, type, payload, created_at)
     SELECT $1::uuid, (SELECT COALESCE(MAX(seq), 0) FROM order_events WHERE order_id = $1::uuid) + t.ord::int, t.type, t.payload, $4
       FROM unnest($2::text[], $3::jsonb[]) WITH ORDINALITY AS t(type, payload, ord)
      ORDER BY t.ord`,
    [orderId, events.map((e) => e.type), events.map((e) => JSON.stringify(e.payload)), at],
  );
}

/** The stored result of an earlier call. Throws if the parameters differ. Never fills again. */
async function replay(
  client: Queryable,
  cmd: MarketOrderCommand,
  row: OrderRow,
): Promise<ExecutionResult> {
  const ev = await client.query<{ payload: { referencePrice?: string } }>(
    `SELECT payload FROM order_events WHERE order_id = $1::uuid AND seq = 1`,
    [row.id],
  );
  const storedRef = ev.rows[0]?.payload.referencePrice;
  const same =
    row.instrument_id === cmd.instrument.id &&
    row.side === cmd.side &&
    parse(row.qty).equals(parse(cmd.qty)) &&
    storedRef !== undefined &&
    parse(storedRef).equals(parse(cmd.referencePrice));
  if (!same) {
    throw new ClientOrderIdMismatchError(
      'clientOrderId was already used with different parameters',
    );
  }
  const order = toOrder(row);
  if (row.status === 'REJECTED') {
    return {
      outcome: 'REJECTED',
      replayed: true,
      order,
      rejectCode: row.reject_code as RejectCode,
    };
  }
  const ex = await client.query<{
    id: string;
    price: string;
    qty: string;
    fee_local: string;
    gross_usd: string;
    slippage_bps: string;
    ledger_tx_id: string;
    model_version: string;
    executed_at: Date;
  }>(
    `SELECT id, price, qty, fee_local, gross_usd, slippage_bps, ledger_tx_id, model_version, executed_at
       FROM executions WHERE order_id = $1::uuid AND seq = 1`,
    [row.id],
  );
  const e = ex.rows[0];
  if (e === undefined) throw new Error('a FILLED order has no execution'); // corruption: I5 forbids it
  return {
    outcome: 'FILLED',
    replayed: true,
    order,
    ledgerTxId: e.ledger_tx_id,
    execution: {
      id: e.id,
      orderId: row.id,
      price: parse(e.price).toString(),
      qty: parse(e.qty).toString(),
      feeLocal: parse(e.fee_local).toString(),
      grossUsd: parse(e.gross_usd).toString(),
      slippageBps: parse(e.slippage_bps).toString(),
      ledgerTxId: e.ledger_tx_id,
      modelVersion: e.model_version,
      executedAt: e.executed_at,
    },
  };
}

function mapDbError(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string } | null;
  if (err?.code === '23505' && err.constraint === 'orders_account_id_client_order_id_key') {
    return new DuplicateClientOrderIdError(
      'the clientOrderId was used concurrently; retry to get the stored result',
      {
        cause: e,
      },
    );
  }
  return e;
}
