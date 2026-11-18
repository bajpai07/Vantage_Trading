import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { HISTORY_MAX_ROWS, PortfolioHistoryResponse, PortfolioResponse } from '@vantage/contracts';
import type { PortfolioHistoryQuery, PortfolioPosition } from '@vantage/contracts';
import { roundDisplay, summarisePortfolio, valuePosition } from '@vantage/engine';
import type { PositionValuation } from '@vantage/engine';
import { parse } from '@vantage/money';
import { AppError } from '../../common/errors.js';
import { CLOCK, POOL } from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { QuoteService } from '../market-data/quote.service.js';

const canonical = (v: string): string => parse(v).toCanonicalString();
const display = (v: string): string => roundDisplay(v);
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

interface PositionRow {
  symbol: string;
  status: string;
  asset_class: string;
  exchange: string;
  qty: string;
  avg_cost_local: string;
  cost_basis: string;
}

/** Everything one portfolio answer needs, read in ONE consistent snapshot (D-63). */
export interface PortfolioSnapshotData {
  readonly initialCapital: string;
  readonly cash: string;
  readonly fees: string;
  /** Minus the REALIZED_PNL ledger balance. */
  readonly realisedPnl: string;
  readonly positions: readonly PositionRow[];
}

@Injectable()
export class PortfolioService {
  constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(QuoteService) private readonly quotes: QuoteService,
  ) {}

  /**
   * Reads cash, the ledger totals, positions and lot cost bases inside a single REPEATABLE READ, READ ONLY
   * transaction, so a concurrent order can never make cash and the lots disagree inside one response (D-63).
   */
  async readSnapshot(userId: string): Promise<PortfolioSnapshotData> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const a = await client.query<{
        id: string;
        initial_capital: string;
        cash: string | null;
        fees: string | null;
        realised: string | null;
      }>(
        `SELECT a.id, a.initial_capital,
                MAX(la.balance) FILTER (WHERE la.type = 'CASH')          AS cash,
                MAX(la.balance) FILTER (WHERE la.type = 'FEES')          AS fees,
                -MAX(la.balance) FILTER (WHERE la.type = 'REALIZED_PNL') AS realised
           FROM accounts a
           LEFT JOIN ledger_accounts la ON la.account_id = a.id AND la.currency = 'USD'
          WHERE a.user_id = $1::uuid AND a.kind = 'MAIN'
          GROUP BY a.id, a.initial_capital`,
        [userId],
      );
      const acct = a.rows[0];
      if (acct === undefined) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
      const p = await client.query<PositionRow>(
        `SELECT i.symbol, i.status::text AS status, i.asset_class::text AS asset_class, e.code AS exchange,
                p.qty, p.avg_cost_local, COALESCE(l.cost, 0) AS cost_basis
           FROM positions p
           JOIN instruments i ON i.id = p.instrument_id
           JOIN exchanges e ON e.id = i.exchange_id
           LEFT JOIN (SELECT instrument_id, sum(cost_remaining) AS cost
                        FROM position_lots WHERE account_id = $1::uuid AND qty_open > 0
                       GROUP BY instrument_id) l ON l.instrument_id = p.instrument_id
          WHERE p.account_id = $1::uuid AND p.qty > 0
          ORDER BY i.symbol`,
        [acct.id],
      );
      await client.query('COMMIT');
      return {
        initialCapital: acct.initial_capital,
        cash: acct.cash ?? '0',
        fees: acct.fees ?? '0',
        realisedPnl: acct.realised ?? '0',
        positions: p.rows,
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** GET /v1/portfolio. Marks are read after the snapshot from the quote store, with the shared freshness. */
  async portfolio(userId: string): Promise<PortfolioResponse> {
    const data = await this.readSnapshot(userId);
    const now = this.clock.now();

    const valuations: PositionValuation[] = [];
    for (const row of data.positions) {
      const snap = await this.quotes.snapshotFor(
        {
          symbol: row.symbol,
          exchange: row.exchange,
          status: row.status,
          assetClass: row.asset_class,
        },
        now,
      );
      valuations.push(
        valuePosition({
          symbol: row.symbol,
          qty: row.qty,
          costBasis: row.cost_basis,
          quote:
            snap.quote === null
              ? null
              : {
                  bid: snap.quote.bid,
                  last: snap.quote.last ?? null,
                  providerTs: snap.quote.providerTs,
                  source: snap.quote.source,
                },
          freshness: snap.freshness,
        }),
      );
    }
    const s = summarisePortfolio({
      cash: data.cash,
      positions: valuations,
      realisedPnl: data.realisedPnl,
      fees: data.fees,
      initialCapital: data.initialCapital,
    });

    const positions: PortfolioPosition[] = valuations.map((v, i) => {
      const row = data.positions[i];
      const avg = canonical(row?.avg_cost_local ?? '0');
      if (v.valuation === 'VALUED') {
        return {
          symbol: v.symbol,
          qty: parse(v.qty).toString(),
          avgCost: avg,
          costBasis: display(v.costBasis),
          valuation: 'VALUED',
          unavailableReason: null,
          mark: canonical(v.mark),
          markBasis: v.markBasis,
          marketValue: display(v.marketValue),
          unrealisedPnl: display(v.unrealisedPnl),
          quote: { freshness: v.freshness, asOf: v.quoteAsOf.toISOString(), source: v.source },
          exact: {
            costBasis: canonical(v.costBasis),
            marketValue: canonical(v.marketValue),
            unrealisedPnl: canonical(v.unrealisedPnl),
          },
        };
      }
      return {
        symbol: v.symbol,
        qty: parse(v.qty).toString(),
        avgCost: avg,
        costBasis: display(v.costBasis),
        valuation: 'UNAVAILABLE',
        unavailableReason: v.reason,
        mark: null,
        markBasis: null,
        marketValue: null,
        unrealisedPnl: null,
        quote: { freshness: v.freshness, asOf: null, source: null },
        exact: { costBasis: canonical(v.costBasis), marketValue: null, unrealisedPnl: null },
      };
    });

    const totals = {
      cash: s.cash,
      positionsValue: s.positionsValue,
      costBasis: s.costBasis,
      unrealisedPnl: s.unrealisedPnl,
      realisedPnl: s.realisedPnl,
      fees: s.fees,
      equity: s.equity,
    };
    const rounded = Object.fromEntries(
      Object.entries(totals).map(([k, v]) => [k, display(v)]),
    ) as typeof totals;
    const exact = Object.fromEntries(
      Object.entries(totals).map(([k, v]) => [k, canonical(v)]),
    ) as typeof totals;
    return PortfolioResponse.parse({
      currency: 'USD',
      ...rounded,
      initialCapital: display(data.initialCapital),
      totalReturn: s.totalReturn === null ? null : display(s.totalReturn),
      incomplete: s.incomplete,
      unvaluedCount: s.unvaluedCount,
      positions,
      asOf: iso(s.oldestQuoteAsOf),
      generatedAt: now.toISOString(),
      exact: { ...exact, totalReturn: s.totalReturn === null ? null : canonical(s.totalReturn) },
    });
  }

  /** GET /v1/portfolio/history: the caller's snapshots in a bounded date range, oldest first, at most 366 rows. */
  async history(userId: string, q: PortfolioHistoryQuery): Promise<PortfolioHistoryResponse> {
    const today = this.clock.now().toISOString().slice(0, 10);
    const to = q.to ?? today;
    const from =
      q.from ??
      new Date(Date.parse(to) - (HISTORY_MAX_ROWS - 1) * 86_400_000).toISOString().slice(0, 10);
    const r = await this.pool.query<{
      snapshot_date: string;
      cash: string;
      positions_value: string;
      equity: string;
      valued_complete: boolean;
      quote_asof: Date | null;
      mark_source: string | null;
    }>(
      `SELECT to_char(s.snapshot_date, 'YYYY-MM-DD') AS snapshot_date, s.cash, s.positions_value, s.equity,
              s.valued_complete, s.quote_asof, s.mark_source
         FROM equity_snapshots s
         JOIN accounts a ON a.id = s.account_id
        WHERE a.user_id = $1::uuid AND a.kind = 'MAIN'
          AND s.snapshot_date BETWEEN $2::date AND $3::date
        ORDER BY s.snapshot_date ASC
        LIMIT $4::int`,
      [userId, from, to, HISTORY_MAX_ROWS],
    );
    return PortfolioHistoryResponse.parse({
      snapshots: r.rows.map((x) => ({
        date: x.snapshot_date,
        cash: display(x.cash),
        positionsValue: display(x.positions_value),
        equity: display(x.equity),
        valuedComplete: x.valued_complete,
        quoteAsOf: iso(x.quote_asof),
        markSource: x.mark_source,
        exact: {
          cash: canonical(x.cash),
          positionsValue: canonical(x.positions_value),
          equity: canonical(x.equity),
        },
      })),
    });
  }
}
