// Daily equity snapshots (D-62). Written after each NYSE close from STORED data only; safe to run twice; honest after
// downtime. Time is always the injected clock's `now`, passed in by the caller.
import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type pg from 'pg';
import type { Config } from '@vantage/config';
import { summarisePortfolio, valuePosition } from '@vantage/engine';
import type { PositionValuation } from '@vantage/engine';
import { exchangeDate, freshness, nextDate, sessionsBetween } from '@vantage/market-model';
import type {
  AssetClassKind,
  InstrumentStatus,
  Quote,
  TradingSession,
} from '@vantage/market-model';
import { parse } from '@vantage/money';
import type { Logger } from '../../log.js';
import { CLOCK, CONFIG, LOGGER, POOL, QUOTE_STORE } from '../../tokens.js';
import { CandleService } from '../market-data/candles/candle.service.js';
import type { Clock } from '../../tokens.js';
import { CalendarService } from '../market-data/calendar.service.js';
import type { QuoteStore } from '../market-data/quote.store.js';

/** D-62: the snapshot day is the NYSE trading day. */
export const SNAPSHOT_EXCHANGE = 'XNYS';
/** At most this many missed sessions are written per account in one run (a bound, not a promise to backfill history). */
export const MAX_CATCH_UP_SESSIONS = 366;

export interface SnapshotRunResult {
  /** The latest NYSE session that has closed at `now`; null when none is known. */
  readonly lastClosedSession: string | null;
  readonly accountsChecked: number;
  /** Snapshot rows actually inserted (already-existing days are skipped silently). */
  readonly written: number;
  readonly incomplete: number;
}

interface AccountRow {
  id: string;
  initial_capital: string;
  created_at: Date;
  last_snapshot: string | null;
}

/** Marks written by the equity-curve catch-up (D-83): the simulated candle price at that session's close. */
export const MARK_SOURCE_SIM_CANDLE = 'SIM_CANDLE';

const classOf = (assetClass: string): AssetClassKind =>
  assetClass === 'ETF' ? 'ETF' : assetClass === 'CRYPTO' ? 'CRYPTO' : 'EQUITY';

interface HoldingRow {
  symbol: string;
  exchange: string;
  status: string;
  asset_class: string;
  qty: string;
  cash_effect: string;
}

