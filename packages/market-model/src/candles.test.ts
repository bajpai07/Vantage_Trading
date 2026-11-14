import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CANDLE_INTERVALS,
  CANDLE_INTERVAL_SECONDS,
  MAX_CANDLES,
  SIM_CRYPTO,
  SIM_HISTORY_START_SECONDS,
  SIM_STOCKS,
  SIM_UNIVERSE,
  buildCandles,
  dayChange,
  gridSecondsFor,
  maxEvaluations,
  referencePrice,
  sessionClosePrice,
  simMid,
} from './index.js';
import type {
  BuildCandlesResult,
  Candle,
  CandleInterval,
  CandleSessions,
  SimInstrument,
} from './index.js';
import { NYSE_CALENDAR_2026_2027 as CAL } from './testing.js';

const SEED = 'vantage-demo-1';
const sec = (iso: string): number => Date.parse(iso) / 1000;
const iso = (s: number): string => new Date(s * 1000).toISOString();
const inst = (symbol: string): SimInstrument => {
  const c = SIM_UNIVERSE.find((x) => x.symbol === symbol);
  if (c === undefined) throw new Error(`no ${symbol}`);
  return c;
};
const CONT: CandleSessions = { kind: 'CONTINUOUS' };
const NYSE: CandleSessions = { kind: 'CALENDAR', calendar: CAL };
const NOW = sec('2026-12-01T00:00:00Z'); // a Tuesday, after every date used below

function candles(
  symbol: string,
  interval: CandleInterval,
  from: string | null,
  to: string | null,
  opts: {
    sessions?: CandleSessions;
    gaps?: boolean;
    limit?: number;
    now?: number;
    seed?: string;
  } = {},
): BuildCandlesResult {
  const sessions = opts.sessions ?? (inst(symbol).assetClass === 'CRYPTO' ? CONT : NYSE);
  return buildCandles({
    seed: opts.seed ?? SEED,
    instrument: inst(symbol),
    interval,
    from: from === null ? null : sec(from),
    to: to === null ? null : sec(to),
    limit: opts.limit ?? MAX_CANDLES,
    now: opts.now ?? NOW,
    sessions,
    gaps: opts.gaps ?? sessions.kind === 'CALENDAR',
  });
}

/** Digits of a decimal string as a BigInt (all strings of one instrument have the same decimal places). */
const digits = (s: string): bigint => BigInt(s.replace('.', ''));

// ---- independent reference: the same definition written out the long way, from the public price function ----------------

/** open, high, low, close over the sample grid [s, e], using only simMid (the string path), not the candle code. */
function referenceOhlc(symbol: string, s: number, e: number, grid: number, gaps: boolean) {
  const prices: bigint[] = [digits(simMid(SEED, inst(symbol), s, { gaps }))];
  for (let t = (Math.floor(s / grid) + 1) * grid; t < e; t += grid) {
    prices.push(digits(simMid(SEED, inst(symbol), t, { gaps })));
  }
  const close = digits(simMid(SEED, inst(symbol), e, { gaps }));
  prices.push(close);
  const open = prices[0] as bigint;
  return {
    open,
    close,
    high: prices.reduce((a, b) => (a > b ? a : b)),
    low: prices.reduce((a, b) => (a < b ? a : b)),
  };
}

function expectMatchesReference(
  symbol: string,
  c: Candle,
  s: number,
  e: number,
  grid: number,
  gaps: boolean,
) {
  const r = referenceOhlc(symbol, s, e, grid, gaps);
  expect(
    { o: digits(c.o), h: digits(c.h), l: digits(c.l), c: digits(c.c) },
    `${symbol} ${iso(c.t)}`,
  ).toEqual({
    o: r.open,
    h: r.high,
    l: r.low,
    c: r.close,
  });
}

// ---- goldens ---------------------------------------------------------------------------------------------------------------
// Hard-coded candles for seed vantage-demo-1. The structure was checked by hand (the instants below), the prices by the
// independent reference above (expectMatchesReference), which recomputes open, high, low and close from simMid alone.
//
// Instants (UTC), worked out by hand: 2026-11-10 is a Tuesday and New York is on standard time (EST, UTC-5), so the NYSE
// opens at 14:30Z and closes at 21:00Z. 1794321000 = 2026-11-10T14:30:00Z. 2026-11-27 is the day after Thanksgiving, an early
// close at 13:00 EST = 18:00Z.

