import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildTestEnv } from '@vantage/config/testing';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDER } from '../../tokens.js';
import { cookie, createHarness, loginUser, registerUser } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import { FeedInfoService } from '../feed/feed.module.js';
import { FixtureForbiddenError, FixtureProvider } from './fixture/fixture.provider.js';
import { MarketRefresher, assertNoFixtureData } from './market.startup.js';
import { QuoteIngest } from './quote.ingest.js';

let db: TestDatabase;
let h: Harness;
let token: string;
/** Every /v1/quotes body seen, for the final "source and freshness on every quote" scan. */
const quoteBodies: Array<{ quotes: Array<Record<string, unknown>> }> = [];

const OPEN_TIME = '2026-11-10T15:00:00.000Z'; // Tuesday 10:00 EST: the market is open

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createHarness(db, {
    now: OPEN_TIME,
    // long idle window: this file jumps the clock around, and sessions must survive the small jumps
    env: { SESSION_IDLE_MINUTES: '10080', SESSION_ABSOLUTE_DAYS: '90' },
  });
  token = await registerUser(h, 'quotes@example.com');
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const refresher = (): MarketRefresher => h.app.get(MarketRefresher);
const ingest = (): QuoteIngest => h.app.get(QuoteIngest);

async function quotes(symbols: string, tok = token) {
  const res = await h.http.get('/v1/quotes').query({ symbols }).set('Cookie', cookie(tok));
  if (res.status === 200) quoteBodies.push(res.body as { quotes: Array<Record<string, unknown>> });
  return res;
}
const one = async (symbol: string) => {
  const res = await quotes(symbol);
  expect(res.status).toBe(200);
  return res.body.quotes[0] as Record<string, unknown>;
};
async function cookieAt(iso: string): Promise<string> {
  h.clock.set(iso);
  return loginUser(h, 'quotes@example.com');
}

describe('3a. freshness through the API (REAL_TIME is not reachable with the DELAYED fixture feed)', () => {
  it('startup ingested the fixture quotes: DELAYED, fully labelled, canonical string prices', async () => {
    const res = await quotes('AAPL,SPY');
    expect(res.status).toBe(200);
    expect(res.body.quotes).toEqual([
      {
        symbol: 'AAPL',
        known: true,
        freshness: 'DELAYED',
        source: 'FIXTURE',
        entitlement: 'DELAYED',
        delaySeconds: 900,
        ageSeconds: 900,
        asOf: '2026-11-10T14:45:00.000Z',
        bid: '11.11',
        ask: '11.13',
        spread: '0.02', // ask minus bid, computed by the server
        // the fixture feed has no candle source: the day change is null, never 0 (M7b, D-82)
        prevClose: null,
        change: null,
        changePct: null,
        changeBasis: null,
        changeOf: null,
        last: '11.11',
      },
      expect.objectContaining({
        symbol: 'SPY',
        freshness: 'DELAYED',
        bid: '277.75',
        ask: '277.77',
      }),
    ]);
    for (const q of res.body.quotes) {
      expect(typeof q.bid).toBe('string');
      expect(typeof q.ask).toBe('string');
    }
  });

  it('every one of the 32 fixture symbols is DELAYED and none is REAL_TIME', async () => {
    const all = (
      await db.migrator.query<{ symbol: string }>(
        `SELECT symbol FROM instruments WHERE asset_class <> 'CRYPTO' ORDER BY symbol`, // crypto is simulated (M7a), not fixture
      )
    ).rows.map((r) => r.symbol);
    const res = await quotes(all.join(','));
    expect(res.status).toBe(200);
    expect(res.body.quotes).toHaveLength(all.length);
    expect(new Set(res.body.quotes.map((q: { freshness: string }) => q.freshness))).toEqual(
      new Set(['DELAYED']),
    );
  });

  it('the DELAYED boundary is inclusive at delay + 60 s, and one millisecond later it is STALE', async () => {
    h.clock.advance(60_000); // age 960 s = declared delay 900 s + 60 s
    expect(await one('AAPL')).toMatchObject({ freshness: 'DELAYED', ageSeconds: 960 });
    h.clock.advance(1);
    expect(await one('AAPL')).toMatchObject({ freshness: 'STALE', ageSeconds: 960, bid: '11.11' }); // control for later
    h.clock.set(OPEN_TIME);
    expect(await one('AAPL')).toMatchObject({ freshness: 'DELAYED' });
  });

  it('STALE keeps the old price and labels it (not hidden, not refreshed)', async () => {
    h.clock.advance(10 * 60_000);
    const q = await one('MSFT');
    expect(q).toMatchObject({
      freshness: 'STALE',
      source: 'FIXTURE',
      ageSeconds: 1500,
      bid: '22.22',
    });
    h.clock.set(OPEN_TIME);
  });

  it('CLOSED after the close: the quote is the last close, labelled CLOSED', async () => {
    h.clock.set('2026-11-10T22:00:00.000Z'); // 17:00 EST, after the 16:00 close
    const q = await one('AAPL');
    expect(q).toMatchObject({ freshness: 'CLOSED', source: 'FIXTURE', bid: '11.11', ask: '11.13' });
    expect(q.ageSeconds).toBe(26_100); // 14:45Z to 22:00Z
    h.clock.set(OPEN_TIME);
  });

  it('CLOSED on a weekend and on a holiday (Thanksgiving); an old quote on an open day is STALE', async () => {
    const sat = await cookieAt('2026-11-14T15:00:00.000Z');
    expect((await quotes('AAPL', sat)).body.quotes[0].freshness).toBe('CLOSED');
    const holiday = await cookieAt('2026-11-26T15:00:00.000Z');
    expect((await quotes('AAPL', holiday)).body.quotes[0].freshness).toBe('CLOSED');
    const reopened = await cookieAt('2026-11-27T15:00:00.000Z'); // early-close Friday, open
    expect((await quotes('AAPL', reopened)).body.quotes[0].freshness).toBe('STALE'); // old quote, open market
    h.clock.set(OPEN_TIME); // never refresh into the future: later quotes must not look out of order
  });
});

