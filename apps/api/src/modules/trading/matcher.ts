// The limit-order matcher (M8b-1, D-95). `runMatcherOnce(deps, now)` is a PLAIN FUNCTION that tests call directly with an
// injected quote source and clock; the Nest service in matcher.service.ts is a thin timer around it.
//
// One tick: (1) try the Postgres advisory lock: if another process holds it, skip the tick (correctness does NOT depend on it:
// the row locks and the guarded transitions of limit-orders.ts are the real protection); (2) expire the orders whose expiry has
// passed (each in its own transaction, releasing exactly the stored reservation); (3) for every instrument with open orders take
// the CURRENT eligible quote from the same validation the order pipeline uses (QuoteService.snapshotFor): a STALE, CLOSED or
// UNAVAILABLE quote is not evaluated, and when a quote returns only the NEW quote is looked at (no back-filling); evaluate the
// open orders in created_at, id order, at most one fill per order; fill each in its OWN transaction. A failure of one order is
// logged and the others continue; a failure never leaves money half-moved because each fill is one transaction.
import type pg from 'pg';
import { evaluateOpenOrders } from '@vantage/engine';
import type { FreshnessState, InstrumentStatus, Quote } from '@vantage/market-model';
import type { Logger } from '../../log.js';
import { loadInstrumentContext } from './instrument-context.js';
import { expireOrder, fillRestingOrder } from './limit-orders.js';
import type { ExecuteHooks, QuoteSnapshot } from './execute-market-order.js';

/** What the matcher needs from the quote service. */
export interface QuoteSource {
  snapshotFor(
    instrument: { symbol: string; exchange: string; status: InstrumentStatus; assetClass: string },
    now: Date,
  ): Promise<{ readonly freshness: FreshnessState; readonly quote: Quote | null }>;
}

export interface MatcherDeps {
  readonly pool: pg.Pool;
  readonly quotes: QuoteSource;
  readonly logger: Logger;
  /** D-09: execution against DELAYED quotes (default true, the MVP setting). */
  readonly allowExecutionOnDelayed?: boolean;
  /** Test seam, applied to every fill, cancel-free step of the tick: throw from afterLedgerPost to prove atomicity. */
  readonly hooks?: ExecuteHooks;
  /** Test seam: runs before each per-order step (expiry or fill) of the tick. Throw to simulate that order failing. */
  readonly beforeOrder?: (orderId: string) => void | Promise<void>;
  /** false skips the advisory lock (tests that prove correctness without it). Default true. */
  readonly useAdvisoryLock?: boolean;
  /** At most this many expired orders per tick (the rest next tick). */
  readonly expiryBatch?: number;
}

export interface MatcherResult {
  /** true when another process held the advisory lock and this tick did nothing. */
  readonly skippedByLock: boolean;
  readonly expired: number;
  readonly instruments: number;
  /** Instruments whose quote was not evaluable (stale, closed, unavailable). */
  readonly notEvaluable: number;
  readonly evaluated: number;
  readonly filled: number;
  readonly errors: number;
}

/** One key for the whole matcher (distinct from the migrator's lock). */
export const MATCHER_LOCK_KEY = '7241865325823965';

const EMPTY: MatcherResult = {
  skippedByLock: false,
  expired: 0,
  instruments: 0,
  notEvaluable: 0,
  evaluated: 0,
  filled: 0,
  errors: 0,
};

