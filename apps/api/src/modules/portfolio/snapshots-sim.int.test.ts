// The equity-curve catch-up for the simulated feed (M7b T4, D-83): real Postgres, injected clock, orders through the API.
// Calendar facts (NYSE, EST = UTC-5 in November, EDT = UTC-4 from 2026-03-08): the regular close is 16:00 local = 21:00Z in
// winter and 20:00Z in summer time; Thanksgiving Thu 2026-11-26 is a holiday; Fri 2026-11-27 closes early at 13:00 = 18:00Z.
// Expected prices are computed independently in the test from the PURE functions (daily candle closes, the price function).
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { SIM_UNIVERSE, buildCandles, simMid } from '@vantage/market-model';
import { NYSE_CALENDAR_2026_2027 } from '@vantage/market-model/testing';
import { parse } from '@vantage/money';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUOTE_STORE } from '../../tokens.js';
import { loginUser } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import {
  createOrdersHarness,
  getAs,
  newKey,
  newUser,
  placeOrder,
} from '../../testing/orders-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import type { InMemoryQuoteStore } from '../market-data/quote.store.js';
import { SnapshotService } from './snapshot.service.js';

const sec = (iso: string): number => Date.parse(iso) / 1000;
const SIM_ENV = {
  MARKET_DATA_SOURCE: 'SIM',
  CRYPTO_FEED: 'sim',
  SESSION_IDLE_MINUTES: '10080',
  SESSION_ABSOLUTE_DAYS: '90',
};

let db: TestDatabase;
// a fresh database for every test: the job catches up every account of its database
beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(async () => {
  await db.dispose();
});

interface Row {
  date: string;
  cash: string;
  positionsValue: string;
  equity: string;
  complete: boolean;
  asOf: string | null;
  markSource: string | null;
}
async function snapshots(accountId: string): Promise<Row[]> {
  const r = await db.migrator.query(
    `SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS d, cash, positions_value, equity, valued_complete,
            to_char(quote_asof AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS asof, mark_source
       FROM equity_snapshots WHERE account_id = $1::uuid ORDER BY snapshot_date`,
    [accountId],
  );
  return r.rows.map((x) => ({
    date: x.d as string,
    cash: parse(String(x.cash)).toString(),
    positionsValue: parse(String(x.positions_value)).toString(),
    equity: parse(String(x.equity)).toString(),
    complete: x.valued_complete as boolean,
    asOf: (x.asof as string | null) ?? null,
    markSource: (x.mark_source as string | null) ?? null,
  }));
}

const instrument = (symbol: string) => {
  const c = SIM_UNIVERSE.find((x) => x.symbol === symbol);
  if (c === undefined) throw new Error(`no ${symbol}`);
  return c;
};

/** The daily candle close of a session date, from the pure candle model (independent of the snapshot code path). */
function dailyClose(h: Harness, symbol: string, date: string): string {
  const r = buildCandles({
    seed: h.config.simSeed,
    instrument: instrument(symbol),
    interval: '1d',
    from: sec(`${date}T00:00:00Z`),
    to: sec(`${date}T23:59:59Z`),
    limit: 1,
    now: sec('2027-01-01T00:00:00Z'),
    sessions: { kind: 'CALENDAR', calendar: NYSE_CALENDAR_2026_2027 },
    gaps: true,
  });
  const c = r.candles[0];
  if (c === undefined) throw new Error(`no daily candle for ${symbol} on ${date}`);
  return c.c;
}

