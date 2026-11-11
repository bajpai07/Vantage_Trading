import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { marketState, parseCalendar } from '@vantage/market-model';
import type { Calendar, MarketState } from '@vantage/market-model';
import { POOL } from '../../tokens.js';

export interface ExchangeStatus extends MarketState {
  readonly exchange: string;
  readonly name: string;
}

/**
 * Exchange calendars (D-47): the source of truth is exchanges.calendar. Each is parsed and validated with
 * Zod when loaded, so a bad calendar stops the app at startup instead of answering wrongly later.
 */
@Injectable()
export class CalendarService {
  #calendars: Map<string, { name: string; calendar: Calendar }> | undefined;

  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  /** Loads and validates every exchange calendar. Throws CalendarError naming the exchange. */
  async load(): Promise<void> {
    const r = await this.pool.query<{ code: string; name: string; calendar: unknown }>(
      'SELECT code, name, calendar FROM exchanges ORDER BY code',
    );
    const map = new Map<string, { name: string; calendar: Calendar }>();
    for (const row of r.rows) {
      try {
        map.set(row.code, { name: row.name, calendar: parseCalendar(row.calendar) });
      } catch (e) {
        throw new Error(
          `exchange ${row.code}: ${e instanceof Error ? e.message : 'invalid calendar'}`,
          { cause: e },
        );
      }
    }
    this.#calendars = map;
  }

  async #loaded(): Promise<Map<string, { name: string; calendar: Calendar }>> {
    if (this.#calendars === undefined) await this.load();
    return this.#calendars as Map<string, { name: string; calendar: Calendar }>;
  }

  /** State of one exchange at an instant; undefined for an unknown exchange code. */
  async stateFor(mic: string, now: Date): Promise<MarketState | undefined> {
    const entry = (await this.#loaded()).get(mic);
    return entry === undefined ? undefined : marketState(entry.calendar, now);
  }

  async statusAll(now: Date): Promise<ExchangeStatus[]> {
    return [...(await this.#loaded()).entries()].map(([code, e]) => ({
      exchange: code,
      name: e.name,
      ...marketState(e.calendar, now),
    }));
  }
}