describe('3b. UNAVAILABLE: no price, ever', () => {
  const noPrice = (q: Record<string, unknown>) => {
    expect(q.freshness).toBe('UNAVAILABLE');
    expect('bid' in q).toBe(false);
    expect('ask' in q).toBe(false);
    expect('last' in q).toBe(false);
    expect(q.asOf).toBeNull();
    expect(q.ageSeconds).toBeNull();
    expect(q.source).toBe('FIXTURE'); // still labelled
  };

  it('an unknown symbol is reported (not dropped) as UNAVAILABLE with no price (control: AAPL has one)', async () => {
    const res = await quotes('ZZZZ,AAPL');
    expect(res.body.quotes.map((q: { symbol: string }) => q.symbol)).toEqual(['ZZZZ', 'AAPL']);
    noPrice(res.body.quotes[0]);
    expect(res.body.quotes[0].known).toBe(false);
    expect(res.body.quotes[1].bid).toBe('11.11');
  });

  it('a known instrument that was never quoted is UNAVAILABLE with no price', async () => {
    const exch = await db.migrator.query<{ id: string }>(
      `SELECT id FROM exchanges WHERE code = 'XNYS'`,
    );
    await db.migrator.query(
      `INSERT INTO instruments (id, symbol, name, asset_class, exchange_id, quote_currency, tick_size, qty_step, min_qty, attrs)
       VALUES ($1::uuid, 'NOQT', 'Never Quoted Test Corp', 'EQUITY', $2::uuid, 'USD', 0.01, 1, 1, '{"source":"SYNTHETIC"}')`,
      [randomUUID(), exch.rows[0]?.id],
    );
    const q = await one('NOQT');
    noPrice(q);
    expect(q.known).toBe(true);
  });

  it('a DELISTED instrument is UNAVAILABLE even though a quote is stored (control: ACTIVE shows it)', async () => {
    expect(await one('KO')).toMatchObject({ freshness: 'DELAYED' });
    await db.migrator.query(`UPDATE instruments SET status = 'DELISTED' WHERE symbol = 'KO'`);
    noPrice(await one('KO'));
    await db.migrator.query(`UPDATE instruments SET status = 'ACTIVE' WHERE symbol = 'KO'`);
    expect(await one('KO')).toMatchObject({ freshness: 'DELAYED' });
  });

  it('a kill switch makes every quote UNAVAILABLE (control: enabling it again restores them)', async () => {
    const feed = h.app.get(FeedInfoService);
    feed.setEnabled(false);
    for (const q of (await quotes('AAPL,MSFT')).body.quotes) noPrice(q);
    feed.setEnabled(true);
    expect(await one('AAPL')).toMatchObject({ freshness: 'DELAYED' });
  });
});

