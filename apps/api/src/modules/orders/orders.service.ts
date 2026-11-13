import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { Config } from '@vantage/config';
import {
  ORDERS_PAGE,
  ORDER_PREVIEW_DISCLAIMER,
  OrderPreviewResponse,
  OrderResponse,
} from '@vantage/contracts';
import type {
  ListOrdersQuery,
  ListOrdersResponse,
  PlaceOrderRequest,
  PositionResponse,
} from '@vantage/contracts';
import type { InstrumentStatus } from '@vantage/market-model';
import { parse } from '@vantage/money';
import { decodeCursor, encodeCursor } from '../../common/cursor.js';
import { AppError } from '../../common/errors.js';
import { newId } from '../../ids.js';
import type { Logger } from '../../log.js';
import { CLOCK, CONFIG, LOGGER, ORDER_HOOKS, POOL } from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { QuoteService } from '../market-data/quote.service.js';
import type { QuoteSnapshotResult } from '../market-data/quote.service.js';
import {
  ClientOrderIdMismatchError,
  DuplicateClientOrderIdError,
  executeMarketOrder,
} from '../trading/index.js';
import { previewMarketOrder } from '../trading/preview.js';
import type {
  DecisionState,
  ExecuteHooks,
  ExecutionResult,
  FeeScheduleSnapshot,
  MarketOrderCommand,
} from '../trading/index.js';

/**
 * D-09 / TRADING_ENGINE section 3: execution against DELAYED quotes is allowed in the MVP (the flag defaults to
 * true). It is a constant here, not an environment variable: nothing in the specs asks to switch it per
 * environment, and the engine takes it as an input so a later config source needs no engine change.
 */
export const ALLOW_EXECUTION_ON_DELAYED = true;

export interface PlacedOrder {
  /** 201 for a first call; a replay returns the stored status code. */
  readonly status: number;
  readonly body: OrderResponse;
  readonly replayed: boolean;
}

export interface RequestMeta {
  readonly requestId: string;
  readonly ip?: string | undefined;
}

interface InstrumentContext {
  readonly instrument: MarketOrderCommand['instrument'] & {
    readonly exchange: string;
    assetClass: string;
  };
  readonly feeSchedule: FeeScheduleSnapshot;
}

/** Canonical hash of the VALIDATED request (not the raw bytes): fixed key order, canonical decimal price. */
export function requestHash(body: PlaceOrderRequest): Buffer {
  const canonical = JSON.stringify([
    body.symbol,
    body.side,
    body.type,
    body.qty,
    parse(body.referencePrice).toString(),
  ]);
  return createHash('sha256').update(canonical).digest();
}

const fmtMoney = (v: string): string => parse(v).toCanonicalString();
const fmtPlain = (v: string): string => parse(v).toString();

interface OrderRow {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: 'FILLED' | 'REJECTED';
  qty: string;
  filled_qty: string;
  reject_code: string | null;
  created_at: Date;
  ckey: string;
  ex_id: string | null;
  ex_qty: string | null;
  price: string | null;
  gross_usd: string | null;
  fee_local: string | null;
  slippage_bps: string | null;
  executed_at: Date | null;
  quote_source: string | null;
}

const ORDER_SELECT = `
  SELECT o.id, i.symbol, o.side::text AS side, o.status::text AS status, o.qty, o.filled_qty, o.reject_code,
         o.created_at,
         to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ckey,
         e.id AS ex_id, e.qty AS ex_qty, e.price, e.gross_usd, e.fee_local, e.slippage_bps, e.executed_at,
         e.quote_source
    FROM orders o
    JOIN accounts a ON a.id = o.account_id
    JOIN instruments i ON i.id = o.instrument_id
    LEFT JOIN executions e ON e.order_id = o.id AND e.seq = 1`;

function toResponse(r: OrderRow): OrderResponse {
  return OrderResponse.parse({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    type: 'MARKET',
    status: r.status,
    qty: fmtPlain(r.qty),
    filledQty: fmtPlain(r.filled_qty),
    rejectCode: r.reject_code,
    createdAt: r.created_at.toISOString(),
    execution:
      r.ex_id === null
        ? null
        : {
            id: r.ex_id,
            qty: fmtPlain(r.ex_qty ?? '0'),
            price: fmtMoney(r.price ?? '0'),
            notional: fmtMoney(r.gross_usd ?? '0'),
            fee: fmtMoney(r.fee_local ?? '0'),
            slippageBps: fmtPlain(r.slippage_bps ?? '0'),
            executedAt: (r.executed_at ?? r.created_at).toISOString(),
            quoteSource: r.quote_source ?? '',
          },
  });
}

