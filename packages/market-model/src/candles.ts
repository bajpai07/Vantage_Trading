// OHLCV candles for the simulated feed (M7b, D-79 to D-82). PURE: a function of (seed, symbol, interval, range, now,
// sessions) and nothing else: no clock (`now` is an argument), no randomness, no IO, no floats. Candles are computed on
// demand from the pure SIM price function (sim.ts); nothing is stored.
//
// THE MODEL (also in docs/market-data.md):
//
//  * Intervals 1m, 5m, 15m, 1h, 4h, 1d. A candle covers [t, t + interval) in UTC, aligned to the interval; the 1d candle is
//    aligned to the UTC day for continuous markets (crypto, and stocks in the simulated 24/7 session) and is the whole
//    regular session for stocks on the real calendar (t = the session open).
//  * Sessions: crypto and the 24/7 session are continuous. On the real calendar there are candles only inside regular
//    sessions (early closes respected; none on weekends or holidays; DST handled by the calendar). A candle that straddles
//    a session edge is CLIPPED to the session: it keeps its aligned open time t, but its prices are read at the clipped
//    first and last instants.
//  * Prices. Let s and e be the first and last instants of a candle (after clipping): e = t + interval, or the session
//    close. open = P(s) and close = P(e), where P is the SIM price at that second. The close of one candle is therefore
//    exactly the open of the next (the next candle's first instant IS e), so consecutive candles are contiguous:
//    open(n+1) = close(n). (Between two sessions there is a gap, by design.) high and low are the max and min of P over
//    the SAMPLE GRID: the instants s, e and every multiple of the grid step strictly between them. The grid step is 60
//    seconds for intervals up to 1h and 300 seconds for 4h and 1d.
//  * Aggregation is EXACT up to 1h: a 5m, 15m or 1h candle has the open of its first and the close of its last 1m
//    candle, the max high, the min low and the exact sum of volumes (all grids are the same 60 s grid). For 4h and 1d
//    the grid is coarser (300 s, a subset of the 60 s grid), so the guaranteed invariant is weaker: open and close are
//    still exact, volume is still the exact sum, and high <= the aggregated high and low >= the aggregated low of the
//    finer candles that cover it (a coarse candle can miss an extreme between two grid points, never invent one).
//  * Volume is SYNTHETIC (a pure function of seed, symbol and time) and says so. Per minute: an hourly level (60 to 140
//    percent of the symbol's base, from a hash) plus a small periodic ripple; the volume of any range of whole minutes is
//    the exact sum, computed in O(hours), so it aggregates exactly at every interval. Integer shares for stocks, 8
//    decimal places for crypto.
//  * Forming candle: the candle that contains `now` is included with closed = false, its close is P(now) and its high,
//    low and volume cover the instants and whole minutes up to now. Every earlier candle is closed and depends on
//    nothing but its own inputs: the same bytes at any later `now`.
//  * COST: a request makes at most MAX_CANDLES * (interval / grid + 1) price evaluations, repeated boundaries counted once
//    (at most 144,500 for 500 daily candles of a 24/7 market, 2,500 for 500 candles of 5m...). See `maxEvaluations`.
import { parse, sub } from '@vantage/money';
import { exchangeDate, sessionsBetween } from './calendar.js';
import type { Calendar, TradingSession } from './calendar.js';
import { hash4, hashText, simMidUnits, unitsToString } from './sim.js';
import type { SimSymbolConfig } from './sim.js';

export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const CANDLE_INTERVAL_SECONDS: Readonly<Record<CandleInterval, number>> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

/** The most candles one request returns. */
export const MAX_CANDLES = 500;
export const FINE_GRID_SECONDS = 60;
export const COARSE_GRID_SECONDS = 300;

/** The sample grid step of an interval (D-80). */
export const gridSecondsFor = (interval: CandleInterval): number =>
  interval === '4h' || interval === '1d' ? COARSE_GRID_SECONDS : FINE_GRID_SECONDS;

/**
 * There is no simulated history before this instant (2026-01-01T00:00:00Z, the start of the calendar data): no candle
 * starts before it and no prior close is defined for a time before it (never a made-up number, never 0).
 */
export const SIM_HISTORY_START_SECONDS = 1767225600;

/** Upper bound of price evaluations for one request: candles x (interval / grid + 1). */
export function maxEvaluations(interval: CandleInterval, candles: number = MAX_CANDLES): number {
  return candles * (CANDLE_INTERVAL_SECONDS[interval] / gridSecondsFor(interval) + 1);
}