describe('3c. validation: bad quotes are rejected and counted, never silently fixed', () => {
  it('crossed, future-dated, out-of-order, negative-size and non-positive quotes are rejected; the stored quote is untouched', async () => {
    h.clock.set(OPEN_TIME);
    await refresher().refresh(); // fresh baseline at this instant
    const provider = h.app.get<FixtureProvider>(PROVIDER);
    const before = ingest().counters('FIXTURE');
    const beforeBid = (await one('GOOGL')).bid;

    const cases: Array<[string, Parameters<FixtureProvider['script']>[1][number]]> = [
      ['CROSSED', { kind: 'crossed' }],
      ['FUTURE_TIMESTAMP', { kind: 'future', seconds: 10 }],
      ['OUT_OF_ORDER', { kind: 'out_of_order', seconds: 300 }],
      ['NEGATIVE_SIZE', { kind: 'negative_size' }],
      ['NON_POSITIVE_PRICE', { kind: 'non_positive' }],
    ];
    for (const [reason, step] of cases) {
      provider.script('GOOGL', [step]);
      const r = await refresher().refresh();
      const after = ingest().counters('FIXTURE');
      expect(after.rejected[reason as keyof typeof after.rejected], reason).toBe(
        (before.rejected[reason as keyof typeof before.rejected] ?? 0) + 1,
      );
      expect(r.accepted, reason).toBe(r.received - 1); // exactly the scripted quote was refused
      expect((await one('GOOGL')).bid, reason).toBe(beforeBid); // nothing was "fixed" or overwritten
    }
    const after = ingest().counters('FIXTURE');
    expect(after.outOfOrder).toBe(before.outOfOrder + 1);
    expect(after.accepted).toBeGreaterThan(before.accepted); // the other symbols were accepted each pass
  });

  it('an unconfirmed outlier is held and discarded (the next normal tick is accepted without the flag)', async () => {
    const provider = h.app.get<FixtureProvider>(PROVIDER);
    const before = ingest().counters('FIXTURE').rejected.OUTLIER_UNCONFIRMED ?? 0;
    provider.script('MSFT', [{ kind: 'outlier', factor: '1.5' }, { kind: 'normal' }]);
    await refresher().refresh();
    expect(ingest().counters('FIXTURE').rejected.OUTLIER_UNCONFIRMED).toBe(before + 1);
    expect((await one('MSFT')).bid).toBe('22.22'); // the outlier price never appeared
    await refresher().refresh();
    const q = await one('MSFT');
    expect(q.bid).toBe('22.22');
    expect('gapConfirmed' in q).toBe(false);
  });

  it('an outlier confirmed by a second consecutive tick is accepted with gapConfirmed', async () => {
    const provider = h.app.get<FixtureProvider>(PROVIDER);
    provider.script('AAPL', [
      { kind: 'outlier', factor: '1.5' },
      { kind: 'outlier', factor: '1.5' },
    ]);
    await refresher().refresh();
    expect((await one('AAPL')).bid).toBe('11.11'); // held, not shown
    await refresher().refresh();
    expect(await one('AAPL')).toMatchObject({
      bid: '16.66',
      ask: '16.68',
      gapConfirmed: true,
      freshness: 'DELAYED',
    });
  });

  it('marks the feed DEGRADED when more than 1% of recent quotes were rejected, and HEALTHY after the window', async () => {
    expect(ingest().feedStatus('FIXTURE')).toBe('DEGRADED'); // the rejections above are inside the 5-minute window
    h.clock.advance(5 * 60_000 + 1000);
    expect(ingest().feedStatus('FIXTURE')).toBe('HEALTHY');
    h.clock.set(OPEN_TIME);
  });
});

describe('3d. the quotes endpoint itself', () => {
  it('rejects bad input: none, empty, a bad symbol, 51 symbols, extra parameters (control: 50 is fine)', async () => {
    const g = (path: string, tok: string | null = token) =>
      tok === null ? h.http.get(path) : h.http.get(path).set('Cookie', cookie(tok));
    expect((await g('/v1/quotes')).status).toBe(400);
    expect((await g('/v1/quotes?symbols=')).status).toBe(400);
    expect((await g('/v1/quotes?symbols=A%20B')).status).toBe(400);
    expect((await g('/v1/quotes?symbols=AAPL&extra=1')).status).toBe(400);
    const many = Array.from({ length: 51 }, (_x, i) => `S${String(i)}`).join(',');
    expect((await g(`/v1/quotes?symbols=${many}`)).status).toBe(400);
    const fifty = Array.from({ length: 50 }, (_x, i) => `S${String(i)}`).join(',');
    const ok = await g(`/v1/quotes?symbols=${fifty}`);
    expect(ok.status).toBe(200);
    expect(ok.body.quotes).toHaveLength(50); // 50 unknown symbols, each reported
    expect((await g('/v1/quotes?symbols=AAPL', null)).status).toBe(401);
  });

  it('upper-cases, de-duplicates and keeps the request order', async () => {
    const res = await quotes('msft,AAPL,msft');
    expect(res.body.quotes.map((q: { symbol: string }) => q.symbol)).toEqual(['MSFT', 'AAPL']);
  });
});