/** Builds the response from the execution result (no extra read). The shape equals what GET returns. */
function fromResult(result: ExecutionResult, cmd: MarketOrderCommand): OrderResponse {
  const order = result.order;
  return OrderResponse.parse({
    id: order.id,
    symbol: cmd.instrument.symbol,
    side: order.side,
    type: 'MARKET',
    status: order.status,
    qty: fmtPlain(order.qty),
    filledQty: fmtPlain(order.filledQty),
    rejectCode: order.rejectCode,
    createdAt: cmd.now.toISOString(),
    execution:
      result.outcome === 'FILLED'
        ? {
            id: result.execution.id,
            qty: fmtPlain(result.execution.qty),
            price: fmtMoney(result.execution.price),
            notional: fmtMoney(result.execution.grossUsd),
            fee: fmtMoney(result.execution.feeLocal),
            slippageBps: fmtPlain(result.execution.slippageBps),
            executedAt: result.execution.executedAt.toISOString(),
            quoteSource: cmd.quote?.source ?? '',
          }
        : null,
  });
}

export const orderNotFound = (): AppError =>
  new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

@Injectable()
export class OrdersService {
  constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ORDER_HOOKS) private readonly hooks: ExecuteHooks,
  ) {}

  /**
   * POST /v1/orders. D-58: the Idempotency-Key is also the order's client_order_id. The account, instrument,
   * quote, fee schedule, kill switch and time are decided here, never by the client (D-59).
   */
  async place(
    userId: string,
    key: string,
    body: PlaceOrderRequest,
    meta: RequestMeta,
  ): Promise<PlacedOrder> {
    const hash = requestHash(body);

    // 1. Resolve the caller's account and look up (account, key) first, in ONE query. Stored rows never change,
    //    so a hit needs no lock.
    const { accountId, stored: earlier } = await this.#accountAndStored(userId, key, hash);
    if (earlier !== undefined) return earlier;

    // 2. Resolve what the server decides.
    const ctx = await this.#instrumentContext(body.symbol);
    const now = this.clock.now();
    const snap = await this.quotes.snapshotFor(
      {
        symbol: ctx.instrument.symbol,
        exchange: ctx.instrument.exchange,
        status: ctx.instrument.status,
        assetClass: ctx.instrument.assetClass,
      },
      now,
    );
    const cmd = this.#command({
      orderId: newId(),
      accountId,
      clientOrderId: key,
      body,
      ctx,
      snap,
      now,
    });

    // 3. One transaction: lock, re-check the key (a concurrent twin may have committed), execute, store.
    const client = await this.pool.connect();
    let placed: PlacedOrder;
    try {
      await client.query('BEGIN');
      await client.query('SELECT lock_account_for_order($1::uuid)', [accountId]);
      const twin = await this.#stored(client, accountId, key, hash);
      if (twin !== undefined) {
        await client.query('ROLLBACK');
        return twin;
      }
      let result: ExecutionResult;
      try {
        result = await executeMarketOrder(client, cmd, this.hooks, { accountLocked: true });
      } catch (e) {
        if (e instanceof DuplicateClientOrderIdError || e instanceof ClientOrderIdMismatchError) {
          // Unreachable through HTTP (the key row and the order are written together); kept as a guard.
          throw new AppError(409, 'DUPLICATE_CLIENT_ORDER_ID', 'Duplicate client order id');
        }
        throw e;
      }
      const response = fromResult(result, cmd);
      await client.query(
        `INSERT INTO idempotency_keys (account_id, key, request_hash, response_code, response_body)
         VALUES ($1::uuid, $2, $3, 201, $4::jsonb)`,
        [accountId, key, hash, JSON.stringify(response)],
      );
      await client.query('COMMIT');
      placed = { status: 201, body: response, replayed: false };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }

    this.logger.info('order_placed', {
      requestId: meta.requestId,
      orderId: placed.body.id,
      outcome: placed.body.status,
      rejectCode: placed.body.rejectCode ?? undefined,
    });
    await this.audit.record({
      action: 'ORDER_PLACED',
      actorId: userId,
      targetType: 'order',
      targetId: placed.body.id,
      after: { outcome: placed.body.status, rejectCode: placed.body.rejectCode },
      ...(meta.ip === undefined ? {} : { ip: meta.ip }),
      requestId: meta.requestId,
    });
    return placed;
  }

  /** The command both the real order and the preview hand to the engine: one mapping, so they cannot drift apart. */
  #command(input: {
    orderId: string;
    accountId: string;
    clientOrderId: string;
    body: PlaceOrderRequest;
    ctx: InstrumentContext;
    snap: QuoteSnapshotResult;
    now: Date;
  }): MarketOrderCommand {
    const { body, ctx, snap } = input;
    return {
      orderId: input.orderId,
      accountId: input.accountId,
      clientOrderId: input.clientOrderId,
      instrument: ctx.instrument,
      side: body.side,
      qty: body.qty,
      referencePrice: parse(body.referencePrice).toString(),
      quote:
        snap.quote === null
          ? null
          : {
              bid: snap.quote.bid,
              ask: snap.quote.ask,
              ...(snap.quote.last === undefined ? {} : { last: snap.quote.last }),
              providerTs: snap.quote.providerTs,
              source: snap.quote.source,
              entitlement: snap.quote.entitlement,
              delaySeconds: snap.quote.delaySeconds,
            },
      freshness: snap.freshness,
      feeSchedule: ctx.feeSchedule,
      allowExecutionOnDelayed: ALLOW_EXECUTION_ON_DELAYED,
      tradingEnabled: this.config.tradingEnabled,
      now: input.now,
    };
  }

  /**
   * POST /v1/orders/preview (D-70): what this order would do right now. It decides with the SAME engine function as the
   * real order (decideForCommand) on the current quote, fee schedule, cash and position, read in one read-only
   * REPEATABLE READ transaction. It takes no locks, writes nothing, is not audit-logged and is advisory only: the real
   * order decides again, against the quote of that moment.
   */
  async preview(userId: string, body: PlaceOrderRequest): Promise<OrderPreviewResponse> {
    const ctx = await this.#instrumentContext(body.symbol);
    const now = this.clock.now();
    const snap = await this.quotes.snapshotFor(
      {
        symbol: ctx.instrument.symbol,
        exchange: ctx.instrument.exchange,
        status: ctx.instrument.status,
        assetClass: ctx.instrument.assetClass,
      },
      now,
    );
    const state = await this.#readState(userId, ctx.instrument.id);
    const cmd = this.#command({
      orderId: newId(),
      accountId: state.accountId,
      clientOrderId: 'preview',
      body,
      ctx,
      snap,
      now,
    });
    const out = previewMarketOrder(cmd, state);
    const q = snap.quote;
    const money = (v: string | null | undefined): string | null =>
      v === null || v === undefined ? null : parse(v).toCanonicalString();
    return OrderPreviewResponse.parse({
      wouldFill: out.wouldFill,
      rejectCode: out.rejectCode,
      estimatedPrice: money(out.estimate?.price),
      estimatedNotional: money(out.estimate?.notional),
      estimatedFee: money(out.estimate?.fee),
      estimatedCashAfter: money(out.estimate?.cashAfter),
      estimatedProceeds: money(out.estimate?.proceeds),
      slippageBps:
        out.estimate === undefined || out.estimate === null
          ? null
          : parse(out.estimate.slippageBps).toString(),
      quote: {
        bid: q === null ? null : money(q.bid),
        ask: q === null ? null : money(q.ask),
        last: q === null ? null : money(q.last),
        asOf: q === null ? null : q.providerTs.toISOString(),
        source: q === null ? null : q.source,
        freshness: snap.freshness,
      },
      disclaimer: ORDER_PREVIEW_DISCLAIMER,
      generatedAt: now.toISOString(),
    });
  }

  /** Account status, cash and position in ONE read-only snapshot: no lock, no write. */
  async #readState(
    userId: string,
    instrumentId: string,
  ): Promise<{ accountId: string } & DecisionState> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const r = await client.query<{
        id: string;
        account_status: string;
        user_status: string;
        cash: string | null;
        position_qty: string | null;
      }>(
        `SELECT a.id, a.status AS account_status, u.status::text AS user_status,
                (SELECT la.balance FROM ledger_accounts la
                  WHERE la.account_id = a.id AND la.type = 'CASH' AND la.currency = 'USD') AS cash,
                (SELECT p.qty FROM positions p
                  WHERE p.account_id = a.id AND p.instrument_id = $2::uuid) AS position_qty
           FROM accounts a JOIN users u ON u.id = a.user_id
          WHERE a.user_id = $1::uuid AND a.kind = 'MAIN'`,
        [userId, instrumentId],
      );
      await client.query('COMMIT');
      const row = r.rows[0];
      if (row === undefined) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
      return {
        accountId: row.id,
        accountActive: row.account_status === 'ACTIVE' && row.user_status === 'ACTIVE',
        cash: row.cash ?? '0',
        positionQty: row.position_qty ?? '0',
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async get(userId: string, orderId: string): Promise<OrderResponse> {
    const r = await this.pool.query<OrderRow>(
      `${ORDER_SELECT} WHERE a.user_id = $1::uuid AND a.kind = 'MAIN' AND o.id = $2::uuid`,
      [userId, orderId],
    );
    const row = r.rows[0];
    if (row === undefined) throw orderNotFound();
    return toResponse(row);
  }

  async list(userId: string, q: ListOrdersQuery): Promise<ListOrdersResponse> {
    const limit = q.limit ?? ORDERS_PAGE.defaultLimit;
    const cur = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
    const r = await this.pool.query<OrderRow>(
      `${ORDER_SELECT}
        WHERE a.user_id = $1::uuid AND a.kind = 'MAIN'
          AND ($2::text IS NULL OR o.status::text = $2::text)
          AND ($3::text IS NULL OR upper(i.symbol) = $3::text)
          AND ($4::timestamptz IS NULL OR (o.created_at, o.id) < ($4::timestamptz, $5::uuid))
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $6::int`,
      [userId, q.status ?? null, q.symbol ?? null, cur?.t ?? null, cur?.id ?? null, limit + 1],
    );
    const page = r.rows.slice(0, limit);
    const last = page[page.length - 1];
    const more = r.rows.length > limit && last !== undefined;
    return {
      orders: page.map(toResponse),
      nextCursor: more ? encodeCursor({ t: last.ckey, id: last.id }) : null,
    };
  }

  async positions(userId: string): Promise<PositionResponse[]> {
    const r = await this.pool.query<{ symbol: string; qty: string; avg_cost_local: string }>(
      `SELECT i.symbol, p.qty, p.avg_cost_local
         FROM positions p
         JOIN accounts a ON a.id = p.account_id
         JOIN instruments i ON i.id = p.instrument_id
        WHERE a.user_id = $1::uuid AND a.kind = 'MAIN' AND p.qty > 0
        ORDER BY i.symbol`,
      [userId],
    );
    return r.rows.map((x) => ({
      symbol: x.symbol,
      qty: fmtPlain(x.qty),
      avgCost: fmtMoney(x.avg_cost_local),
    }));
  }

  /** The caller's MAIN account and the stored answer for (account, key), if any, in one round trip. */
  async #accountAndStored(
    userId: string,
    key: string,
    hash: Buffer,
  ): Promise<{ accountId: string; stored: PlacedOrder | undefined }> {
    const r = await this.pool.query<{
      id: string;
      request_hash: Buffer | null;
      response_code: number | null;
      response_body: unknown;
    }>(
      `SELECT a.id, k.request_hash, k.response_code, k.response_body
         FROM accounts a
         LEFT JOIN idempotency_keys k ON k.account_id = a.id AND k.key = $2
        WHERE a.user_id = $1::uuid AND a.kind = 'MAIN'`,
      [userId, key],
    );
    const row = r.rows[0];
    if (row === undefined) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    return {
      accountId: row.id,
      stored:
        row.request_hash === null
          ? undefined
          : this.#asPlaced(row.request_hash, row.response_code, row.response_body, hash),
    };
  }

  /** The stored answer for (account, key): the same request returns it, a different one is a 422. */
  async #stored(
    db: Pick<pg.ClientBase, 'query'>,
    accountId: string,
    key: string,
    hash: Buffer,
  ): Promise<PlacedOrder | undefined> {
    const r = await db.query<{
      request_hash: Buffer;
      response_code: number | null;
      response_body: unknown;
    }>(
      `SELECT request_hash, response_code, response_body FROM idempotency_keys
        WHERE account_id = $1::uuid AND key = $2`,
      [accountId, key],
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    return this.#asPlaced(row.request_hash, row.response_code, row.response_body, hash);
  }

  /** The same request returns the stored answer; a different one is a 422. */
  #asPlaced(
    storedHash: Buffer,
    code: number | null,
    responseBody: unknown,
    hash: Buffer,
  ): PlacedOrder {
    if (!storedHash.equals(hash)) {
      throw new AppError(
        422,
        'IDEMPOTENCY_MISMATCH',
        'This Idempotency-Key was already used with a different request',
      );
    }
    return {
      status: code ?? 201,
      body: OrderResponse.parse(responseBody),
      replayed: true,
    };
  }

  async #instrumentContext(symbol: string): Promise<InstrumentContext> {
    const r = await this.pool.query<{
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
    }>(
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
        WHERE upper(i.symbol) = $1`,
      [symbol, this.clock.now()],
    );
    const x = r.rows[0];
    if (x === undefined) throw new AppError(404, 'INSTRUMENT_NOT_FOUND', 'Instrument not found');
    if (x.commission_bps === null) {
      // A configuration error (no fee schedule for this asset class): an internal error, not the client's.
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
}
