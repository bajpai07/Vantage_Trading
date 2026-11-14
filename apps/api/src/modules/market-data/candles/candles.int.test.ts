// GET /v1/market/candles end to end (M7b T2, T5): real Postgres, the real Nest app, the SIM candle provider. No network.
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { CANDLE_INTERVALS as CONTRACT_INTERVALS, CandlesResponse } from '@vantage/contracts';
import {
  CANDLE_INTERVALS,
  SIM_UNIVERSE,
  buildCandles,
  maxEvaluations,
} from '@vantage/market-model';
import { NYSE_CALENDAR_2026_2027 } from '@vantage/market-model/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from '../../../testing/harness.js';
import { createOrdersHarness, newUser } from '../../../testing/orders-kit.js';
import type { TestUser } from '../../../testing/orders-kit.js';
import { cookie } from '../../../testing/harness.js';
import { FeedInfoService } from '../../feed/feed.module.js';
import { CANDLE_CACHE_MAX_CANDLES, CandleService, candleCost } from './candle.service.js';

const TUESDAY = '2026-11-10T15:00:00.000Z'; // NYSE open (EST)
const SATURDAY = '2026-11-14T12:00:00.000Z';
const SIM_ENV = {
  MARKET_DATA_SOURCE: 'SIM',
  CRYPTO_FEED: 'sim',
  CANDLES_RATE_LIMIT_PER_MINUTE: '100000',
};
const sec = (iso: string): number => Date.parse(iso) / 1000;
/** Prints a measurement for the phase report (the lint rules ban console). */
const report = (text: string): void => {
  process.stdout.write(`
${text}
`);
};

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.dispose();
});

const url = (q: Record<string, string>): string =>
  `/v1/market/candles?${new URLSearchParams(q).toString()}`;
const get = (h: Harness, u: TestUser, q: Record<string, string>) =>
  h.http.get(url(q)).set('Cookie', cookie(u.token));

describe('the contract and the model agree on the intervals', () => {
  it('the same six intervals, in the same order', () => {
    expect([...CONTRACT_INTERVALS]).toEqual([...CANDLE_INTERVALS]);
  });
});

