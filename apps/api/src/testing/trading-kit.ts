// Helpers for the trading integration tests (not part of the build). Real Postgres, accounts created with the
// M1 ledger repository, the app role as `vantage_app`, an injected clock (the `now` carried by each command).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { TestDatabase } from '@vantage/test-utils';
import { newId } from '../ids.js';
import { createAccount, grantInitialCapital } from '../modules/ledger/repository.js';
import { executeMarketOrder } from '../modules/trading/execute-market-order.js';
import {
  acceptLimitOrder,
  cancelOrder,
  expireOrder,
  fillRestingOrder,
} from '../modules/trading/limit-orders.js';
import type { LimitOrderCommand } from '../modules/trading/limit-orders.js';
import type {
  ExecuteHooks,
  ExecutionResult,
  FeeScheduleSnapshot,
  MarketOrderCommand,
  QuoteSnapshot,
} from '../modules/trading/execute-market-order.js';

export const NOW = new Date('2026-11-10T15:00:00.000Z');
export const SCHEDULE_V1: FeeScheduleSnapshot = {
  commissionBps: '0',
  commissionMinLocal: '0',
  slippageBaseBps: '2',
  slippageSizeCoef: '0',
  modelVersion: 'QBX-1/r8he',
};

export async function insertUser(c: Pick<pg.PoolClient, 'query'>): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO users (id, email, password_hash, role, status, display_name, country_code, is_adult)
     VALUES ($1::uuid, $2, 'not-a-real-hash', 'USER', 'ACTIVE', 'Trader', 'US', true)`,
    [id, `${id}@test.invalid`],
  );
  return id;
}

/** A MAIN account with the standard USD ledger accounts and the granted starting capital. */
export async function createFundedAccount(pool: pg.Pool, capital = '10000'): Promise<string> {
  const accountId = newId();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const userId = await insertUser(c);
    await createAccount(c, { accountId, userId, kind: 'MAIN', initialCapital: capital });
    await grantInitialCapital(c, accountId);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return accountId;
}

export interface TestInstrument {
  readonly id: string;
  readonly symbol: string;
}

/** Inserts a whole-share US equity (tradable in the MVP) through the migrator. */
export async function createInstrument(
  db: TestDatabase,
  symbol: string,
  exchange = 'XNAS',
): Promise<TestInstrument> {
  const id = newId();
  const exch = await db.migrator.query<{ id: string }>(`SELECT id FROM exchanges WHERE code = $1`, [
    exchange,
  ]);
  await db.migrator.query(
    `INSERT INTO instruments (id, symbol, name, asset_class, exchange_id, quote_currency, tick_size, qty_step, min_qty,
                              fractional_ok, tradable_in, attrs)
     VALUES ($1::uuid, $2, $3, 'EQUITY', $4::uuid, 'USD', 0.01, 1, 1, false, '{MVP}', '{"source":"SYNTHETIC"}')`,
    [id, symbol, `${symbol} Test Corp`, exch.rows[0]?.id],
  );
  return { id, symbol };
}

export interface CommandOverrides {
  readonly orderId?: string;
  readonly clientOrderId?: string;
  readonly side?: 'BUY' | 'SELL';
  readonly qty?: string;
  readonly bid?: string;
  readonly ask?: string;
  readonly last?: string;
  readonly referencePrice?: string;
  readonly now?: Date;
  readonly freshness?: MarketOrderCommand['freshness'];
  readonly quote?: MarketOrderCommand['quote'];
  readonly feeSchedule?: FeeScheduleSnapshot;
  readonly allowExecutionOnDelayed?: boolean;
  readonly tradingEnabled?: boolean;
  readonly instrument?: Partial<MarketOrderCommand['instrument']>;
}

/** A command with sensible defaults: AAPL-like quote bid 189.95 / ask 190.00, DELAYED, schedule v1. */
export function command(
  accountId: string,
  inst: TestInstrument,
  o: CommandOverrides = {},
): MarketOrderCommand {
  const side = o.side ?? 'BUY';
  const bid = o.bid ?? '189.95';
  const ask = o.ask ?? '190.00';
  const now = o.now ?? NOW;
  return {
    orderId: o.orderId ?? newId(),
    accountId,
    clientOrderId: o.clientOrderId ?? randomUUID(),
    instrument: {
      id: inst.id,
      symbol: inst.symbol,
      status: 'ACTIVE',
      tradableIn: ['MVP'],
      tickSize: '0.01',
      minQty: '1',
      qtyStep: '1',
      ...o.instrument,
    },
    side,
    qty: o.qty ?? '10',
    referencePrice: o.referencePrice ?? (side === 'BUY' ? ask : bid),
    quote:
      o.quote !== undefined
        ? o.quote
        : {
            bid,
            ask,
            ...(o.last === undefined ? {} : { last: o.last }),
            providerTs: new Date(now.getTime() - 900_000),
            source: 'FIXTURE',
            entitlement: 'DELAYED',
            delaySeconds: 900,
          },
    freshness: o.freshness ?? 'DELAYED',
    feeSchedule: o.feeSchedule ?? SCHEDULE_V1,
    allowExecutionOnDelayed: o.allowExecutionOnDelayed ?? true,
    tradingEnabled: o.tradingEnabled ?? true,
    now,
  };
}

/** Runs one order in its own transaction: BEGIN, execute, COMMIT (ROLLBACK and rethrow on any error). */
export async function run(
  pool: pg.Pool,
  cmd: MarketOrderCommand,
  hooks?: ExecuteHooks,
): Promise<ExecutionResult> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await executeMarketOrder(c, cmd, hooks);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export interface AccountState {
  readonly counts: Record<string, number>;
  readonly balances: Record<string, string>;
  readonly positions: unknown[];
  readonly lots: unknown[];
}

/** Everything observable about an account's trading state, read with the migrator (no row-level surprises). */
export async function accountState(db: TestDatabase, accountId: string): Promise<AccountState> {
  const q = async (sql: string): Promise<pg.QueryResultRow[]> =>
    (await db.migrator.query(sql, [accountId])).rows;
  const count = async (table: string, col = 'account_id'): Promise<number> =>
    Number((await q(`SELECT count(*) AS n FROM ${table} WHERE ${col} = $1::uuid`))[0]?.n);
  const balances = Object.fromEntries(
    (
      await q(
        `SELECT type::text AS type, balance FROM ledger_accounts WHERE account_id = $1::uuid AND currency = 'USD'`,
      )
    ).map((r) => [r.type as string, r.balance as string]),
  );
  return {
    counts: {
      orders: await count('orders'),
      executions: await count('executions'),
      lots: await count('position_lots'),
      positions: await count('positions'),
      ledgerTransactions: await count('ledger_transactions'),
      events: Number(
        (
          await q(
            `SELECT count(*) AS n FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.account_id = $1::uuid`,
          )
        )[0]?.n,
      ),
      closures: Number(
        (
          await q(
            `SELECT count(*) AS n FROM lot_closures c JOIN position_lots l ON l.id = c.lot_id WHERE l.account_id = $1::uuid`,
          )
        )[0]?.n,
      ),
    },
    balances,
    positions: await q(
      `SELECT instrument_id, qty, avg_cost_local, realized_trading_pnl_usd, version FROM positions WHERE account_id = $1::uuid ORDER BY instrument_id`,
    ),
    lots: await q(
      `SELECT id, qty_open, qty_initial, cost_local_per_unit, closed_at FROM position_lots WHERE account_id = $1::uuid ORDER BY opened_at, id`,
    ),
  };
}

// ---- crypto (M8) ---------------------------------------------------------------------------------------------------

/** The crypto fee schedule of migration 0027 (D-88): 10 bps commission, 5 bps base slippage, QBX-1/r8he. */
export const SCHEDULE_CRYPTO: FeeScheduleSnapshot = {
  commissionBps: '10',
  commissionMinLocal: '0',
  slippageBaseBps: '5',
  slippageSizeCoef: '0',
  modelVersion: 'QBX-1/r8he',
};

/** The id of a seeded crypto instrument (migration 0024), e.g. BTC-USD. */
export async function seededCrypto(db: TestDatabase, symbol: string): Promise<TestInstrument> {
  const r = await db.migrator.query<{ id: string }>(
    `SELECT id FROM instruments WHERE symbol = $1`,
    [symbol],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`${symbol} is not seeded`);
  return { id, symbol };
}

/** A made-up fractional instrument on the CRYPTO exchange (any tick and step), tradable in the MVP. */
export async function createFractionalInstrument(
  db: TestDatabase,
  symbol: string,
  o: { tick: string; step: string; min?: string },
): Promise<TestInstrument> {
  const id = newId();
  const exch = await db.migrator.query<{ id: string }>(
    `SELECT id FROM exchanges WHERE code = 'CRYPTO'`,
  );
  await db.migrator.query(
    `INSERT INTO instruments (id, symbol, name, asset_class, exchange_id, quote_currency, base_asset, tick_size, qty_step,
                              min_qty, fractional_ok, tradable_in, attrs)
     VALUES ($1::uuid, $2, $3, 'CRYPTO', $4::uuid, 'USD', $5, $6::numeric, $7::numeric, $8::numeric, true, '{MVP}',
             '{"source":"SYNTHETIC"}')`,
    [
      id,
      symbol,
      `${symbol} test coin`,
      exch.rows[0]?.id,
      symbol.slice(0, 4),
      o.tick,
      o.step,
      o.min ?? o.step,
    ],
  );
  return { id, symbol };
}

/**
 * A crypto command: BTC-USD-like quote bid 89,990.00 / ask 90,010.00 from the simulated feed (REAL_TIME), the crypto fee
 * schedule, tick 0.01, step and minimum 0.00000001. Everything can be overridden.
 */
export function cryptoCommand(
  accountId: string,
  inst: TestInstrument,
  o: CommandOverrides = {},
): MarketOrderCommand {
  const now = o.now ?? NOW;
  const bid = o.bid ?? '89990.00';
  const ask = o.ask ?? '90010.00';
  return command(accountId, inst, {
    freshness: 'REAL_TIME',
    feeSchedule: SCHEDULE_CRYPTO,
    ...o,
    bid,
    ask,
    quote: o.quote ?? {
      bid,
      ask,
      providerTs: new Date(now.getTime() - 1000),
      source: 'SIM',
      entitlement: 'REAL_TIME',
      delaySeconds: 0,
    },
    instrument: {
      tickSize: '0.01',
      minQty: '0.00000001',
      qtyStep: '0.00000001',
      assetClass: 'CRYPTO',
      ...o.instrument,
    },
  });
}

// ---- limit orders (M8b-1) ---------------------------------------------------------------------------------------------

export interface LimitOverrides extends CommandOverrides {
  readonly limitPrice: string;
  readonly tif?: 'DAY' | 'GTC';
  readonly expiresAt?: Date;
}

/** A LIMIT order command on a crypto-like instrument (BTC-USD defaults: bid 89,990.00 / ask 90,010.00, REAL_TIME, crypto schedule). */
export function limitCommand(
  accountId: string,
  inst: TestInstrument,
  o: LimitOverrides,
): LimitOrderCommand {
  const base = cryptoCommand(accountId, inst, o);
  return {
    orderId: base.orderId,
    accountId,
    clientOrderId: base.clientOrderId,
    instrument: base.instrument,
    side: base.side,
    qty: base.qty,
    limitPrice: o.limitPrice,
    tif: o.tif ?? 'GTC',
    expiresAt: o.expiresAt ?? new Date(base.now.getTime() + 90 * 86_400_000),
    quote: base.quote,
    freshness: base.freshness,
    feeSchedule: base.feeSchedule,
    allowExecutionOnDelayed: base.allowExecutionOnDelayed,
    tradingEnabled: base.tradingEnabled,
    now: base.now,
  };
}

/** One transaction: BEGIN, the body, COMMIT (ROLLBACK and rethrow on any error). */
export async function inTx<T>(pool: pg.Pool, body: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await body(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export const accept = (pool: pg.Pool, cmd: LimitOrderCommand, hooks?: ExecuteHooks) =>
  inTx(pool, (c) => acceptLimitOrder(c, cmd, hooks));

/** The quote of a matcher or fill call: bid and ask from the simulated feed, fresh at `now`. */
export function freshQuote(bid: string, ask: string, now: Date = NOW): QuoteSnapshot {
  return {
    bid,
    ask,
    providerTs: new Date(now.getTime() - 1000),
    source: 'SIM',
    entitlement: 'REAL_TIME',
    delaySeconds: 0,
  };
}

export const fillResting = (
  pool: pg.Pool,
  orderId: string,
  inst: TestInstrument,
  quote: QuoteSnapshot,
  o: {
    freshness?: 'REAL_TIME' | 'DELAYED' | 'STALE' | 'CLOSED' | 'UNAVAILABLE';
    now?: Date;
    tick?: string;
    feeSchedule?: FeeScheduleSnapshot;
  } = {},
  hooks?: ExecuteHooks,
) =>
  inTx(pool, (c) =>
    fillRestingOrder(
      c,
      {
        orderId,
        instrument: { id: inst.id, symbol: inst.symbol, tickSize: o.tick ?? '0.01' },
        quote,
        freshness: o.freshness ?? 'REAL_TIME',
        allowExecutionOnDelayed: true,
        feeSchedule: o.feeSchedule ?? SCHEDULE_CRYPTO,
        now: o.now ?? NOW,
      },
      hooks,
    ),
  );

export const cancel = (
  pool: pg.Pool,
  orderId: string,
  accountId: string,
  now: Date = NOW,
  hooks?: ExecuteHooks,
) => inTx(pool, (c) => cancelOrder(c, { orderId, accountId, now }, hooks));

export const expire = (pool: pg.Pool, orderId: string, now: Date, hooks?: ExecuteHooks) =>
  inTx(pool, (c) => expireOrder(c, { orderId, now }, hooks));