/** Buys `qty` of `symbol` at the current quote through the real order API; returns the account id and the cash left. */
async function buy(h: Harness, symbol: string, qty: string) {
  const u = await newUser(h, db);
  // accounts.created_at is the real wall clock; the job compares it with the injected clock, so put it where the
  // harness clock is (the existing snapshot tests do the same)
  await db.migrator.query(`UPDATE accounts SET created_at = $2::timestamptz WHERE id = $1::uuid`, [
    u.accountId,
    h.clock.now(),
  ]);
  const q = await getAs(h, u, `/v1/quotes?symbols=${symbol}`);
  const res = await placeOrder(h, u, newKey(), {
    symbol,
    side: 'BUY',
    type: 'MARKET',
    qty,
    referencePrice: q.body.quotes[0].ask,
  });
  expect(res.body, JSON.stringify(res.body)).toMatchObject({ status: 'FILLED' });
  const cash = await db.migrator.query<{ balance: string }>(
    `SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'CASH' AND currency = 'USD'`,
    [u.accountId],
  );
  return { user: u, cash: parse(String(cash.rows[0]?.balance)).toString() };
}

describe("SIM: five missed sessions are caught up with complete snapshots at that day's close", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createOrdersHarness(db, { now: '2026-11-23T15:00:00.000Z', env: SIM_ENV });
  });
  afterEach(async () => {
    await h.close();
  });

  it('held 10 AAPL while the app was down for 5 sessions (a holiday and an early close inside): 5 complete snapshots, exact same-date closes', async () => {
    const { user, cash } = await buy(h, 'AAPL', '10');
    const job = h.app.get(SnapshotService);

    // Monday 2026-11-23 close (21:00Z): the first run writes only the latest closed session
    h.clock.set('2026-11-23T21:01:00.000Z');
    expect((await job.runDue(h.clock.now())).written).toBe(1);

    // the app is "down"; the quote store holds only an old quote. Even with no stored quote at all the catch-up is complete.
    await h.app
      .get<InMemoryQuoteStore>(QUOTE_STORE)
      .set('AAPL', { lastAccepted: null, pending: null });
    h.clock.set('2026-12-01T21:01:00.000Z'); // Tue 12-01 after the close
    const run = await job.runDue(h.clock.now());
    expect(run).toMatchObject({ lastClosedSession: '2026-12-01', written: 5, incomplete: 0 });

    const rows = await snapshots(user.accountId);
    // Mon 11-23 (the first run) then Tue 24, Wed 25, (Thu 26 Thanksgiving: none), Fri 27 early close, Mon 30, Tue 12-01
    expect(rows.map((r) => r.date)).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
      '2026-11-30',
      '2026-12-01',
    ]);
    const closeInstant: Record<string, string> = {
      '2026-11-23': '2026-11-23T21:00:00.000Z',
      '2026-11-24': '2026-11-24T21:00:00.000Z',
      '2026-11-25': '2026-11-25T21:00:00.000Z',
      '2026-11-27': '2026-11-27T18:00:00.000Z', // the early close: 13:00 EST
      '2026-11-30': '2026-11-30T21:00:00.000Z',
      '2026-12-01': '2026-12-01T21:00:00.000Z',
    };
    const prices: string[] = [];
    for (const r of rows) {
      const price = dailyClose(h, 'AAPL', r.date); // the pure daily candle close of THAT date
      prices.push(price);
      const value = parse('10').mul(parse(price));
      expect(r.complete, r.date).toBe(true);
      expect(r.markSource, r.date).toBe('SIM_CANDLE');
      expect(r.asOf, r.date).toBe(closeInstant[r.date]);
      expect(r.cash, r.date).toBe(cash);
      expect(r.positionsValue, r.date).toBe(value.toString());
      expect(r.equity, r.date).toBe(parse(cash).add(value).toString());
      // the price at that session's close, evaluated directly (a second independent path)
      expect(price).toBe(
        simMid(h.config.simSeed, instrument('AAPL'), sec(closeInstant[r.date] as string), {
          gaps: true,
        }),
      );
    }
    // no snapshot uses a later price: the six dates have six different closes (so a "latest price" would show up)
    expect(new Set(prices).size).toBe(6);
    // control: a day's mark is not the next session's close
    expect(rows[1]?.positionsValue).not.toBe(
      parse('10')
        .mul(parse(prices[2] as string))
        .toString(),
    );

    // idempotent: running again writes nothing and changes nothing
    const before = JSON.stringify(rows);
    expect((await job.runDue(h.clock.now())).written).toBe(0);
    expect(JSON.stringify(await snapshots(user.accountId))).toBe(before);

    // the history endpoint says where the marks came from
    // (the session went idle during the eight days: sign in again)
    const fresh = { token: await loginUser(h, user.email) };
    const history = await getAs(h, fresh, '/v1/portfolio/history?from=2026-11-23&to=2026-12-01');
    expect(history.body.snapshots).toHaveLength(6);
    for (const s of history.body.snapshots)
      expect(s).toMatchObject({ valuedComplete: true, markSource: 'SIM_CANDLE' });
    expect(history.body.snapshots[5].quoteAsOf).toBe('2026-12-01T21:00:00.000Z');

    // the books still reconcile with zero tolerance
    expect(await reconcileAccount(db.app, user.accountId)).toEqual([]);
  });

  it('weekend days have no snapshot (the snapshot day is the NYSE trading day, D-62), and a Monday snapshot is valued at the Monday close', async () => {
    const { user } = await buy(h, 'MSFT', '2');
    const job = h.app.get(SnapshotService);
    h.clock.set('2026-12-04T21:01:00.000Z'); // Friday 12-04
    await job.runDue(h.clock.now());
    h.clock.set('2026-12-07T21:01:00.000Z'); // Monday 12-07, after a weekend
    await job.runDue(h.clock.now());
    const rows = await snapshots(user.accountId);
    expect(rows.map((r) => r.date)).toEqual(['2026-12-04', '2026-12-07']); // not 12-05 or 12-06
    for (const r of rows) {
      expect(r.positionsValue).toBe(
        parse('2')
          .mul(parse(dailyClose(h, 'MSFT', r.date)))
          .toString(),
      );
    }
    expect(rows[0]?.positionsValue).not.toBe(rows[1]?.positionsValue);
  });
});