export interface CandleInstrument extends SimSymbolConfig {
  /** Synthetic volume: the base per minute, in the smallest volume unit (shares for stocks, 1e-8 for crypto). */
  readonly volumeUnitsPerMinute: number;
  /** Decimal places of the volume string: 0 for stocks, 8 for crypto. */
  readonly volumeDp: number;
}

export type CandleSessions =
  { readonly kind: 'CONTINUOUS' } | { readonly kind: 'CALENDAR'; readonly calendar: Calendar };

export interface Candle {
  /** Open time, epoch seconds (UTC). */
  readonly t: number;
  readonly o: string;
  readonly h: string;
  readonly l: string;
  readonly c: string;
  /** Synthetic volume. */
  readonly v: string;
  /** false only for the candle that contains `now` (still forming). */
  readonly closed: boolean;
}

export interface BuildCandlesInput {
  readonly seed: string;
  readonly instrument: CandleInstrument;
  readonly interval: CandleInterval;
  /** Inclusive lower bound on a candle's first instant (epoch seconds); null = as far back as there is history. */
  readonly from: number | null;
  /** Inclusive upper bound on a candle's first instant; null = now. Nothing after `now` is ever produced. */
  readonly to: number | null;
  /** 1 to MAX_CANDLES. When more candles match, the newest `limit` are returned and `truncated` is true. */
  readonly limit: number;
  /** The current instant (epoch seconds, from the injected clock). */
  readonly now: number;
  readonly sessions: CandleSessions;
  /** The overnight gap of the NYSE session mode (see sim.ts); false in the 24/7 session and for crypto. */
  readonly gaps: boolean;
}

export interface BuildCandlesResult {
  /** Ascending by open time. */
  readonly candles: Candle[];
  readonly truncated: boolean;
  /** Distinct price evaluations this call made (the bounded cost, see maxEvaluations). */
  readonly evaluations: number;
}

interface Segment {
  /** Reported open time. */
  readonly t: number;
  /** First and last instants after clipping to the session. */
  readonly start: number;
  readonly end: number;
}

const DAY = 86400;
const previousDate = (date: string): string => {
  const [y, m, d] = date.split('-').map((p) => parseInt(p, 10)) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};
const dateMinus = (date: string, days: number): string => {
  let out = date;
  for (let i = 0; i < days; i += 1) out = previousDate(out);
  return out;
};
const secondsOf = (d: Date): number => Math.floor(d.getTime() / 1000);

// ---- segments (which candles exist) ----------------------------------------------------------------------------------

/** Continuous markets: aligned buckets, newest first, at most `need`. */
function continuousSegments(
  interval: number,
  lower: number,
  upper: number,
  need: number,
): Segment[] {
  const out: Segment[] = [];
  let start = Math.floor(upper / interval) * interval;
  while (start >= lower && out.length < need) {
    out.push({ t: start, start, end: start + interval });
    start -= interval;
  }
  return out;
}

/** The candles of one session, oldest first (1d: the whole session; shorter: aligned buckets clipped to it). */
function sessionSegments(s: TradingSession, intervalName: CandleInterval): Segment[] {
  const open = secondsOf(s.open);
  const close = secondsOf(s.close);
  if (intervalName === '1d') return [{ t: open, start: open, end: close }];
  const iv = CANDLE_INTERVAL_SECONDS[intervalName];
  const out: Segment[] = [];
  for (let b = Math.floor(open / iv) * iv; b < close; b += iv) {
    const start = Math.max(b, open);
    const end = Math.min(b + iv, close);
    if (end > start) out.push({ t: b, start, end });
  }
  return out;
}

/** Calendar markets: walk sessions backwards in 30-day windows until `need` candles are found. */
function calendarSegments(
  calendar: Calendar,
  intervalName: CandleInterval,
  lower: number,
  upper: number,
  need: number,
): Segment[] {
  const out: Segment[] = [];
  const floorDate = [calendar.coverage.from, exchangeDate(calendar, new Date(lower * 1000))].reduce(
    (a, b) => (a > b ? a : b),
  );
  let endDate = exchangeDate(calendar, new Date(upper * 1000));
  while (endDate >= floorDate && out.length < need) {
    const w = dateMinus(endDate, 30);
    const startDate = w > floorDate ? w : floorDate;
    const sessions = sessionsBetween(calendar, startDate, endDate);
    for (let i = sessions.length - 1; i >= 0 && out.length < need; i -= 1) {
      const segs = sessionSegments(sessions[i] as TradingSession, intervalName);
      for (let j = segs.length - 1; j >= 0 && out.length < need; j -= 1) {
        const g = segs[j] as Segment;
        if (g.start <= upper && g.start >= lower) out.push(g);
      }
    }
    endDate = previousDate(startDate);
  }
  return out;
}