describe('golden candles (exact strings)', () => {
  it('BTC-USD 1h, continuous: three closed candles, each close is the next open', () => {
    const r = candles('BTC-USD', '1h', '2026-11-10T12:00:00Z', '2026-11-10T14:00:00Z');
    expect(r.candles).toEqual([
      {
        t: 1794312000,
        o: '75642.67',
        h: '76043.14',
        l: '75461.79',
        c: '75935.95',
        v: '28.77612500',
        closed: true,
      },
      {
        t: 1794315600,
        o: '75935.95',
        h: '76429.46',
        l: '75604.17',
        c: '76429.46',
        v: '14.68950000',
        closed: true,
      },
      {
        t: 1794319200,
        o: '76429.46',
        h: '76581.72',
        l: '75264.37',
        c: '75459.99',
        v: '22.53125000',
        closed: true,
      },
    ]);
    expect(r.truncated).toBe(false);
    expect(iso(1794312000)).toBe('2026-11-10T12:00:00.000Z');
    for (const c of r.candles) expectMatchesReference('BTC-USD', c, c.t, c.t + 3600, 60, false);
    // 75459.99 is also the simulated BTC-USD price at 15:00:00Z (see sim.test.ts goldens): the third candle ends there
    expect(r.candles[2]?.c).toBe('75459.99');
  });

  it('BTC-USD 1d, aligned to the UTC day', () => {
    const r = candles('BTC-USD', '1d', '2026-11-08T00:00:00Z', '2026-11-09T00:00:00Z');
    expect(r.candles).toEqual([
      {
        t: 1794096000,
        o: '72638.85',
        h: '75011.38',
        l: '71846.39',
        c: '74825.17',
        v: '526.31600000',
        closed: true,
      },
      {
        t: 1794182400,
        o: '74825.17',
        h: '76826.25',
        l: '71705.59',
        c: '72453.11',
        v: '464.54450000',
        closed: true,
      },
    ]);
    expect(iso(1794096000)).toBe('2026-11-08T00:00:00.000Z');
    for (const c of r.candles) expectMatchesReference('BTC-USD', c, c.t, c.t + 86400, 300, false);
  });

  it('DOGE-USD 15m: five decimal places, volume with eight', () => {
    const r = candles('DOGE-USD', '15m', '2026-11-10T15:00:00Z', '2026-11-10T15:30:00Z');
    expect(r.candles).toEqual([
      {
        t: 1794322800,
        o: '0.19619',
        h: '0.19774',
        l: '0.19540',
        c: '0.19746',
        v: '377150.00000000',
        closed: true,
      },
      {
        t: 1794323700,
        o: '0.19746',
        h: '0.19825',
        l: '0.19665',
        c: '0.19772',
        v: '384350.00000000',
        closed: true,
      },
      {
        t: 1794324600,
        o: '0.19772',
        h: '0.20200',
        l: '0.19772',
        c: '0.20200',
        v: '376400.00000000',
        closed: true,
      },
    ]);
    expect(r.candles[0]?.o).toBe('0.19619'); // the simulated price at 15:00:00Z (sim.test.ts golden)
  });

  it('AAPL 5m at the open (NYSE): the first candle starts at 14:30Z with the model price there', () => {
    const r = candles('AAPL', '5m', '2026-11-10T14:30:00Z', '2026-11-10T14:40:00Z');
    expect(r.candles).toEqual([
      {
        t: 1794321000,
        o: '187.81',
        h: '187.86',
        l: '187.64',
        c: '187.66',
        v: '5528',
        closed: true,
      },
      {
        t: 1794321300,
        o: '187.66',
        h: '187.66',
        l: '187.49',
        c: '187.62',
        v: '5564',
        closed: true,
      },
      {
        t: 1794321600,
        o: '187.62',
        h: '187.67',
        l: '187.41',
        c: '187.41',
        v: '5374',
        closed: true,
      },
    ]);
    for (const c of r.candles) expectMatchesReference('AAPL', c, c.t, c.t + 300, 60, true);
  });

  it('AAPL 1h on a normal EST day: 7 candles, the first and last clipped to the 14:30Z to 21:00Z session', () => {
    const r = candles('AAPL', '1h', '2026-11-10T00:00:00Z', '2026-11-10T23:59:59Z');
    expect(r.candles.map((c) => iso(c.t))).toEqual([
      '2026-11-10T14:00:00.000Z', // aligned hour, clipped to start at 14:30
      '2026-11-10T15:00:00.000Z',
      '2026-11-10T16:00:00.000Z',
      '2026-11-10T17:00:00.000Z',
      '2026-11-10T18:00:00.000Z',
      '2026-11-10T19:00:00.000Z',
      '2026-11-10T20:00:00.000Z', // ends at the 21:00 close
    ]);
    expect(r.candles.map((c) => [c.o, c.h, c.l, c.c, c.v])).toEqual([
      ['187.81', '187.86', '187.02', '187.05', '33254'],
      ['187.05', '188.26', '186.99', '187.97', '61989'],
      ['187.97', '187.97', '186.67', '186.94', '55691'],
      ['186.94', '187.11', '186.29', '186.41', '72929'],
      ['186.41', '187.12', '185.75', '186.10', '36167'],
      ['186.10', '186.53', '185.71', '186.53', '59883'],
      ['186.53', '186.55', '185.38', '185.47', '52823'],
    ]);
    const first = r.candles[0] as Candle;
    expectMatchesReference(
      'AAPL',
      first,
      sec('2026-11-10T14:30:00Z'),
      sec('2026-11-10T15:00:00Z'),
      60,
      true,
    );
    const last = r.candles[6] as Candle;
    expectMatchesReference(
      'AAPL',
      last,
      sec('2026-11-10T20:00:00Z'),
      sec('2026-11-10T21:00:00Z'),
      60,
      true,
    );
  });

  it('AAPL 4h and 1d on that day: three 4h candles, one daily candle for the whole session', () => {
    const h4 = candles('AAPL', '4h', '2026-11-10T00:00:00Z', '2026-11-10T23:59:59Z');
    expect(h4.candles.map((c) => [iso(c.t), c.o, c.h, c.l, c.c, c.v])).toEqual([
      ['2026-11-10T12:00:00.000Z', '187.81', '188.14', '187.05', '187.97', '95243'],
      ['2026-11-10T16:00:00.000Z', '187.97', '187.97', '185.75', '186.53', '224670'],
      ['2026-11-10T20:00:00.000Z', '186.53', '186.53', '185.47', '185.47', '52823'],
    ]);
    const d1 = candles('AAPL', '1d', '2026-11-09T00:00:00Z', '2026-11-10T23:59:59Z');
    expect(d1.candles.map((c) => [iso(c.t), c.o, c.h, c.l, c.c, c.v])).toEqual([
      ['2026-11-09T14:30:00.000Z', '192.59', '193.70', '190.41', '190.66', '392749'],
      ['2026-11-10T14:30:00.000Z', '187.81', '188.14', '185.47', '185.47', '372736'],
    ]);
    const day = d1.candles[1] as Candle;
    expectMatchesReference(
      'AAPL',
      day,
      sec('2026-11-10T14:30:00Z'),
      sec('2026-11-10T21:00:00Z'),
      300,
      true,
    );
    // the daily candle's open and close are the first and last 1h candle's open and close
    expect([day.o, day.c]).toEqual(['187.81', '185.47']);
  });

  it('the early close (2026-11-27, 13:00 EST = 18:00Z): the last candle ends at 18:00Z, nothing after it', () => {
    const r = candles('AAPL', '1h', '2026-11-27T00:00:00Z', '2026-11-27T23:59:59Z');
    expect(r.candles.map((c) => iso(c.t))).toEqual([
      '2026-11-27T14:00:00.000Z',
      '2026-11-27T15:00:00.000Z',
      '2026-11-27T16:00:00.000Z',
      '2026-11-27T17:00:00.000Z',
    ]);
    expect(r.candles.map((c) => c.c)).toEqual(['186.23', '186.05', '184.53', '184.73']);
    expectMatchesReference(
      'AAPL',
      r.candles[3] as Candle,
      sec('2026-11-27T17:00:00Z'),
      sec('2026-11-27T18:00:00Z'),
      60,
      true,
    );
    // 09:30 to 13:00 is 3.5 hours: 210 one-minute candles, 42 five-minute candles
    expect(
      candles('AAPL', '1m', '2026-11-27T00:00:00Z', '2026-11-27T23:59:59Z').candles,
    ).toHaveLength(210);
    expect(
      candles('AAPL', '5m', '2026-11-27T00:00:00Z', '2026-11-27T23:59:59Z').candles,
    ).toHaveLength(42);
  });

  it('the simulated 24/7 stock session is continuous: Saturday candles exist (no gaps, no calendar)', () => {
    const r = candles('AAPL', '1h', '2026-11-14T10:00:00Z', '2026-11-14T12:00:00Z', {
      sessions: CONT,
      gaps: false,
    });
    expect(r.candles.map((c) => [iso(c.t), c.o, c.c])).toEqual([
      ['2026-11-14T10:00:00.000Z', '194.91', '194.41'],
      ['2026-11-14T11:00:00.000Z', '194.41', '194.27'],
      ['2026-11-14T12:00:00.000Z', '194.27', '193.90'],
    ]);
    // 2026-11-14 is a Saturday: the same request on the real calendar has no candles
    expect(candles('AAPL', '1h', '2026-11-14T10:00:00Z', '2026-11-14T12:00:00Z').candles).toEqual(
      [],
    );
  });
});