describe('5. market status API (hand-checked instants, verified 2026-2027 calendar)', () => {
  const status = async (iso: string) => {
    const tok = await cookieAt(iso);
    const res = await h.http.get('/v1/market/status').set('Cookie', cookie(tok));
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe(iso);
    return res.body.exchanges as Array<Record<string, unknown>>;
  };
  const all = (xs: Array<Record<string, unknown>>, expected: Record<string, unknown>) => {
    // M7a: the simulated crypto market is listed too, and never closes (D-74); the US exchanges follow the calendar
    expect(xs.map((x) => x.exchange)).toEqual(['ARCX', 'CRYPTO', 'XNAS', 'XNYS']);
    expect(xs.find((x) => x.exchange === 'CRYPTO')).toMatchObject({
      state: 'OPEN',
      session: 'REGULAR',
      note: 'Open 24/7',
      nextOpen: null,
      nextClose: null,
    });
    for (const x of xs.filter((e) => e.exchange !== 'CRYPTO')) expect(x).toMatchObject(expected);
  };

  it('a normal open day: OPEN, REGULAR, closes 21:00Z, next open tomorrow 14:30Z', async () => {
    all(await status('2026-11-10T15:00:00.000Z'), {
      state: 'OPEN',
      session: 'REGULAR',
      reason: null,
      nextClose: '2026-11-10T21:00:00.000Z',
      nextOpen: '2026-11-11T14:30:00.000Z',
    });
  });
  it('a weekend and a holiday', async () => {
    all(await status('2026-11-14T15:00:00.000Z'), {
      state: 'CLOSED',
      reason: 'WEEKEND',
      nextOpen: '2026-11-16T14:30:00.000Z',
    });
    all(await status('2026-11-26T15:00:00.000Z'), {
      state: 'CLOSED',
      reason: 'HOLIDAY',
      note: 'Thanksgiving Day',
      nextOpen: '2026-11-27T14:30:00.000Z',
      nextClose: '2026-11-27T18:00:00.000Z',
    });
  });
  it('the early close day: open until 18:00Z, then closed', async () => {
    all(await status('2026-11-27T17:59:59.000Z'), {
      state: 'OPEN',
      session: 'EARLY_CLOSE',
      nextClose: '2026-11-27T18:00:00.000Z',
    });
    all(await status('2026-11-27T18:00:00.000Z'), {
      state: 'CLOSED',
      reason: 'AFTER_CLOSE',
      nextOpen: '2026-11-30T14:30:00.000Z',
    });
  });
  it('daylight-saving days: March 2026 (EST to EDT) and November 2026 (EDT to EST)', async () => {
    all(await status('2026-03-06T14:29:59.000Z'), { state: 'CLOSED', reason: 'BEFORE_OPEN' });
    all(await status('2026-03-06T14:30:00.000Z'), { state: 'OPEN' });
    all(await status('2026-03-09T13:29:59.000Z'), { state: 'CLOSED', reason: 'BEFORE_OPEN' });
    all(await status('2026-03-09T13:30:00.000Z'), { state: 'OPEN' });
    all(await status('2026-10-30T13:30:00.000Z'), { state: 'OPEN' });
    all(await status('2026-11-02T14:29:59.000Z'), { state: 'CLOSED', reason: 'BEFORE_OPEN' });
    all(await status('2026-11-02T14:30:00.000Z'), { state: 'OPEN' });
  });
  it('outside the loaded calendar the answer is "not covered", never a guess', async () => {
    all(await status('2028-01-03T16:00:00.000Z'), {
      state: 'CLOSED',
      reason: 'CALENDAR_NOT_COVERED',
      nextOpen: null,
    });
  });
  it('requires a session', async () => {
    expect((await h.http.get('/v1/market/status')).status).toBe(401);
  });
});

