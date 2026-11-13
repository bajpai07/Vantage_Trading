import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { ListActivityResponse, ListExecutionsResponse, PAGE } from '@vantage/contracts';
import type { ListActivityQuery, ListExecutionsQuery } from '@vantage/contracts';
import { roundDisplay } from '@vantage/engine';
import { parse } from '@vantage/money';
import { cursorTimeSql, decodeCursor, encodeCursor } from '../../common/cursor.js';
import { POOL } from '../../tokens.js';

const canonical = (v: string): string => parse(v).toCanonicalString();
const canonicalOrNull = (v: string | null): string | null => (v === null ? null : canonical(v));
const plain = (v: string): string => parse(v).toString();

/** Plain-language labels for the ledger transaction kinds. */
const TITLES: Readonly<Record<string, string>> = {
  GRANT: 'Starting capital',
  COMPETITION_GRANT: 'Competition capital',
  FILL: 'Trade',
  FEE: 'Fee',
  ORDER_RESERVE: 'Funds reserved for an order',
  ORDER_RELEASE: 'Reserved funds released',
  CORPORATE_ACTION: 'Corporate action',
  ADJUSTMENT: 'Adjustment',
};

interface ExecutionRow {
  id: string;
  order_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: string;
  price: string;
  gross_usd: string;
  fee_local: string;
  slippage_bps: string;
  executed_at: Date;
  ckey: string;
  quote_bid: string | null;
  quote_ask: string | null;
  quote_last: string | null;
  quote_ts: Date;
  quote_source: string;
  quote_entitlement: 'REAL_TIME' | 'DELAYED';
  realised: string | null;
}

interface ActivityRow {
  id: string;
  kind: string;
  description: string | null;
  created_at: Date;
  ckey: string;
  order_id: string | null;
  cash_effect: string;
}

/** Paginated history of the caller's own executions and ledger activity. Every query is scoped by user id. */
@Injectable()
export class HistoryService {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  async executions(userId: string, q: ListExecutionsQuery): Promise<ListExecutionsResponse> {
    const limit = q.limit ?? PAGE.defaultLimit;
    const cur = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
    // Realised P&L of a SELL = the trading P&L of the lot closures it caused (one correlated lookup, indexed).
    const r = await this.pool.query<ExecutionRow>(
      `SELECT e.id, e.order_id, i.symbol, e.side::text AS side, e.qty, e.price, e.gross_usd, e.fee_local,
              e.slippage_bps, e.executed_at, ${cursorTimeSql('e.executed_at')} AS ckey,
              e.quote_bid, e.quote_ask, e.quote_last, e.quote_ts, e.quote_source,
              e.quote_entitlement::text AS quote_entitlement,
              CASE WHEN e.side = 'SELL'
                   THEN (SELECT sum(c.trading_pnl_usd) FROM lot_closures c WHERE c.close_execution_id = e.id)
              END AS realised
         FROM executions e
         JOIN accounts a ON a.id = e.account_id
         JOIN instruments i ON i.id = e.instrument_id
        WHERE a.user_id = $1::uuid AND a.kind = 'MAIN'
          AND ($2::text IS NULL OR upper(i.symbol) = $2::text)
          AND ($3::timestamptz IS NULL OR (e.executed_at, e.id) < ($3::timestamptz, $4::uuid))
        ORDER BY e.executed_at DESC, e.id DESC
        LIMIT $5::int`,
      [userId, q.symbol ?? null, cur?.t ?? null, cur?.id ?? null, limit + 1],
    );
    const page = r.rows.slice(0, limit);
    const last = page[page.length - 1];
    return ListExecutionsResponse.parse({
      executions: page.map((x) => ({
        id: x.id,
        orderId: x.order_id,
        symbol: x.symbol,
        side: x.side,
        qty: plain(x.qty),
        price: canonical(x.price),
        notional: roundDisplay(x.gross_usd),
        fee: roundDisplay(x.fee_local),
        slippageBps: plain(x.slippage_bps),
        executedAt: x.executed_at.toISOString(),
        quote: {
          bid: canonicalOrNull(x.quote_bid),
          ask: canonicalOrNull(x.quote_ask),
          last: canonicalOrNull(x.quote_last),
          asOf: x.quote_ts.toISOString(),
          source: x.quote_source,
          entitlement: x.quote_entitlement,
        },
        realisedPnl: x.realised === null ? null : roundDisplay(x.realised),
        exact: {
          notional: canonical(x.gross_usd),
          fee: canonical(x.fee_local),
          realisedPnl: canonicalOrNull(x.realised),
        },
      })),
      nextCursor:
        r.rows.length > limit && last !== undefined
          ? encodeCursor({ t: last.ckey, id: last.id })
          : null,
    });
  }

  /** The caller's own ledger transactions in plain language. No ledger account ids are returned. */
  async activity(userId: string, q: ListActivityQuery): Promise<ListActivityResponse> {
    const limit = q.limit ?? PAGE.defaultLimit;
    const cur = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
    const r = await this.pool.query<ActivityRow>(
      `WITH page AS (
         SELECT t.id, t.kind::text AS kind, t.description, t.created_at, t.order_id,
                ${cursorTimeSql('t.created_at')} AS ckey
           FROM ledger_transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE a.user_id = $1::uuid AND a.kind = 'MAIN'
            AND ($2::timestamptz IS NULL OR (t.created_at, t.id) < ($2::timestamptz, $3::uuid))
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT $4::int)
       SELECT p.*, COALESCE((SELECT sum(en.amount)
                               FROM ledger_entries en
                               JOIN ledger_accounts la ON la.id = en.ledger_account_id
                              WHERE en.transaction_id = p.id AND la.type = 'CASH' AND en.currency = 'USD'), 0)
                   AS cash_effect
         FROM page p
        ORDER BY p.created_at DESC, p.id DESC`,
      [userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
    );
    const page = r.rows.slice(0, limit);
    const last = page[page.length - 1];
    return ListActivityResponse.parse({
      activity: page.map((x) => ({
        id: x.id,
        kind: x.kind,
        title: TITLES[x.kind] ?? x.kind,
        description: x.description,
        createdAt: x.created_at.toISOString(),
        cashEffect: roundDisplay(x.cash_effect),
        orderId: x.order_id,
        exact: { cashEffect: canonical(x.cash_effect) },
      })),
      nextCursor:
        r.rows.length > limit && last !== undefined
          ? encodeCursor({ t: last.ckey, id: last.id })
          : null,
    });
  }
}