// ---- sessions: weekends, holidays, DST --------------------------------------------------------------------------------------

describe('NYSE session rules', () => {
  it('no candles on a weekend or on Thanksgiving, in any interval', () => {
    for (const interval of CANDLE_INTERVALS) {
      expect(
        candles('AAPL', interval, '2026-11-14T00:00:00Z', '2026-11-15T23:59:59Z').candles,
        `weekend ${interval}`,
      ).toEqual([]);
      expect(
        candles('AAPL', interval, '2026-11-26T00:00:00Z', '2026-11-26T23:59:59Z').candles,
        `holiday ${interval}`,
      ).toEqual([]);
    }
    // control: the day before and the day after have candles
    expect(
      candles('AAPL', '1h', '2026-11-25T00:00:00Z', '2026-11-25T23:59:59Z').candles.length,
    ).toBeGreaterThan(0);
    expect(
      candles('AAPL', '1h', '2026-11-27T00:00:00Z', '2026-11-27T23:59:59Z').candles.length,
    ).toBeGreaterThan(0);
  });

  it('daylight saving, March: Friday 2026-03-06 is EST (14:30Z to 21:00Z), Monday 2026-03-09 is EDT (13:30Z to 20:00Z)', () => {
    // New York moved to daylight time on Sunday 2026-03-08 (second Sunday of March), so the UTC time of the open moves an hour
    const days = candles('AAPL', '1d', '2026-03-06T00:00:00Z', '2026-03-10T23:59:59Z');
    expect(days.candles.map((c) => iso(c.t))).toEqual([
      '2026-03-06T14:30:00.000Z',
      '2026-03-09T13:30:00.000Z',
      '2026-03-10T13:30:00.000Z',
    ]);
    const fri = candles('AAPL', '1h', '2026-03-06T00:00:00Z', '2026-03-06T23:59:59Z').candles;
    expect(fri.map((c) => iso(c.t).slice(11, 16))).toEqual([
      '14:00',
      '15:00',
      '16:00',
      '17:00',
      '18:00',
      '19:00',
      '20:00',
    ]);
    const mon = candles('AAPL', '1h', '2026-03-09T00:00:00Z', '2026-03-09T23:59:59Z').candles;
    expect(mon.map((c) => iso(c.t).slice(11, 16))).toEqual([
      '13:00',
      '14:00',
      '15:00',
      '16:00',
      '17:00',
      '18:00',
      '19:00',
    ]);
    // each session is 6.5 hours long: 390 one-minute candles on both sides of the change
    expect(
      candles('AAPL', '1m', '2026-03-06T00:00:00Z', '2026-03-06T23:59:59Z').candles,
    ).toHaveLength(390);
    expect(
      candles('AAPL', '1m', '2026-03-09T00:00:00Z', '2026-03-09T23:59:59Z').candles,
    ).toHaveLength(390);
    // and the daily candle of Monday ends at 20:00Z: its close is the price there
    expectMatchesReference(
      'AAPL',
      days.candles[1] as Candle,
      sec('2026-03-09T13:30:00Z'),
      sec('2026-03-09T20:00:00Z'),
      300,
      true,
    );
  });

  it('daylight saving, November: Friday 2026-10-30 is EDT (13:30Z to 20:00Z), Monday 2026-11-02 is EST (14:30Z to 21:00Z)', () => {
    // New York returned to standard time on Sunday 2026-11-01 (first Sunday of November)
    const days = candles('AAPL', '1d', '2026-10-30T00:00:00Z', '2026-11-03T23:59:59Z');
    expect(days.candles.map((c) => iso(c.t))).toEqual([
      '2026-10-30T13:30:00.000Z',
      '2026-11-02T14:30:00.000Z',
      '2026-11-03T14:30:00.000Z',
    ]);
    const fri = candles('AAPL', '4h', '2026-10-30T00:00:00Z', '2026-10-30T23:59:59Z').candles;
    expect(fri.map((c) => iso(c.t).slice(11, 16))).toEqual(['12:00', '16:00']); // 13:30 to 16:00 and 16:00 to 20:00
    const mon = candles('AAPL', '4h', '2026-11-02T00:00:00Z', '2026-11-02T23:59:59Z').candles;
    expect(mon.map((c) => iso(c.t).slice(11, 16))).toEqual(['12:00', '16:00', '20:00']); // 14:30 to 21:00
  });

  it('no history before 2026-01-01T00:00:00Z, and the first NYSE session of 2026 is January 2', () => {
    expect(SIM_HISTORY_START_SECONDS).toBe(sec('2026-01-01T00:00:00Z'));
    const crypto = candles('BTC-USD', '1d', '2025-12-30T00:00:00Z', '2026-01-02T00:00:00Z');
    expect(crypto.candles.map((c) => iso(c.t))).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
    ]);
    const stock = candles('AAPL', '1d', '2025-12-30T00:00:00Z', '2026-01-09T00:00:00Z');
    expect(iso(stock.candles[0]?.t ?? 0)).toBe('2026-01-02T14:30:00.000Z'); // Jan 1 is a holiday
  });
});