describe('happy paths, both session modes', () => {
  let h: Harness;
  let u: TestUser;
  beforeAll(async () => {
    h = await createOrdersHarness(db, { now: TUESDAY, env: SIM_ENV });
    u = await newUser(h, db);
  });
  afterAll(async () => {
    await h.close();
  });

  it('a stock on the NYSE session: the candles of a day, labelled SIM and synthetic, equal to the pure model', async () => {
    const res = await get(h, u, {
      symbol: 'AAPL',
      interval: '1h',
      from: '2026-11-09T00:00:00Z',
      to: '2026-11-10T13:59:59Z',
    });
    expect(res.status).toBe(200);
    const body = CandlesResponse.parse(res.body);
    expect(body).toMatchObject({
      symbol: 'AAPL',
      interval: '1h',
      source: 'SIM',
      synthetic: true,
      truncated: false,
    });
    // Monday's 7 hourly candles (14:00Z to 20:00Z, the first clipped to the 14:30Z open), nothing outside the session;
    // Tuesday's first candle has open time 14:00Z, after `to`: candles are selected by their open time
    expect(body.candles.map((c) => c.t.slice(0, 16))).toEqual([
      '2026-11-09T14:00',
      '2026-11-09T15:00',
      '2026-11-09T16:00',
      '2026-11-09T17:00',
      '2026-11-09T18:00',
      '2026-11-09T19:00',
      '2026-11-09T20:00',
    ]);
    expect(body.candles.every((c) => c.closed)).toBe(true);
    const cfg = SIM_UNIVERSE.find((c) => c.symbol === 'AAPL');
    if (cfg === undefined) throw new Error('config');
    const model = buildCandles({
      seed: h.config.simSeed,
      instrument: cfg,
      interval: '1h',
      from: sec('2026-11-09T00:00:00Z'),
      to: sec('2026-11-10T13:59:59Z'),
      limit: 200,
      now: sec(TUESDAY),
      sessions: { kind: 'CALENDAR', calendar: NYSE_CALENDAR_2026_2027 },
      gaps: true,
    });
    expect(body.candles.map((c) => [c.o, c.h, c.l, c.c, c.v])).toEqual(
      model.candles.map((c) => [c.o, c.h, c.l, c.c, c.v]),
    );
  });

  it('crypto: continuous, with 5 decimal places for DOGE and 8 for volume', async () => {
    h.clock.set('2026-11-10T16:00:00.000Z'); // after the 15:00 to 15:45 candles have closed
    const res = await get(h, u, {
      symbol: 'doge-usd',
      interval: '15m',
      from: '2026-11-10T15:00:00Z',
      to: '2026-11-10T15:30:00Z',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'DOGE-USD', source: 'SIM', synthetic: true });
    expect(res.body.candles).toEqual(
      [
        {
          t: '2026-11-10T15:00:00.000Z',
          o: '0.19619',
          h: '0.19774',
          l: '0.19540',
          c: '0.19746',
          v: '377150.00000000',
          closed: true,
        },
        {
          t: '2026-11-10T15:15:00.000Z',
          o: '0.19746',
          h: '0.19825',
          l: '0.19665',
          c: '0.19772',
          v: '384350.00000000',
          closed: true,
        },
        {
          t: '2026-11-10T15:30:00.000Z',
          o: '0.19772',
          h: '0.20200',
          l: '0.19772',
          c: '0.20200',
          v: '376400.00000000',
          closed: true,
        },
      ].slice(0, 3),
    );
    h.clock.set(TUESDAY);
  });

  it('without from/to: the latest `limit` candles ending now, the last one forming (closed:false), answer is no-store', async () => {
    const res = await get(h, u, { symbol: 'BTC-USD', interval: '1m', limit: '5' } as never);
    expect(res.status).toBe(200);
    expect(res.body.candles).toHaveLength(5);
    expect(res.body.candles.map((c: { closed: boolean }) => c.closed)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(res.body.candles[4].t).toBe(TUESDAY); // the candle that opened at 15:00:00Z, now
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
  });

  it('the NYSE session has no candles on a Saturday; the 24/7 session does (control, a second app)', async () => {
    const closed = await createOrdersHarness(db, { now: SATURDAY, env: SIM_ENV });
    const always = await createOrdersHarness(db, {
      now: SATURDAY,
      env: { ...SIM_ENV, SIM_SESSION: 'ALWAYS_OPEN' },
    });
    try {
      const a = await newUser(closed, db);
      const b = await newUser(always, db);
      const q = {
        symbol: 'AAPL',
        interval: '1h',
        from: '2026-11-14T00:00:00Z',
        to: '2026-11-14T12:00:00Z',
      };
      const none = await get(closed, a, q);
      expect(none.status).toBe(200);
      expect(none.body).toMatchObject({ candles: [], truncated: false, source: 'SIM' });
      const some = await get(always, b, q);
      expect(some.body.candles.map((c: { t: string }) => c.t.slice(11, 13))).toEqual([
        '00',
        '01',
        '02',
        '03',
        '04',
        '05',
        '06',
        '07',
        '08',
        '09',
        '10',
        '11',
        '12',
      ]);
      // crypto is the same in both
      const c1 = await get(closed, a, { ...q, symbol: 'BTC-USD' });
      const c2 = await get(always, b, { ...q, symbol: 'BTC-USD' });
      expect(c1.body.candles).toEqual(c2.body.candles);
      expect(c1.body.candles).toHaveLength(13);
    } finally {
      await closed.close();
      await always.close();
    }
  });

  it('truncation: more candles than the limit give the NEWEST ones and truncated:true; exactly the limit does not', async () => {
    const q = {
      symbol: 'BTC-USD',
      interval: '1h',
      from: '2026-11-10T00:00:00Z',
      to: '2026-11-10T14:00:00Z',
    };
    const all = await get(h, u, { ...q, limit: '500' });
    expect(all.body).toMatchObject({ truncated: false });
    expect(all.body.candles).toHaveLength(15);
    const few = await get(h, u, { ...q, limit: '4' });
    expect(few.body.truncated).toBe(true);
    expect(few.body.candles).toEqual(all.body.candles.slice(-4));
    const exact = await get(h, u, { ...q, limit: '15' });
    expect(exact.body.truncated).toBe(false);
    const dflt = await get(h, u, { symbol: 'BTC-USD', interval: '1m' });
    expect(dflt.body.candles).toHaveLength(200); // the default limit
    expect(dflt.body.truncated).toBe(true);
    const max = await get(h, u, { symbol: 'BTC-USD', interval: '1m', limit: '500' });
    expect(max.body.candles).toHaveLength(500);
  });
});

describe('validation and availability', () => {
  let h: Harness;
  let u: TestUser;
  beforeAll(async () => {
    h = await createOrdersHarness(db, { now: TUESDAY, env: SIM_ENV });
    u = await newUser(h, db);
  });
  afterAll(async () => {
    await h.close();
  });

  const bad: Array<[string, Record<string, string>]> = [
    ['an unknown interval', { symbol: 'AAPL', interval: '2m' }],
    ['no interval', { symbol: 'AAPL' }],
    ['no symbol', { interval: '1h' }],
    ['a malformed symbol', { symbol: '<script>', interval: '1h' }],
    [
      'from after to',
      { symbol: 'AAPL', interval: '1h', from: '2026-11-10T14:00:00Z', to: '2026-11-10T12:00:00Z' },
    ],
    ['a date that is not an ISO instant', { symbol: 'AAPL', interval: '1h', from: 'yesterday' }],
    ['a date without a zone', { symbol: 'AAPL', interval: '1h', to: '2026-11-10T12:00:00' }],
    ['limit 0', { symbol: 'AAPL', interval: '1h', limit: '0' }],
    ['limit 501 (above the maximum)', { symbol: 'AAPL', interval: '1h', limit: '501' }],
    ['limit that is not a number', { symbol: 'AAPL', interval: '1h', limit: 'many' }],
    ['a negative limit', { symbol: 'AAPL', interval: '1h', limit: '-5' }],
    ['an unknown parameter', { symbol: 'AAPL', interval: '1h', bogus: '1' }],
  ];
  it.each(bad)('400 for %s, in the standard error format', async (_n, q) => {
    const res = await get(h, u, q);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('control: the same request without the mistake is 200', async () => {
    expect((await get(h, u, { symbol: 'AAPL', interval: '1h', limit: '5' })).status).toBe(200);
    expect(
      (
        await get(h, u, {
          symbol: 'aapl',
          interval: '1h',
          limit: '500',
          from: '2026-11-10T12:00:00Z',
        })
      ).status,
    ).toBe(200);
  });

  it('404 INSTRUMENT_NOT_FOUND for an unknown symbol', async () => {
    const res = await get(h, u, { symbol: 'NOSUCH', interval: '1h' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INSTRUMENT_NOT_FOUND');
  });

  it('401 without a session', async () => {
    const res = await h.http.get(url({ symbol: 'AAPL', interval: '1h' }));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('crypto candles are unavailable while the crypto feed is off, with the SIM label never faked (control: on in the other app)', async () => {
    const off = await createOrdersHarness(db, {
      now: TUESDAY,
      env: { ...SIM_ENV, CRYPTO_FEED: 'off' },
    });
    try {
      const user = await newUser(off, db);
      const res = await get(off, user, { symbol: 'BTC-USD', interval: '1h' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CANDLES_UNAVAILABLE');
      expect((await get(off, user, { symbol: 'AAPL', interval: '1h' })).status).toBe(200);
    } finally {
      await off.close();
    }
    expect((await get(h, u, { symbol: 'BTC-USD', interval: '1h' })).status).toBe(200);
  });

  it('candles are unavailable when the source is not SIM (fixture mode), and when the feed kill switch is on', async () => {
    const fixture = await createOrdersHarness(db, { now: TUESDAY });
    try {
      const user = await newUser(fixture, db);
      const res = await get(fixture, user, { symbol: 'AAPL', interval: '1h' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CANDLES_UNAVAILABLE');
    } finally {
      await fixture.close();
    }
    const feed = h.app.get(FeedInfoService);
    feed.setEnabled(false);
    try {
      expect((await get(h, u, { symbol: 'AAPL', interval: '1h' })).status).toBe(404);
    } finally {
      feed.setEnabled(true);
    }
    expect((await get(h, u, { symbol: 'AAPL', interval: '1h' })).status).toBe(200);
  });

  it('is read-only: serving candles writes nothing (row counts of the money tables do not move)', async () => {
    const count = async (): Promise<string> =>
      JSON.stringify(
        (
          await db.migrator.query(
            `SELECT (SELECT count(*) FROM orders) AS o, (SELECT count(*) FROM executions) AS e,
                  (SELECT count(*) FROM ledger_transactions) AS t, (SELECT count(*) FROM equity_snapshots) AS s`,
          )
        ).rows,
      );
    const before = await count();
    for (const interval of CANDLE_INTERVALS)
      await get(h, u, { symbol: 'AAPL', interval, limit: '50' });
    expect(await count()).toBe(before);
  });
});

describe('caching: closed candles are immutable, the forming candle is not', () => {
  let h: Harness;
  let u: TestUser;
  beforeAll(async () => {
    h = await createOrdersHarness(db, { now: TUESDAY, env: SIM_ENV });
    u = await newUser(h, db);
  });
  afterAll(async () => {
    await h.close();
  });

  const past = {
    symbol: 'BTC-USD',
    interval: '1h',
    from: '2026-11-10T00:00:00Z',
    to: '2026-11-10T13:00:00Z',
  };

  it('a past, all-closed answer carries a strong ETag and a private max-age; If-None-Match gives 304 with no body', async () => {
    const a = await get(h, u, past);
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toBe('private, max-age=3600');
    expect(a.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/); // strong, not W/
    const b = await h.http
      .get(url(past))
      .set('Cookie', cookie(u.token))
      .set('If-None-Match', a.headers.etag as string);
    expect(b.status).toBe(304);
    expect(b.text).toBe('');
    expect(b.headers.etag).toBe(a.headers.etag);
    const c = await h.http
      .get(url(past))
      .set('Cookie', cookie(u.token))
      .set('If-None-Match', '"something-else"');
    expect(c.status).toBe(200); // control: a different tag is a full answer
    expect(c.text).toBe(a.text);
  });

  it('an answer that includes the forming candle is never cached or tagged (a range reaching now)', async () => {
    const res = await get(h, u, {
      symbol: 'BTC-USD',
      interval: '1h',
      from: '2026-11-10T13:00:00Z',
      to: TUESDAY,
    });
    expect(res.status).toBe(200);
    expect(res.body.candles.at(-1)).toMatchObject({ closed: false });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
  });

  it('immutability: the same closed candles requested at two different "now" are byte-identical, and the ETag is unchanged', async () => {
    const first = await get(h, u, past);
    h.clock.advance(3 * 86_400_000);
    const later = await get(h, u, past);
    expect(later.text).toBe(first.text);
    expect(later.headers.etag).toBe(first.headers.etag);
    // a candle that was forming has closed by then, and the earlier ones did not change
    h.clock.set(TUESDAY);
    const r1 = await get(h, u, { symbol: 'BTC-USD', interval: '1h', from: '2026-11-10T13:00:00Z' });
    h.clock.advance(65 * 60_000); // 16:05Z: the 15:00 candle has closed
    const r2 = await get(h, u, { symbol: 'BTC-USD', interval: '1h', from: '2026-11-10T13:00:00Z' });
    expect(r1.body.candles.map((c: { closed: boolean }) => c.closed)).toEqual([true, true, false]);
    expect(r2.body.candles.map((c: { closed: boolean }) => c.closed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(r2.body.candles.slice(0, 2)).toEqual(r1.body.candles.slice(0, 2)); // closed ones: identical
    expect(r2.body.candles[2].o).toBe(r1.body.candles[2].o); // the open of the formerly forming candle did not move
    expect(r2.body.candles[2].c).not.toBe(r1.body.candles[2].c); // its close was still moving
    h.clock.set(TUESDAY);
  });

  it('the forming candle changes as the injected clock advances while earlier candles do not', async () => {
    const at = async () =>
      (await get(h, u, { symbol: 'BTC-USD', interval: '5m', limit: '3' })).body.candles;
    h.clock.set('2026-11-10T15:12:00.000Z');
    const a = await at();
    h.clock.set('2026-11-10T15:13:30.000Z');
    const b = await at();
    expect(a.map((c: { t: string }) => c.t)).toEqual(b.map((c: { t: string }) => c.t));
    expect(a.slice(0, 2)).toEqual(b.slice(0, 2));
    expect(a[2].closed).toBe(false);
    expect(b[2].closed).toBe(false);
    expect(a[2].c).not.toBe(b[2].c);
    expect(Number(b[2].v)).toBeGreaterThan(Number(a[2].v));
    h.clock.set(TUESDAY);
  });
});

describe('rate limit (cost points per user)', () => {
  it('a maximum daily request costs 8 points: with an allowance of 20, two fit and the third is 429 with Retry-After; cheap requests keep fitting; another user is separate; the window moves on', async () => {
    expect(candleCost('1d', 500)).toBe(8);
    expect(candleCost('1m', 500)).toBe(1);
    expect(candleCost('1h', 500)).toBe(2);
    const h = await createOrdersHarness(db, {
      now: TUESDAY,
      env: { ...SIM_ENV, CANDLES_RATE_LIMIT_PER_MINUTE: '20' },
    });
    try {
      const u = await newUser(h, db);
      const other = await newUser(h, db);
      const big = { symbol: 'BTC-USD', interval: '1d', limit: '500' };
      expect((await get(h, u, big)).status).toBe(200); // 8
      expect((await get(h, u, big)).status).toBe(200); // 16
      const limited = await get(h, u, big); // 24 > 20
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect((await get(h, u, { symbol: 'BTC-USD', interval: '1m', limit: '10' })).status).toBe(
        200,
      ); // 17
      expect((await get(h, other, big)).status).toBe(200); // control: another user has their own allowance
      h.clock.advance(61_000);
      expect((await get(h, u, big)).status).toBe(200); // the window has moved on
    } finally {
      await h.close();
    }
  });
});

describe('bounded cost: a maximum-size request is a bounded amount of work', () => {
  const percentile = (xs: number[], p: number): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
  };

  it('every interval: the evaluations of a maximum request stay within the documented bound (measured through the service)', async () => {
    const h = await createOrdersHarness(db, { now: '2027-12-20T00:00:00.000Z', env: SIM_ENV });
    try {
      const service = h.app.get(CandleService);
      const rows: string[] = [];
      for (const interval of CANDLE_INTERVALS) {
        const t0 = process.hrtime.bigint();
        const r = await service.candles({
          symbol: 'BTC-USD',
          interval,
          to: '2027-12-18T00:00:00.000Z',
          limit: 500,
        });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        expect(r.body.candles).toHaveLength(500);
        expect(r.evaluations).toBeLessThanOrEqual(maxEvaluations(interval));
        expect(r.cacheHit).toBe(false);
        rows.push(
          `${interval}: ${String(r.evaluations)} evaluations (bound ${String(maxEvaluations(interval))}), ${ms.toFixed(0)} ms cold`,
        );
        const t1 = process.hrtime.bigint();
        const again = await service.candles({
          symbol: 'BTC-USD',
          interval,
          to: '2027-12-18T00:00:00.000Z',
          limit: 500,
        });
        expect(again.cacheHit).toBe(true);
        expect(again.body).toEqual(r.body);
        rows[rows.length - 1] +=
          `, ${(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(2)} ms cached`;
      }
      report(`M7B_COST_REPORT\n${rows.join('\n')}`);
    } finally {
      await h.close();
    }
  });

  it('100 parallel maximum-size HTTP requests: all succeed within the stated budget (p50, p95 reported; identical requests are served from the cache after the first)', async () => {
    const h = await createOrdersHarness(db, { now: '2027-12-20T00:00:00.000Z', env: SIM_ENV });
    try {
      const u = await newUser(h, db);
      const q = { symbol: 'BTC-USD', interval: '1d', limit: '500', to: '2027-12-18T00:00:00Z' };
      const t0 = Date.now();
      const times: number[] = [];
      const results = await Promise.all(
        Array.from({ length: 100 }, async () => {
          const s = Date.now();
          const res = await get(h, u, q);
          times.push(Date.now() - s);
          return res;
        }),
      );
      const total = Date.now() - t0;
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.text)).size).toBe(1);
      report(
        `M7B_PARALLEL_IDENTICAL total ${String(total)} ms, p50 ${String(percentile(times, 50))} ms, p95 ${String(percentile(times, 95))} ms`,
      );
      expect(total).toBeLessThan(30_000); // generous: one cold computation (about half a second) plus 99 cache hits
    } finally {
      await h.close();
    }
  });

  it('24 DISTINCT cold maximum-size daily requests (no cache help): each stays within a few seconds, and the cache stays bounded', async () => {
    const h = await createOrdersHarness(db, { now: '2027-12-20T00:00:00.000Z', env: SIM_ENV });
    try {
      const u = await newUser(h, db);
      const service = h.app.get(CandleService);
      const symbols = SIM_UNIVERSE.filter((c) => c.assetClass === 'CRYPTO').map((c) => c.symbol);
      const times: number[] = [];
      for (const symbol of symbols) {
        for (const day of ['2027-12-15', '2027-12-16', '2027-12-17', '2027-12-18']) {
          const s = Date.now();
          const res = await get(h, u, {
            symbol,
            interval: '1d',
            limit: '500',
            to: `${day}T00:00:00Z`,
          });
          times.push(Date.now() - s);
          expect(res.status).toBe(200);
        }
      }
      expect(times).toHaveLength(24);
      report(
        `M7B_COLD_DISTINCT n=24 p50 ${String(percentile(times, 50))} ms, p95 ${String(percentile(times, 95))} ms, max ${String(Math.max(...times))} ms`,
      );
      expect(Math.max(...times)).toBeLessThan(10_000);
      expect(service.cachedCandles()).toBeLessThanOrEqual(CANDLE_CACHE_MAX_CANDLES); // 24 x 500 = 12,000 candles held
    } finally {
      await h.close();
    }
  });

  it('the answer cache is bounded: filling it past its limit evicts the oldest, memory never grows past the cap', async () => {
    const h = await createOrdersHarness(db, { now: '2027-12-20T00:00:00.000Z', env: SIM_ENV });
    try {
      const service = h.app.get(CandleService);
      // 130 distinct 500-candle answers = 65,000 candles > the 60,000 cap
      for (let i = 0; i < 130; i += 1) {
        const to = new Date(Date.parse('2027-12-10T00:00:00Z') + i * 60_000).toISOString(); // 1m candles, shifted by a minute each
        await service.candles({ symbol: 'ETH-USD', interval: '1m', to, limit: 500 });
        expect(service.cachedCandles()).toBeLessThanOrEqual(CANDLE_CACHE_MAX_CANDLES);
      }
      expect(service.cachedCandles()).toBeGreaterThan(CANDLE_CACHE_MAX_CANDLES - 500);
    } finally {
      await h.close();
    }
  });
});