async function withTx<T>(pool: pg.Pool, body: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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

const toSnapshot = (q: Quote): QuoteSnapshot => ({
  bid: q.bid,
  ask: q.ask,
  ...(q.last === undefined ? {} : { last: q.last }),
  providerTs: q.providerTs,
  source: q.source,
  entitlement: q.entitlement,
  delaySeconds: q.delaySeconds,
});

export async function runMatcherOnce(deps: MatcherDeps, now: Date): Promise<MatcherResult> {
  const { pool, logger } = deps;
  const allowDelayed = deps.allowExecutionOnDelayed ?? true;
  let lockClient: pg.PoolClient | undefined;
  if (deps.useAdvisoryLock !== false) {
    lockClient = await pool.connect();
    try {
      const got = await lockClient.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [MATCHER_LOCK_KEY],
      );
      if (got.rows[0]?.ok !== true) {
        lockClient.release();
        return { ...EMPTY, skippedByLock: true };
      }
    } catch (e) {
      lockClient.release();
      throw e;
    }
  }
  const out = { ...EMPTY } as { -readonly [K in keyof MatcherResult]: MatcherResult[K] };
  try {
    // ---- 2. expiry -------------------------------------------------------------------------------------------------------------
    const due = await pool.query<{ id: string }>(
      `SELECT id FROM orders WHERE status = 'ACCEPTED' AND expires_at IS NOT NULL AND expires_at <= $1::timestamptz
        ORDER BY expires_at, id LIMIT $2::int`,
      [now, deps.expiryBatch ?? 500],
    );
    for (const row of due.rows) {
      try {
        await deps.beforeOrder?.(row.id);
        const r = await withTx(pool, (c) => expireOrder(c, { orderId: row.id, now }, deps.hooks));
        if (r.outcome === 'EXPIRED') out.expired += 1;
      } catch (e) {
        out.errors += 1;
        logger.error('matcher_expire_failed', { orderId: row.id, error: (e as Error).message });
      }
    }

    // ---- 3. evaluate the open orders of every instrument with a usable quote ----------------------------------------------------
    const instruments = await pool.query<{ instrument_id: string }>(
      `SELECT DISTINCT instrument_id FROM orders WHERE status = 'ACCEPTED' AND type = 'LIMIT' ORDER BY instrument_id`,
    );
    for (const inst of instruments.rows) {
      out.instruments += 1;
      try {
        const ctx = await loadInstrumentContext(pool, { id: inst.instrument_id }, now);
        if (ctx === undefined) continue;
        const snap = await deps.quotes.snapshotFor(
          {
            symbol: ctx.instrument.symbol,
            exchange: ctx.instrument.exchange,
            status: ctx.instrument.status,
            assetClass: ctx.instrument.assetClass,
          },
          now,
        );
        if (
          snap.quote === null ||
          (snap.freshness !== 'REAL_TIME' && !(snap.freshness === 'DELAYED' && allowDelayed))
        ) {
          out.notEvaluable += 1; // STALE, CLOSED, UNAVAILABLE: the orders rest, nothing is evaluated (TRADING_ENGINE section 3)
          continue;
        }
        const open = await pool.query<{
          id: string;
          side: 'BUY' | 'SELL';
          qty: string;
          limit_price: string;
          reserved_usd: string;
          created_at: Date;
        }>(
          `SELECT id, side::text AS side, qty, limit_price, reserved_usd, created_at FROM orders
            WHERE instrument_id = $1::uuid AND status = 'ACCEPTED' AND type = 'LIMIT' ORDER BY created_at, id`,
          [inst.instrument_id],
        );
        out.evaluated += open.rows.length;
        const ev = evaluateOpenOrders(
          { bid: snap.quote.bid, ask: snap.quote.ask },
          snap.freshness,
          allowDelayed,
          open.rows.map((o) => ({
            id: o.id,
            createdAt: o.created_at,
            side: o.side,
            qty: o.qty,
            limitPrice: o.limit_price,
            reservedUsd: o.reserved_usd,
          })),
          ctx.feeSchedule,
          ctx.instrument.tickSize,
        );
        for (const id of ev.refused)
          logger.error('matcher_fill_refused', {
            orderId: id,
            reason: 'fill would exceed the reserve',
          });
        const quote = toSnapshot(snap.quote);
        for (const f of ev.fills) {
          try {
            await deps.beforeOrder?.(f.orderId);
            const r = await withTx(pool, (c) =>
              fillRestingOrder(
                c,
                {
                  orderId: f.orderId,
                  instrument: {
                    id: ctx.instrument.id,
                    symbol: ctx.instrument.symbol,
                    tickSize: ctx.instrument.tickSize,
                  },
                  quote,
                  freshness: snap.freshness,
                  allowExecutionOnDelayed: allowDelayed,
                  feeSchedule: ctx.feeSchedule,
                  now,
                },
                deps.hooks,
              ),
            );
            if (r.outcome === 'FILLED') out.filled += 1;
            else if (r.outcome === 'EXPIRED') out.expired += 1;
          } catch (e) {
            out.errors += 1;
            logger.error('matcher_fill_failed', {
              orderId: f.orderId,
              error: (e as Error).message,
            });
          }
        }
      } catch (e) {
        out.errors += 1;
        logger.error('matcher_instrument_failed', {
          instrumentId: inst.instrument_id,
          error: (e as Error).message,
        });
      }
    }
    return out;
  } finally {
    if (lockClient !== undefined) {
      await lockClient
        .query(`SELECT pg_advisory_unlock($1::bigint)`, [MATCHER_LOCK_KEY])
        .catch(() => undefined);
      lockClient.release();
    }
  }
}