// ---- synthetic volume ------------------------------------------------------------------------------------------------

const RIPPLE_PERIOD = 101;
/** Minute ripple r(j) in [-50, 50], periodic, closed form. */
const rippleRaw = (j: number): number => ((j * 37 + 11) % RIPPLE_PERIOD) - 50;

class VolumeModel {
  readonly #base: number;
  readonly #seedH: number;
  readonly #symH: number;
  readonly #levels = new Map<number, number>();
  readonly #ripplePrefix: number[] = [0];
  #rippleTotal = 0;

  constructor(seed: string, instrument: CandleInstrument) {
    this.#base = instrument.volumeUnitsPerMinute;
    this.#seedH = hashText(seed);
    this.#symH = hashText(instrument.symbol);
    for (let j = 0; j < RIPPLE_PERIOD; j += 1) {
      this.#rippleTotal += this.#ripple(j);
      this.#ripplePrefix.push(this.#rippleTotal);
    }
  }

  #ripple(j: number): number {
    return Math.trunc((this.#base * rippleRaw(j)) / 400);
  }

  /** The level of one hour (epoch hour index): 60 to 140 percent of the base per minute. */
  #level(hour: number): number {
    let v = this.#levels.get(hour);
    if (v === undefined) {
      v = Math.floor((this.#base * (60 + (hash4(this.#seedH, this.#symH, hour, 9001) % 81))) / 100);
      this.#levels.set(hour, v);
    }
    return v;
  }

  /** Sum of the ripple over the minute indexes [a, b) (0 <= a <= b), without any large intermediate sum. */
  #rippleBetween(a: number, b: number): number {
    const qa = Math.floor(a / RIPPLE_PERIOD);
    const qb = Math.floor(b / RIPPLE_PERIOD);
    return (
      (qb - qa) * this.#rippleTotal +
      (this.#ripplePrefix[b % RIPPLE_PERIOD] as number) -
      (this.#ripplePrefix[a % RIPPLE_PERIOD] as number)
    );
  }

  /** Exact volume in smallest units over the whole minutes [fromSec, toSec) (both multiples of 60). */
  between(fromSec: number, toSec: number): number {
    if (toSec <= fromSec) return 0;
    let total = this.#rippleBetween(fromSec / 60, toSec / 60);
    for (let h = Math.floor(fromSec / 3600); h * 3600 < toSec; h += 1) {
      const a = Math.max(fromSec, h * 3600);
      const b = Math.min(toSec, (h + 1) * 3600);
      total += this.#level(h) * ((b - a) / 60);
    }
    return total;
  }
}

function volumeString(units: number, dp: number): string {
  if (dp === 0) return String(units);
  const scale = 10n ** BigInt(dp);
  const v = BigInt(units);
  return `${(v / scale).toString()}.${(v % scale).toString().padStart(dp, '0')}`;
}

// ---- the candles ------------------------------------------------------------------------------------------------------

/**
 * Builds the candles for a request. Candles are selected by their FIRST instant being within [from, to] (and not after
 * `now`); the newest `limit` of them are returned, oldest first. See the header for the price, volume and session rules.
 */
export function buildCandles(input: BuildCandlesInput): BuildCandlesResult {
  const { instrument, interval, now } = input;
  const ivSec = CANDLE_INTERVAL_SECONDS[interval];
  const grid = gridSecondsFor(interval);
  const upper = Math.min(input.to ?? now, now);
  const lower = Math.max(input.from ?? SIM_HISTORY_START_SECONDS, SIM_HISTORY_START_SECONDS);
  const need = input.limit + 1; // one extra tells us whether the answer was truncated
  const found =
    input.sessions.kind === 'CONTINUOUS'
      ? continuousSegments(ivSec, lower, upper, need)
      : calendarSegments(input.sessions.calendar, interval, lower, upper, need);
  const truncated = found.length > input.limit;
  const chosen = found.slice(0, input.limit).reverse(); // oldest first

  const prices = new Map<number, bigint>();
  const priceAt = (t: number): bigint => {
    let p = prices.get(t);
    if (p === undefined) {
      p = simMidUnits(input.seed, instrument, t, { gaps: input.gaps });
      prices.set(t, p);
    }
    return p;
  };
  const volume = new VolumeModel(input.seed, instrument);

  const candles: Candle[] = chosen.map((seg) => {
    const closed = now >= seg.end;
    const last = closed ? seg.end : now;
    const first = seg.start;
    const o = priceAt(first);
    let h = o;
    let l = o;
    for (let t = (Math.floor(first / grid) + 1) * grid; t < last; t += grid) {
      const p = priceAt(t);
      if (p > h) h = p;
      if (p < l) l = p;
    }
    const c = priceAt(last);
    if (c > h) h = c;
    if (c < l) l = c;
    const minuteEnd = Math.floor(last / 60) * 60;
    return {
      t: seg.t,
      o: unitsToString(o, instrument.tickDp),
      h: unitsToString(h, instrument.tickDp),
      l: unitsToString(l, instrument.tickDp),
      c: unitsToString(c, instrument.tickDp),
      v: volumeString(volume.between(first, minuteEnd), instrument.volumeDp),
      closed,
    };
  });
  return { candles, truncated, evaluations: prices.size };
}

// ---- prior close and day change (D-82) --------------------------------------------------------------------------------

export type ChangeBasis = 'PREV_SESSION_CLOSE' | 'ROLLING_24H';

export interface PriceReference {
  /** The reference price on the instrument's tick grid, as a decimal string. */
  readonly prevClose: string;
  readonly basis: ChangeBasis;
  /** The instant the reference price is read at (epoch seconds). */
  readonly at: number;
}

export interface ReferenceInput {
  readonly seed: string;
  readonly instrument: SimSymbolConfig;
  readonly now: number;
  readonly sessions: CandleSessions;
  readonly gaps: boolean;
}

/** The latest sessions on or before `date`, newest first, looking back far enough to cross any holiday run. */
function sessionsBackFrom(calendar: Calendar, date: string, count: number): TradingSession[] {
  const out: TradingSession[] = [];
  let end = date;
  for (let round = 0; round < 12 && out.length < count; round += 1) {
    const start = dateMinus(end, 14);
    const floor = calendar.coverage.from;
    if (end < floor) break;
    const s = sessionsBetween(calendar, start > floor ? start : floor, end);
    for (let i = s.length - 1; i >= 0 && out.length < count; i -= 1)
      out.push(s[i] as TradingSession);
    end = previousDate(start);
  }
  return out;
}

/**
 * The reference price for the day change (D-82). Calendar markets: the close of the session BEFORE the current or most
 * recent session (the latest session that has opened at `now`). Continuous markets: the price 24 hours ago on the
 * 60-second grid. null when there is no history that far back (never 0).
 */
export function referencePrice(input: ReferenceInput): PriceReference | null {
  const { instrument, now } = input;
  const unitsAt = (t: number): string =>
    unitsToString(simMidUnits(input.seed, instrument, t, { gaps: input.gaps }), instrument.tickDp);
  if (input.sessions.kind === 'CONTINUOUS') {
    const at = Math.floor((now - DAY) / 60) * 60;
    if (at < SIM_HISTORY_START_SECONDS) return null;
    return { prevClose: unitsAt(at), basis: 'ROLLING_24H', at };
  }
  const cal = input.sessions.calendar;
  const today = exchangeDate(cal, new Date(now * 1000));
  // the latest session that has opened, then the one before it
  const recent = sessionsBackFrom(cal, today, 4).filter((s) => secondsOf(s.open) <= now);
  const previous = recent[1];
  if (previous === undefined) return null;
  const at = secondsOf(previous.close);
  if (at < SIM_HISTORY_START_SECONDS) return null;
  return { prevClose: unitsAt(at), basis: 'PREV_SESSION_CLOSE', at };
}

export interface DayChange {
  /** last - prevClose, exact. */
  readonly change: string;
  /** change / prevClose x 100, rounded to 2 decimal places HALF_EVEN, one rounding from the exact value. */
  readonly changePct: string;
}

/** The day change from two decimal strings, with @vantage/money only (no floats). null when prevClose is not positive. */
export function dayChange(last: string, prevClose: string): DayChange | null {
  const prev = parse(prevClose);
  if (prev.sign() <= 0) return null;
  const change = sub(parse(last), prev);
  const pct = change.mul(parse('100')).div(prev, 2, 'HALF_EVEN');
  return { change: change.toCanonicalString(), changePct: pct.toScaleString(2) };
}

/** The close price of a session as a string (used by the equity-curve catch-up, D-83): the price at the close instant. */
export function sessionClosePrice(
  seed: string,
  instrument: SimSymbolConfig,
  closeInstant: number,
  gaps: boolean,
): string {
  return unitsToString(simMidUnits(seed, instrument, closeInstant, { gaps }), instrument.tickDp);
}