describe('4. FIXTURE guards', () => {
  const clock = { now: () => new Date('2026-11-10T15:00:00Z') };

  it('FixtureProvider cannot be constructed in staging or production (control: local and test work)', () => {
    expect(() => new FixtureProvider({ appEnv: 'production', clock })).toThrow(
      FixtureForbiddenError,
    );
    expect(() => new FixtureProvider({ appEnv: 'staging', clock })).toThrow(FixtureForbiddenError);
    expect(new FixtureProvider({ appEnv: 'local', clock }).id).toBe('FIXTURE');
    expect(new FixtureProvider({ appEnv: 'test', clock }).id).toBe('FIXTURE');
  });

  it('assertNoFixtureData: refuses fixture instruments or a FIXTURE source in staging/production only', () => {
    const base = { marketDataSource: 'PROVIDER', fixtureInstruments: false };
    expect(() =>
      assertNoFixtureData({ appEnv: 'staging', ...base, fixtureInstruments: true }),
    ).toThrow(/FIXTURE instruments/);
    expect(() =>
      assertNoFixtureData({ appEnv: 'production', ...base, fixtureInstruments: true }),
    ).toThrow(/FIXTURE instruments/);
    expect(() =>
      assertNoFixtureData({
        appEnv: 'production',
        marketDataSource: 'FIXTURE',
        fixtureInstruments: false,
      }),
    ).toThrow(/FIXTURE quote source/);
    expect(() => assertNoFixtureData({ appEnv: 'staging', ...base })).not.toThrow(); // clean staging
    expect(() =>
      assertNoFixtureData({
        appEnv: 'local',
        marketDataSource: 'FIXTURE',
        fixtureInstruments: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertNoFixtureData({
        appEnv: 'test',
        marketDataSource: 'FIXTURE',
        fixtureInstruments: true,
      }),
    ).not.toThrow();
  });

  it('booting with MARKET_DATA_SOURCE=PROVIDER exits with the clear error (control: --check with FIXTURE exits 0)', () => {
    const main = fileURLToPath(new URL('../../main.ts', import.meta.url));
    const run = (env: Record<string, string>, args: string[]) =>
      spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', main, ...args], {
        env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env },
        encoding: 'utf8',
      });
    const provider = run(
      buildTestEnv({ APP_ENV: 'local', MARKET_DATA_SOURCE: 'PROVIDER' }) as Record<string, string>,
      [],
    );
    expect(provider.status).toBe(2);
    expect(provider.stderr).toContain('no provider adapter installed; M3b');
    const fixtureCheck = run(
      buildTestEnv({ APP_ENV: 'local', MARKET_DATA_SOURCE: 'FIXTURE' }) as Record<string, string>,
      ['--check'],
    );
    expect(fixtureCheck.status).toBe(0);
  });

  it('the app itself refuses PROVIDER mode at startup with the same message', async () => {
    await expect(createHarness(db, { env: { MARKET_DATA_SOURCE: 'PROVIDER' } })).rejects.toThrow(
      'no provider adapter installed; M3b',
    );
  });

  it('the startup guard refuses to boot in staging when a fixture instrument exists', async () => {
    const staging = {
      APP_ENV: 'staging',
      MARKET_DATA_SOURCE: 'PROVIDER',
      COOKIE_SECURE: 'true',
      TRADING_ENABLED: 'true',
    };
    // this database holds FIXTURE instruments (synced by the first harness)
    await expect(createHarness(db, { env: staging })).rejects.toThrow(/FIXTURE instruments/);
    // control: a clean database passes the guard and then stops only because no provider adapter exists yet
    const clean = await createTestDatabase();
    try {
      await expect(createHarness(clean, { env: staging })).rejects.toThrow(
        'no provider adapter installed; M3b',
      );
    } finally {
      await clean.dispose();
    }
  });

  it('local and test boot normally with the fixture provider (control)', async () => {
    const local = await createHarness(db, { env: { APP_ENV: 'local' } });
    await local.close();
    expect(h.app).toBeDefined(); // the main harness of this file is APP_ENV=test and is serving
  });
});

describe('7. safety: every quote carries source and freshness', () => {
  it('scans every /v1/quotes response of this file', () => {
    expect(quoteBodies.length).toBeGreaterThan(15);
    let items = 0;
    for (const body of quoteBodies) {
      for (const q of body.quotes) {
        items += 1;
        expect(typeof q.source).toBe('string');
        expect(q.source).not.toBe('');
        expect(['REAL_TIME', 'DELAYED', 'STALE', 'CLOSED', 'UNAVAILABLE']).toContain(q.freshness);
        if (q.freshness === 'UNAVAILABLE')
          expect('bid' in q || 'ask' in q || 'last' in q).toBe(false);
        if ('bid' in q) expect(typeof q.bid).toBe('string');
      }
    }
    expect(items).toBeGreaterThan(50);
  });
});