describe('control: a source that is not SIM keeps the M5 honesty rule (missing marks are incomplete, never invented)', () => {
  it('fixture feed: the same five missed sessions are INCOMPLETE (no stored quote of those days), valued at nothing, with no mark source', async () => {
    const h = await createOrdersHarness(db, {
      now: '2026-11-23T15:00:00.000Z',
      env: { SESSION_IDLE_MINUTES: '10080', SESSION_ABSOLUTE_DAYS: '90' },
    });
    try {
      const { user } = await buy(h, 'AAPL', '10');
      const job = h.app.get(SnapshotService);
      h.clock.set('2026-11-23T21:01:00.000Z');
      await job.runDue(h.clock.now());
      h.clock.set('2026-12-01T21:01:00.000Z');
      const run = await job.runDue(h.clock.now());
      expect(run).toMatchObject({ written: 5, incomplete: 5 });
      const rows = await snapshots(user.accountId);
      expect(rows).toHaveLength(6);
      expect(rows[0]).toMatchObject({ date: '2026-11-23', complete: true, markSource: null }); // Monday had a stored quote of that day
      for (const r of rows.slice(1)) {
        expect(r, r.date).toMatchObject({
          complete: false,
          positionsValue: '0',
          markSource: null,
          asOf: null,
        });
      }
    } finally {
      await h.close();
    }
  });
});