// ---- aggregation -------------------------------------------------------------------------------------------------------------

interface Aggregate {
  o: string;
  c: string;
  h: bigint;
  l: bigint;
  v: bigint;
}
function aggregate(children: Candle[]): Aggregate {
  const first = children[0] as Candle;
  const last = children[children.length - 1] as Candle;
  return {
    o: first.o,
    c: last.c,
    h: children.map((c) => digits(c.h)).reduce((a, b) => (a > b ? a : b)),
    l: children.map((c) => digits(c.l)).reduce((a, b) => (a < b ? a : b)),
    v: children.map((c) => digits(c.v)).reduce((a, b) => a + b, 0n),
  };
}

/** The finer candles of `finer` that fall inside the parent candle (by first instant, within the parent's span). */
function childrenOf(
  symbol: string,
  parent: Candle,
  parentInterval: CandleInterval,
  finer: CandleInterval,
  sessions: CandleSessions,
  gaps: boolean,
  dayEnd: number,
): Candle[] {
  const span = CANDLE_INTERVAL_SECONDS[parentInterval];
  const from = sessions.kind === 'CALENDAR' && parentInterval === '1d' ? parent.t : parent.t;
  const to = sessions.kind === 'CALENDAR' && parentInterval === '1d' ? dayEnd : parent.t + span - 1;
  return candles(symbol, finer, iso(from), iso(to), { sessions, gaps }).candles;
}

describe('aggregation', () => {
  const cases: Array<[string, CandleSessions, boolean, string, string]> = [
    ['BTC-USD', CONT, false, '2026-11-10T00:00:00Z', '2026-11-10T08:00:00Z'],
    ['DOGE-USD', CONT, false, '2026-06-01T20:00:00Z', '2026-06-02T02:00:00Z'],
    ['AAPL', NYSE, true, '2026-11-10T00:00:00Z', '2026-11-10T23:59:59Z'], // a full session
    ['TSLA', NYSE, true, '2026-11-27T00:00:00Z', '2026-11-27T23:59:59Z'], // the early close
    ['SPY', NYSE, true, '2026-03-09T00:00:00Z', '2026-03-09T23:59:59Z'], // the first day of daylight time
    ['AAPL', CONT, false, '2026-11-14T00:00:00Z', '2026-11-14T06:00:00Z'], // the 24/7 session on a Saturday
  ];

  it.each(cases)(
    '%s: 1m to 5m to 15m to 1h are EXACT (open, close, max high, min low, volume sum), including clipped session edges',
    (symbol, sessions, gaps, from, to) => {
      for (const parentInterval of ['5m', '15m', '1h'] as const) {
        const parents = candles(symbol, parentInterval, from, to, { sessions, gaps }).candles;
        expect(parents.length).toBeGreaterThan(0);
        for (const p of parents) {
          const kids = childrenOf(
            symbol,
            p,
            parentInterval,
            '1m',
            sessions,
            gaps,
            p.t + CANDLE_INTERVAL_SECONDS[parentInterval] - 1,
          );
          const a = aggregate(kids);
          expect(
            { o: p.o, c: p.c, h: digits(p.h), l: digits(p.l), v: digits(p.v) },
            `${symbol} ${parentInterval} ${iso(p.t)}`,
          ).toEqual(a);
        }
      }
      // the chain: a 15m candle is also exactly the three 5m candles it covers
      for (const p of candles(symbol, '15m', from, to, { sessions, gaps }).candles) {
        const kids = childrenOf(symbol, p, '15m', '5m', sessions, gaps, p.t + 899);
        expect({ o: p.o, c: p.c, h: digits(p.h), l: digits(p.l), v: digits(p.v) }).toEqual(
          aggregate(kids),
        );
      }
    },
  );

  it.each(cases)(
    '%s: 4h and 1d keep open, close and volume EXACT, and high <= the finer high, low >= the finer low (a coarser grid never invents an extreme)',
    (symbol, sessions, gaps, from, to) => {
      for (const parentInterval of ['4h', '1d'] as const) {
        const parents = candles(symbol, parentInterval, from, to, { sessions, gaps }).candles;
        expect(parents.length).toBeGreaterThan(0);
        let strictlyNarrower = 0;
        for (const p of parents) {
          const dayEnd =
            sessions.kind === 'CALENDAR'
              ? p.t + 86399
              : p.t + CANDLE_INTERVAL_SECONDS[parentInterval] - 1;
          const kids = childrenOf(symbol, p, parentInterval, '1h', sessions, gaps, dayEnd);
          const a = aggregate(kids);
          expect([p.o, p.c, digits(p.v)], `${symbol} ${parentInterval} ${iso(p.t)}`).toEqual([
            a.o,
            a.c,
            a.v,
          ]);
          expect(digits(p.h) <= a.h).toBe(true);
          expect(digits(p.l) >= a.l).toBe(true);
          if (digits(p.h) < a.h || digits(p.l) > a.l) strictlyNarrower += 1;
        }
        void strictlyNarrower; // the weaker invariant is a bound, equality is allowed and common
      }
    },
  );

  it('the weaker invariant is real: over many days a coarse candle is sometimes strictly narrower than its 1h candles (so the documentation is not vacuous)', () => {
    let narrower = 0;
    const days = candles('BTC-USD', '1d', '2026-03-01T00:00:00Z', '2026-05-01T00:00:00Z').candles;
    for (const p of days) {
      const kids = candles('BTC-USD', '1h', iso(p.t), iso(p.t + 86399)).candles;
      const a = aggregate(kids);
      if (digits(p.h) < a.h || digits(p.l) > a.l) narrower += 1;
    }
    expect(narrower).toBeGreaterThan(0);
  });
});