@Injectable()
export class SnapshotService {
  constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(QUOTE_STORE) private readonly store: QuoteStore,
    @Inject(CalendarService) private readonly calendars: CalendarService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CandleService) private readonly candles: CandleService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /**
   * Writes the snapshots that are due at `now`: for every active account, each NYSE session that has closed and has
   * no snapshot yet, starting after the account's last snapshot (or, for an account with none, at the latest closed
   * session only: history before the first run is never invented). Returns what it did; running it again writes
   * nothing new.
   */
  async runDue(now: Date): Promise<SnapshotRunResult> {
    const cal = await this.calendars.get(SNAPSHOT_EXCHANGE);
    if (cal === undefined) {
      this.logger.warn('snapshot_no_calendar', { exchange: SNAPSHOT_EXCHANGE });
      return { lastClosedSession: null, accountsChecked: 0, written: 0, incomplete: 0 };
    }
    // the latest session whose close is not after `now` (search back far enough to cross any holiday run)
    const today = exchangeDate(cal, now);
    let lookback = today;
    for (let i = 0; i < 14; i += 1) lookback = prevDate(lookback);
    const closed = sessionsBetween(cal, lookback, today).filter(
      (s) => s.close.getTime() <= now.getTime(),
    );
    const latest = closed[closed.length - 1];
    if (latest === undefined) {
      return { lastClosedSession: null, accountsChecked: 0, written: 0, incomplete: 0 };
    }

    const accounts = await this.pool.query<AccountRow>(
      `SELECT a.id, a.initial_capital, a.created_at,
              (SELECT to_char(max(s.snapshot_date), 'YYYY-MM-DD') FROM equity_snapshots s WHERE s.account_id = a.id)
                AS last_snapshot
         FROM accounts a
         JOIN users u ON u.id = a.user_id
        WHERE a.status = 'ACTIVE' AND u.status = 'ACTIVE'
        ORDER BY a.id`,
    );
    let written = 0;
    let incomplete = 0;
    for (const acct of accounts.rows) {
      const from = acct.last_snapshot === null ? latest.date : nextDate(acct.last_snapshot);
      const due = sessionsBetween(cal, from, latest.date)
        .filter((s) => s.close.getTime() <= now.getTime())
        // an account that did not exist yet at the close has nothing to snapshot for that day
        .filter((s) => acct.created_at.getTime() <= s.close.getTime())
        .slice(0, MAX_CATCH_UP_SESSIONS);
      for (const session of due) {
        const r = await this.snapshotDay(acct, session, cal, now);
        if (r.inserted) written += 1;
        if (r.inserted && !r.complete) incomplete += 1;
      }
    }
    return {
      lastClosedSession: latest.date,
      accountsChecked: accounts.rows.length,
      written,
      incomplete,
    };
  }

  /**
   * One account on one trading day, as of the close: cash and quantities are rebuilt from the stored executions up
   * to the close; a mark counts only if it is a stored quote of THAT trading day (provider timestamp on the day and
   * not after the close). Nothing else is ever used as a price, in particular never a later quote for an earlier day.
   */
  private async snapshotDay(
    acct: AccountRow,
    session: TradingSession,
    cal: NonNullable<Awaited<ReturnType<CalendarService['get']>>>,
    now: Date,
  ): Promise<{ inserted: boolean; complete: boolean }> {
    const h = await this.pool.query<HoldingRow>(
      `SELECT i.symbol, x.code AS exchange, i.status::text AS status, i.asset_class::text AS asset_class,
              sum(CASE WHEN e.side = 'BUY' THEN e.qty ELSE -e.qty END) AS qty,
              sum(CASE WHEN e.side = 'BUY' THEN -(e.gross_usd + e.fee_usd) ELSE e.gross_usd - e.fee_usd END)
                AS cash_effect
         FROM executions e
         JOIN instruments i ON i.id = e.instrument_id
         JOIN exchanges x ON x.id = i.exchange_id
        WHERE e.account_id = $1::uuid AND e.executed_at <= $2::timestamptz
        GROUP BY i.symbol, x.code, i.status, i.asset_class`,
      [acct.id, session.close],
    );
    let cash = parse(acct.initial_capital);
    const valuations: PositionValuation[] = [];
    let candleMarks = 0;
    for (const row of h.rows) {
      cash = cash.add(parse(row.cash_effect));
      if (parse(row.qty).sign() <= 0) continue; // closed out by this day
      // D-83: with the simulated source, the mark of a past day is the candle price at THAT session's close (a pure
      // function of the seed and the instant: it can never be a later price). Any other source keeps the M5 rule below.
      const candlePrice =
        this.config.marketDataSource === 'SIM'
          ? await this.candles.priceAt(
              { symbol: row.symbol, exchange: row.exchange, assetClass: row.asset_class },
              session.close,
            )
          : null;
      if (candlePrice !== null) {
        const asQuote: Quote = {
          symbol: row.symbol,
          bid: candlePrice,
          ask: candlePrice,
          last: candlePrice,
          providerTs: session.close,
          receivedAt: session.close,
          source: 'SIM',
          entitlement: 'REAL_TIME',
          delaySeconds: 0,
        };
        const fc = freshness(
          asQuote,
          row.status as InstrumentStatus,
          { state: 'CLOSED' },
          session.close,
          { assetClass: classOf(row.asset_class) },
        );
        valuations.push(
          valuePosition({
            symbol: row.symbol,
            qty: row.qty,
            costBasis: '0',
            // a candle price is a last/mid price, not a bid: it is marked as LAST
            quote: { bid: null, last: candlePrice, providerTs: session.close, source: 'SIM' },
            freshness: fc.state,
          }),
        );
        candleMarks += 1;
        continue;
      }
      const stored = (await this.store.get(row.symbol.toUpperCase()))?.lastAccepted ?? null;
      const usable =
        stored !== null &&
        stored.providerTs.getTime() <= session.close.getTime() &&
        exchangeDate(cal, stored.providerTs) === session.date
          ? stored
          : null;
      // freshness from the shared function, evaluated at the close, when the market is closed
      const f = freshness(
        usable,
        row.status as InstrumentStatus,
        { state: 'CLOSED' },
        session.close,
        {
          assetClass: classOf(row.asset_class),
        },
      );
      valuations.push(
        valuePosition({
          symbol: row.symbol,
          qty: row.qty,
          costBasis: '0', // cost is not part of a snapshot
          quote:
            usable === null
              ? null
              : {
                  bid: usable.bid,
                  last: usable.last ?? null,
                  providerTs: usable.providerTs,
                  source: usable.source,
                },
          freshness: f.state,
        }),
      );
    }
    const s = summarisePortfolio({
      cash: cash.toString(),
      positions: valuations,
      realisedPnl: '0',
      fees: '0',
      initialCapital: acct.initial_capital,
    });
    const r = await this.pool.query(
      `INSERT INTO equity_snapshots (account_id, snapshot_date, cash, positions_value, equity, valued_complete,
                                     quote_asof, created_at, mark_source)
       VALUES ($1::uuid, $2::date, $3::numeric, $4::numeric, $5::numeric, $6, $7, $8, $9)
       ON CONFLICT (account_id, snapshot_date) DO NOTHING`,
      [
        acct.id,
        session.date,
        s.cash,
        s.positionsValue,
        s.equity,
        !s.incomplete,
        s.oldestQuoteAsOf,
        now,
        // SIM_CANDLE only when every valued position was marked from a candle; stored quotes (M5) or no marks: null
        candleMarks > 0 && candleMarks === valuations.length ? MARK_SOURCE_SIM_CANDLE : null,
      ],
    );
    return { inserted: (r.rowCount ?? 0) > 0, complete: !s.incomplete };
  }
}

function prevDate(date: string): string {
  const [y, m, d] = date.split('-').map((p) => parseInt(p, 10)) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

const TICK_MS = 60_000;

/**
 * Runs the snapshot job inside the API process (no new infrastructure): one tick a minute with the injected clock.
 * It does not start when APP_ENV is test (tests call `runDue` with their own clock).
 */
@Injectable()
export class SnapshotScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.appEnv === 'test') return;
    this.#timer = setInterval(() => void this.tick(), TICK_MS);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /** One scheduled run. Never overlaps itself and never throws (a failed run is logged and retried next tick). */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const r = await this.snapshots.runDue(this.clock.now());
      if (r.written > 0) {
        this.logger.info('equity_snapshots_written', {
          session: r.lastClosedSession ?? undefined,
          written: r.written,
          incomplete: r.incomplete,
        });
      }
    } catch (e) {
      const err = e as { name?: unknown; code?: unknown };
      this.logger.error('equity_snapshot_failed', {
        errorName: typeof err.name === 'string' ? err.name : 'unknown',
        errorCode: typeof err.code === 'string' ? err.code : undefined,
      });
    } finally {
      this.#running = false;
    }
  }
}