describe('crypto-only accounts (display-only until M8; the instrument is opened for this test only)', () => {
  it("held across a weekend: Friday and Monday snapshots valued at the price at that session's close; no Saturday or Sunday snapshot", async () => {
    const h = await createOrdersHarness(db, { now: '2026-11-13T15:00:00.000Z', env: SIM_ENV });
    try {
      await db.migrator.query(
        `UPDATE instruments SET tradable_in = '{MVP}' WHERE symbol = 'DOGE-USD'`,
      );
      const { user, cash } = await buy(h, 'DOGE-USD', '1000');
      const job = h.app.get(SnapshotService);
      h.clock.set('2026-11-13T21:01:00.000Z');
      await job.runDue(h.clock.now());
      h.clock.set('2026-11-16T21:01:00.000Z'); // Monday after the weekend
      await job.runDue(h.clock.now());
      const rows = await snapshots(user.accountId);
      expect(rows.map((r) => r.date)).toEqual(['2026-11-13', '2026-11-16']);
      const doge = instrument('DOGE-USD');
      const priceAt = (iso: string) => simMid(h.config.simSeed, doge, sec(iso), { gaps: false });
      const expected = [
        parse('1000').mul(parse(priceAt('2026-11-13T21:00:00Z'))),
        parse('1000').mul(parse(priceAt('2026-11-16T21:00:00Z'))),
      ];
      expect(rows.map((r) => r.positionsValue)).toEqual(expected.map((e) => e.toString()));
      expect(rows[0]?.positionsValue).not.toBe(rows[1]?.positionsValue); // Monday's price, not Friday's carried over
      for (const [i, r] of rows.entries()) {
        expect(r).toMatchObject({ complete: true, markSource: 'SIM_CANDLE', cash });
        expect(r.equity).toBe(
          parse(cash)
            .add(expected[i] as ReturnType<typeof parse>)
            .toString(),
        );
      }
      expect(rows.map((r) => r.asOf)).toEqual([
        '2026-11-13T21:00:00.000Z',
        '2026-11-16T21:00:00.000Z',
      ]);
      expect(await reconcileAccount(db.app, user.accountId)).toEqual([]);
    } finally {
      await db.migrator.query(
        `UPDATE instruments SET tradable_in = '{}' WHERE symbol = 'DOGE-USD'`,
      );
      await h.close();
    }
  });

  it('with the crypto feed off there is no candle price, so the day is INCOMPLETE rather than guessed', async () => {
    const on = await createOrdersHarness(db, { now: '2026-11-20T15:00:00.000Z', env: SIM_ENV });
    let accountId = '';
    try {
      await db.migrator.query(
        `UPDATE instruments SET tradable_in = '{MVP}' WHERE symbol = 'DOGE-USD'`,
      );
      accountId = (await buy(on, 'DOGE-USD', '500')).user.accountId;
    } finally {
      await on.close();
    }
    const off = await createOrdersHarness(db, {
      now: '2026-11-20T21:01:00.000Z',
      env: { ...SIM_ENV, CRYPTO_FEED: 'off' },
    });
    try {
      const run = await off.app.get(SnapshotService).runDue(off.clock.now());
      expect(run.incomplete).toBeGreaterThanOrEqual(1);
      const rows = await snapshots(accountId);
      expect(rows[0]).toMatchObject({
        date: '2026-11-20',
        complete: false,
        positionsValue: '0',
        markSource: null,
      });
    } finally {
      await db.migrator.query(
        `UPDATE instruments SET tradable_in = '{}' WHERE symbol = 'DOGE-USD'`,
      );
      await off.close();
    }
  });
});

describe('daylight saving edge: Friday 2026-03-06 (EST, closes 21:00Z) and Monday 2026-03-09 (EDT, closes 20:00Z)', () => {
  it("each snapshot is valued at that session's own close instant", async () => {
    const h = await createOrdersHarness(db, { now: '2026-03-06T15:00:00.000Z', env: SIM_ENV });
    try {
      const { user } = await buy(h, 'SPY', '3');
      const job = h.app.get(SnapshotService);
      h.clock.set('2026-03-06T21:01:00.000Z');
      await job.runDue(h.clock.now());
      h.clock.set('2026-03-09T20:01:00.000Z'); // one minute after the EDT close
      await job.runDue(h.clock.now());
      const rows = await snapshots(user.accountId);
      expect(rows.map((r) => [r.date, r.asOf])).toEqual([
        ['2026-03-06', '2026-03-06T21:00:00.000Z'],
        ['2026-03-09', '2026-03-09T20:00:00.000Z'],
      ]);
      for (const r of rows) {
        expect(r).toMatchObject({ complete: true, markSource: 'SIM_CANDLE' });
        expect(r.positionsValue).toBe(
          parse('3')
            .mul(parse(dailyClose(h, 'SPY', r.date)))
            .toString(),
        );
      }
    } finally {
      await h.close();
    }
  });
});