// ---- properties -----------------------------------------------------------------------------------------------------------

describe('properties (fast-check)', () => {
  const instruments = SIM_UNIVERSE.map((c) => c.symbol);
  const request = fc.record({
    symbol: fc.constantFrom(...instruments),
    interval: fc.constantFrom(...CANDLE_INTERVALS),
    now: fc.integer({ min: sec('2026-01-05T00:00:00Z'), max: sec('2027-12-20T00:00:00Z') }),
    back: fc.option(fc.integer({ min: 0, max: 30 * 86400 }), { nil: null }),
    limit: fc.integer({ min: 1, max: 25 }),
    gaps: fc.boolean(),
    continuousStock: fc.boolean(),
    seed: fc.constantFrom('vantage-demo-1', 'seed-b', 'x'),
  });

  it('OHLC bounds, positive tick multiples, ascending and unique, at most `limit`, never in the future, only the newest may be forming', () => {
    fc.assert(
      fc.property(request, (q) => {
        const crypto = inst(q.symbol).assetClass === 'CRYPTO';
        const sessions: CandleSessions = crypto || q.continuousStock ? CONT : NYSE;
        const gaps = !crypto && sessions.kind === 'CALENDAR' && q.gaps;
        const r = buildCandles({
          seed: q.seed,
          instrument: inst(q.symbol),
          interval: q.interval,
          from: null,
          to: q.back === null ? null : q.now - q.back,
          limit: q.limit,
          now: q.now,
          sessions,
          gaps,
        });
        const dp = inst(q.symbol).tickDp;
        expect(r.candles.length).toBeLessThanOrEqual(q.limit);
        expect(r.evaluations).toBeLessThanOrEqual(maxEvaluations(q.interval, q.limit));
        for (let i = 0; i < r.candles.length; i += 1) {
          const c = r.candles[i] as Candle;
          const [o, h, l, cl] = [digits(c.o), digits(c.h), digits(c.l), digits(c.c)];
          expect(l <= (o < cl ? o : cl)).toBe(true);
          expect((o > cl ? o : cl) <= h).toBe(true);
          expect(l > 0n).toBe(true);
          for (const p of [c.o, c.h, c.l, c.c]) expect(p.split('.')[1]?.length ?? 0).toBe(dp); // a whole number of ticks
          expect(c.v).toMatch(crypto ? /^\d+\.\d{8}$/ : /^\d+$/);
          expect(c.t).toBeLessThanOrEqual(q.now);
          expect(c.t).toBeGreaterThanOrEqual(SIM_HISTORY_START_SECONDS - 86400);
          if (i > 0) expect(c.t).toBeGreaterThan((r.candles[i - 1] as Candle).t);
          if (i < r.candles.length - 1) expect(c.closed).toBe(true);
        }
      }),
      { numRuns: 120 },
    );
  });

  it('contiguity: for consecutive candles of the same interval, open(n+1) = close(n) exactly', () => {
    fc.assert(
      fc.property(request, (q) => {
        const crypto = inst(q.symbol).assetClass === 'CRYPTO';
        const sessions: CandleSessions = crypto || q.continuousStock ? CONT : NYSE;
        const gaps = !crypto && sessions.kind === 'CALENDAR';
        const r = buildCandles({
          seed: q.seed,
          instrument: inst(q.symbol),
          interval: q.interval,
          from: null,
          to: q.back === null ? null : q.now - q.back,
          limit: Math.max(q.limit, 2),
          now: q.now,
          sessions,
          gaps,
        });
        const iv = CANDLE_INTERVAL_SECONDS[q.interval];
        let pairs = 0;
        for (let i = 1; i < r.candles.length; i += 1) {
          const a = r.candles[i - 1] as Candle;
          const b = r.candles[i] as Candle;
          if (b.t === a.t + iv && !(sessions.kind === 'CALENDAR' && q.interval === '1d')) {
            expect(b.o).toBe(a.c);
            pairs += 1;
          }
        }
        return pairs >= 0;
      }),
      { numRuns: 120 },
    );
  });

  it('determinism: the same request twice gives identical output; asking for something else in between changes nothing', () => {
    fc.assert(
      fc.property(request, (q) => {
        const make = (symbol: string, interval: CandleInterval) =>
          buildCandles({
            seed: q.seed,
            instrument: inst(symbol),
            interval,
            from: null,
            to: q.now - (q.back ?? 0),
            limit: q.limit,
            now: q.now,
            sessions: inst(symbol).assetClass === 'CRYPTO' ? CONT : NYSE,
            gaps: inst(symbol).assetClass !== 'CRYPTO',
          });
        const first = make(q.symbol, q.interval);
        make('BTC-USD', '1h'); // an unrelated request in between
        make(q.symbol, '1m');
        expect(make(q.symbol, q.interval)).toEqual(first);
      }),
      { numRuns: 60 },
    );
  });
});

describe('determinism, immutability and the forming candle', () => {
  it('a different seed gives different candles (control: the seed is used)', () => {
    const a = candles('BTC-USD', '1h', '2026-11-10T12:00:00Z', '2026-11-10T14:00:00Z');
    const b = candles('BTC-USD', '1h', '2026-11-10T12:00:00Z', '2026-11-10T14:00:00Z', {
      seed: 'another-seed',
    });
    expect(b.candles).not.toEqual(a.candles);
    expect(b.candles.map((c) => c.t)).toEqual(a.candles.map((c) => c.t)); // the structure does not depend on the seed
  });

  it('closed candles are immutable: the same candle requested at two later instants is byte-identical', () => {
    const at = (now: number) =>
      candles('BTC-USD', '1h', '2026-11-10T12:00:00Z', '2026-11-10T14:00:00Z', { now });
    const a = JSON.stringify(at(sec('2026-11-10T15:00:00Z')).candles);
    expect(JSON.stringify(at(sec('2026-11-10T15:00:01Z')).candles)).toBe(a);
    expect(JSON.stringify(at(sec('2027-06-01T00:00:00Z')).candles)).toBe(a);
    const stock = (now: number) =>
      JSON.stringify(
        candles('AAPL', '5m', '2026-11-10T14:30:00Z', '2026-11-10T14:40:00Z', { now }).candles,
      );
    expect(stock(sec('2026-11-10T20:00:00Z'))).toBe(stock(sec('2026-12-24T00:00:00Z')));
  });

  it('the forming candle is closed:false, computed up to now, and changes as now advances; earlier candles do not', () => {
    const run = (now: string) =>
      candles('BTC-USD', '1h', '2026-11-10T13:00:00Z', null, { now: sec(now), limit: 3 });
    const a = run('2026-11-10T15:10:00Z');
    const b = run('2026-11-10T15:40:00Z');
    expect(a.candles.map((c) => c.closed)).toEqual([true, true, false]);
    expect(b.candles.map((c) => c.closed)).toEqual([true, true, false]);
    expect(a.candles.slice(0, 2)).toEqual(b.candles.slice(0, 2)); // earlier candles: same bytes
    const [fa, fb] = [a.candles[2] as Candle, b.candles[2] as Candle];
    expect(fa.t).toBe(fb.t);
    expect(fa.t).toBe(sec('2026-11-10T15:00:00Z'));
    expect(fa.o).toBe(fb.o); // the open does not move
    expect(fa.c).toBe(simMid(SEED, inst('BTC-USD'), sec('2026-11-10T15:10:00Z'), { gaps: false })); // close = the price at now
    expect(fb.c).toBe(simMid(SEED, inst('BTC-USD'), sec('2026-11-10T15:40:00Z'), { gaps: false }));
    expect(fa.v).not.toBe(fb.v);
    expect(digits(fb.v) > digits(fa.v)).toBe(true); // more minutes have elapsed
    // at the very instant a candle opens it already exists, forming, with open = close and no volume
    const edge = run('2026-11-10T16:00:00Z');
    expect(edge.candles[2]).toMatchObject({
      t: sec('2026-11-10T16:00:00Z'),
      closed: false,
      v: '0.00000000',
    });
    expect(edge.candles[2]?.o).toBe(edge.candles[2]?.c);
    expect(edge.candles[1]?.closed).toBe(true); // 15:00 is now complete
  });

  it('a forming candle inside an NYSE session ends at now, not at the session close', () => {
    const r = candles('AAPL', '1h', '2026-11-10T14:00:00Z', null, {
      now: sec('2026-11-10T16:20:30Z'),
      limit: 5,
    });
    expect(r.candles.map((c) => [iso(c.t).slice(11, 16), c.closed])).toEqual([
      ['14:00', true],
      ['15:00', true],
      ['16:00', false],
    ]);
    expect(r.candles[2]?.c).toBe(
      simMid(SEED, inst('AAPL'), sec('2026-11-10T16:20:30Z'), { gaps: true }),
    );
  });

  it('outside a session there is no forming candle: the last candle is the closed one before it', () => {
    const r = candles('AAPL', '1h', null, null, { now: sec('2026-11-10T23:00:00Z'), limit: 2 });
    expect(r.candles.map((c) => [iso(c.t).slice(11, 16), c.closed])).toEqual([
      ['19:00', true],
      ['20:00', true],
    ]);
  });
});

// ---- limits, truncation and bounded cost ---------------------------------------------------------------------------------------

describe('limit, truncation and bounded cost', () => {
  it('more candles than the limit: the NEWEST `limit` come back, ascending, with truncated = true', () => {
    const all = candles('BTC-USD', '1h', '2026-11-10T00:00:00Z', '2026-11-10T23:00:00Z', {
      limit: 500,
    });
    expect(all.candles).toHaveLength(24);
    expect(all.truncated).toBe(false);
    const few = candles('BTC-USD', '1h', '2026-11-10T00:00:00Z', '2026-11-10T23:00:00Z', {
      limit: 5,
    });
    expect(few.truncated).toBe(true);
    expect(few.candles).toEqual(all.candles.slice(-5));
    const exact = candles('BTC-USD', '1h', '2026-11-10T00:00:00Z', '2026-11-10T23:00:00Z', {
      limit: 24,
    });
    expect(exact.truncated).toBe(false); // exactly `limit` candles is not truncation
    expect(exact.candles).toHaveLength(24);
    const nyse = candles('AAPL', '1d', '2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z', {
      limit: 3,
    });
    expect(nyse.truncated).toBe(true);
    // the window ends at 2026-11-30T00:00Z, before that Monday's open: the newest three sessions inside it
    expect(nyse.candles.map((c) => iso(c.t).slice(0, 10))).toEqual([
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
    ]);
  });

  it('an empty or reversed range has no candles and is not truncated', () => {
    expect(candles('BTC-USD', '1h', '2026-11-10T14:00:00Z', '2026-11-10T12:00:00Z')).toMatchObject({
      candles: [],
      truncated: false,
    });
    expect(candles('BTC-USD', '1h', '2030-01-01T00:00:00Z', '2030-01-02T00:00:00Z')).toMatchObject({
      candles: [],
    }); // the future
  });

  it('the cost of a maximum-size request is bounded, per interval, and the bound is what the documentation says', () => {
    expect(maxEvaluations('1m')).toBe(1000);
    expect(maxEvaluations('5m')).toBe(3000);
    expect(maxEvaluations('15m')).toBe(8000);
    expect(maxEvaluations('1h')).toBe(30500);
    expect(maxEvaluations('4h')).toBe(24500);
    expect(maxEvaluations('1d')).toBe(144500);
    expect(CANDLE_INTERVALS.map(gridSecondsFor)).toEqual([60, 60, 60, 60, 300, 300]);
    const now = sec('2027-12-20T00:00:00Z'); // far enough that 500 candles exist for every interval of a 24/7 market
    for (const interval of CANDLE_INTERVALS) {
      const r = buildCandles({
        seed: SEED,
        instrument: inst('BTC-USD'),
        interval,
        from: null,
        to: now - 2 * 86400, // every candle closed: a forming candle evaluates fewer instants
        limit: MAX_CANDLES,
        now,
        sessions: CONT,
        gaps: false,
      });
      expect(r.candles, interval).toHaveLength(500);
      expect(r.evaluations, interval).toBeLessThanOrEqual(maxEvaluations(interval));
      // contiguous candles share their boundary instants (the bound counts both ends of every candle, so it is conservative):
      // the exact count for a continuous market is 500 x (interval / grid) + 1
      expect(r.evaluations, interval).toBe(
        500 * (CANDLE_INTERVAL_SECONDS[interval] / gridSecondsFor(interval)) + 1,
      );
    }
  });
});

// ---- prior close and day change (D-82) ---------------------------------------------------------------------------------------------

describe('referencePrice', () => {
  const ref = (symbol: string, now: string, sessions?: CandleSessions) => {
    const s = sessions ?? (inst(symbol).assetClass === 'CRYPTO' ? CONT : NYSE);
    return referencePrice({
      seed: SEED,
      instrument: inst(symbol),
      now: sec(now),
      sessions: s,
      gaps: s.kind === 'CALENDAR',
    });
  };

  it('stocks on the real calendar: the close of the previous regular session (golden, and equal to the daily candle)', () => {
    // Tuesday 2026-11-10 15:00Z: the current session is Tuesday's, the previous one is Monday's (closed 21:00Z = 1794258000)
    expect(ref('AAPL', '2026-11-10T15:00:00Z')).toEqual({
      prevClose: '190.66',
      basis: 'PREV_SESSION_CLOSE',
      at: 1794258000,
    });
    expect(iso(1794258000)).toBe('2026-11-09T21:00:00.000Z');
    const monday = candles('AAPL', '1d', '2026-11-09T00:00:00Z', '2026-11-09T23:59:59Z')
      .candles[0] as Candle;
    expect(monday.c).toBe('190.66'); // the daily candle's close is the previous close
  });

  it("on a weekend the current session is the last one (Friday), so the reference is Thursday's close", () => {
    expect(ref('AAPL', '2026-11-14T12:00:00Z')).toEqual({
      prevClose: '191.42',
      basis: 'PREV_SESSION_CLOSE',
      at: sec('2026-11-12T21:00:00Z'),
    });
    expect(ref('AAPL', '2026-11-14T12:00:00Z')?.prevClose).toBe(
      sessionClosePrice(SEED, inst('AAPL'), sec('2026-11-12T21:00:00Z'), true),
    );
  });

  it("before the open on a trading day, the last session is the previous day's and the reference is the one before it", () => {
    // Tuesday 13:00Z is before the 14:30Z open: the most recent session is Monday's, so the reference is Friday's close
    const r = ref('AAPL', '2026-11-10T13:00:00Z');
    expect(r?.at).toBe(sec('2026-11-06T21:00:00Z'));
    expect(r?.prevClose).toBe(
      simMid(SEED, inst('AAPL'), sec('2026-11-06T21:00:00Z'), { gaps: true }),
    );
  });

  it("across a holiday: on Friday after Thanksgiving the previous session is Wednesday's", () => {
    const r = ref('AAPL', '2026-11-27T15:00:00Z');
    expect(r?.at).toBe(sec('2026-11-25T21:00:00Z'));
    expect(r?.basis).toBe('PREV_SESSION_CLOSE');
  });

  it('crypto and the 24/7 stock session: the price 24 hours ago on the 60-second grid, basis ROLLING_24H', () => {
    expect(ref('BTC-USD', '2026-11-10T15:00:00Z')).toEqual({
      prevClose: '72095.74',
      basis: 'ROLLING_24H',
      at: 1794236400,
    });
    expect(iso(1794236400)).toBe('2026-11-09T15:00:00.000Z');
    const r = ref('BTC-USD', '2026-11-10T15:00:37Z');
    expect(r?.at).toBe(sec('2026-11-09T15:00:00Z')); // 14:59:37 yesterday, on the minute grid: floor(15:00:37 - 24h) = 15:00:00? no:
    const s = ref('AAPL', '2026-11-14T12:00:00Z', CONT);
    expect(s?.basis).toBe('ROLLING_24H');
    expect(s?.at).toBe(sec('2026-11-13T12:00:00Z'));
  });

  it('null, never 0, when there is no history that far back', () => {
    expect(ref('BTC-USD', '2026-01-01T12:00:00Z')).toBeNull(); // 24 h earlier is before 2026-01-01T00:00Z
    expect(ref('BTC-USD', '2026-01-02T00:00:00Z')?.at).toBe(SIM_HISTORY_START_SECONDS); // exactly 24 h of history: defined
    expect(ref('AAPL', '2026-01-02T15:00:00Z')).toBeNull(); // the first session of 2026: no session before it
    expect(ref('AAPL', '2026-01-05T15:00:00Z')?.at).toBe(sec('2026-01-02T21:00:00Z')); // the next trading day has one
    expect(ref('AAPL', '2025-06-01T15:00:00Z')).toBeNull();
  });
});

describe('dayChange (exact decimals, 2 dp half-even, one rounding)', () => {
  it.each([
    ['187.05', '190.00', '-2.95', '-1.55'], // -2.95 / 190 = -1.5526...
    ['190.00', '187.05', '2.95', '1.58'], // 2.95 / 187.05 = 1.5771...
    ['190.00', '190.00', '0.00', '0.00'], // zero change is 0.00, not blank
    ['200.01', '200.00', '0.01', '0.01'], // 0.005 % rounds half-even to 0.00? see next two rows: this one is 0.01/200 = 0.005
    ['200.03', '200.00', '0.03', '0.02'], // 0.015 -> half-even -> 0.02
    ['199.99', '200.00', '-0.01', '-0.01'], // -0.005
    ['1.00', '3.00', '-2.00', '-66.67'],
    ['0.10', '0.00', null, null],
    ['75460.00', '72095.74', '3364.26', '4.67'],
  ])('last %s vs prevClose %s: change %s, %s percent', (last, prev, change, pct) => {
    if (change === null) {
      expect(dayChange(last, prev)).toBeNull();
      return;
    }
    const r = dayChange(last, prev);
    expect(r?.change).toBe(change);
    // the half-even rows: 0.005 -> 0.00 (0 is even) and 0.015 -> 0.02 (2 is even)
    if (last === '200.01') expect(r?.changePct).toBe('0.00');
    else if (last === '199.99') expect(r?.changePct).toBe('0.00');
    else expect(r?.changePct).toBe(pct);
  });

  it('very small and very large values stay exact strings', () => {
    expect(dayChange('0.00001', '0.00001')).toEqual({ change: '0.00', changePct: '0.00' });
    expect(dayChange('0.19772', '0.19619')).toEqual({ change: '0.00153', changePct: '0.78' });
    expect(dayChange('99999999999.99', '1.00')?.changePct).toBe('9999999999899.00');
    expect(dayChange('1.00', '99999999999.99')?.changePct).toBe('-100.00');
  });

  it('matches an independent BigInt computation for random two-decimal prices', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        (lastC, prevC) => {
          const fmt = (c: number): string =>
            `${String(Math.floor(c / 100))}.${String(c % 100).padStart(2, '0')}`;
          const r = dayChange(fmt(lastC), fmt(prevC));
          // percent in hundredths = (last - prev) x 10000 / prev, rounded half to even (all in integer cents)
          const n = BigInt(lastC - prevC) * 10000n;
          const d = BigInt(prevC);
          let q = n / d;
          const rem = n % d;
          const twice = (rem < 0n ? -rem : rem) * 2n;
          if (twice > d || (twice === d && q % 2n !== 0n)) q += n < 0n ? -1n : 1n;
          const sign = q < 0n ? '-' : '';
          const abs = q < 0n ? -q : q;
          const expected = `${sign}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
          expect(r?.changePct).toBe(q === 0n ? '0.00' : expected);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('the candle universe parameters', () => {
  it('every instrument has a positive synthetic volume base and the right decimal places', () => {
    for (const c of SIM_UNIVERSE) {
      expect(c.volumeUnitsPerMinute, c.symbol).toBeGreaterThan(0);
      expect(c.volumeDp).toBe(c.assetClass === 'CRYPTO' ? 8 : 0);
    }
    expect(SIM_STOCKS.length + SIM_CRYPTO.length).toBe(SIM_UNIVERSE.length);
  });
  it('the largest possible candle volume stays inside safe integer arithmetic', () => {
    for (const c of SIM_UNIVERSE) {
      expect(c.volumeUnitsPerMinute * 1440 * 1.5, c.symbol).toBeLessThan(Number.MAX_SAFE_INTEGER);
    }
  });
});
