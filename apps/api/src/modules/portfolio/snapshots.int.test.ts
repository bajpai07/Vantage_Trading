// The equity snapshot job (D-62) with an injected clock, real Postgres, orders placed through the M4b API.
// Calendar facts used (NYSE, November 2026, EST = UTC-5): regular close 16:00 = 21:00Z; Thanksgiving Thu 11-26 is a
// holiday; Fri 11-27 is an early close at 13:00 = 18:00Z. Every "must not" has a control that does.
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { parse } from '@vantage/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUOTE_STORE } from '../../tokens.js';
import type { Harness } from '../../testing/harness.js';
import {
  BUY_AAPL,
  createOrdersHarness,
  getAs,
  newKey,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import type { TestUser } from '../../testing/orders-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import type { InMemoryQuoteStore } from '../market-data/quote.store.js';
import { SnapshotScheduler, SnapshotService } from './snapshot.service.js';

let db: TestDatabase;
let h: Harness;
const job = (): SnapshotService => h.app.get(SnapshotService);

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db, {
    now: '2026-11-10T15:00:00.000Z',
    env: { SESSION_IDLE_MINUTES: '10080', SESSION_ABSOLUTE_DAYS: '90' },
  });
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const dec = (s: unknown): string => parse(String(s)).toString();
interface Snap {
  date: string;
  cash: string;
  positionsValue: string;
  equity: string;
  complete: boolean;
  asOf: string | null;
}
async function snaps(accountId: string): Promise<Snap[]> {
  const r = await db.migrator.query(
    `SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS d, cash, positions_value, equity, valued_complete, quote_asof
       FROM equity_snapshots WHERE account_id = $1::uuid ORDER BY snapshot_date`,
    [accountId],
  );
  return r.rows.map((x) => ({
    date: x.d as string,
    cash: dec(x.cash),
    positionsValue: dec(x.positions_value),
    equity: dec(x.equity),
    complete: x.valued_complete as boolean,
    asOf: x.quote_asof === null ? null : (x.quote_asof as Date).toISOString(),
  }));
}
const backdate = (u: TestUser, iso = '2026-11-01T00:00:00Z') =>
  db.migrator.query(`UPDATE accounts SET created_at = $2::timestamptz WHERE id = $1::uuid`, [
    u.accountId,
    iso,
  ]);
/** A quote whose provider timestamp is exactly `ts` (the store is written directly: this is "stored data"). */
async function setQuoteAt(symbol: string, bid: string, ask: string, ts: Date): Promise<void> {
  await h.app.get<InMemoryQuoteStore>(QUOTE_STORE).set(symbol, {
    lastAccepted: {
      symbol,
      bid,
      ask,
      providerTs: ts,
      receivedAt: ts,
      source: 'FIXTURE',
      entitlement: 'DELAYED',
      delaySeconds: 900,
    },
    pending: null,
  });
}
const clearQuote = (symbol: string) =>
  h.app.get<InMemoryQuoteStore>(QUOTE_STORE).set(symbol, { lastAccepted: null, pending: null });
const at = (iso: string): void => h.clock.set(iso);

let u1: TestUser; // AAPL, sells on Thursday
let u2: TestUser; // MSFT, no mark at the close
let u3: TestUser; // account created after the Tuesday close
let u4: TestUser; // frozen account
let u5: TestUser; // suspended user
let u8: TestUser; // opened late November (early-close day)
let u7: TestUser; // AAPL, held through Thursday

describe('setup: Tuesday 2026-11-10 10:00 New York, orders through the API', () => {
  it('places the orders', async () => {
    at('2026-11-10T15:00:00.000Z');
    await setQuote(h, 'AAPL', '189.95', '190.00');
    await setQuote(h, 'MSFT', '99.98', '100.00');
    u1 = await newUser(h, db, 'one');
    u2 = await newUser(h, db, 'two');
    u3 = await newUser(h, db, 'three');
    u4 = await newUser(h, db, 'four');
    u5 = await newUser(h, db, 'five');
    u7 = await newUser(h, db, 'seven');
    for (const u of [u1, u2, u4, u5, u7]) await backdate(u);
    await backdate(u3, '2026-11-10T22:00:00Z'); // opened after the close
    for (const u of [u1, u4, u5, u7]) {
      expect((await placeOrder(h, u, newKey(), BUY_AAPL)).body.status).toBe('FILLED');
    }
    expect(
      (
        await placeOrder(h, u2, newKey(), {
          ...BUY_AAPL,
          symbol: 'MSFT',
          qty: '3',
          referencePrice: '100.00',
        })
      ).body.status,
    ).toBe('FILLED');
    await db.migrator.query(`UPDATE accounts SET status = 'FROZEN_RECON' WHERE id = $1::uuid`, [
      u4.accountId,
    ]);
    await db.migrator.query(
      `UPDATE users SET status = 'SUSPENDED' WHERE id = (SELECT user_id FROM accounts WHERE id = $1::uuid)`,
      [u5.accountId],
    );
  });
});

describe('6a. timing, idempotency and the stored mark (Tuesday close)', () => {
  it('before the close nothing is written for the day: only the previous session (Monday) gets a snapshot, and only that one (no backfill)', async () => {
    at('2026-11-10T20:59:59.000Z');
    const r = await job().runDue(h.clock.now());
    expect(r.lastClosedSession).toBe('2026-11-09');
    expect((await snaps(u1.accountId)).map((s) => s.date)).toEqual(['2026-11-09']);
    // Monday: no executions yet at the Monday close, so cash only and complete
    expect((await snaps(u1.accountId))[0]).toMatchObject({
      cash: '10000',
      positionsValue: '0',
      equity: '10000',
      complete: true,
      asOf: null,
    });
    expect((await snaps(u1.accountId)).some((s) => s.date === '2026-11-10')).toBe(false);
  });

  it('at the close (21:00:00Z) the Tuesday snapshot is written from the stored mark: cash 8,099.60 + 10 x 195.00 = 10,049.60, complete, with the quote time', async () => {
    at('2026-11-10T21:00:00.000Z');
    await setQuote(h, 'AAPL', '195.00', '195.05'); // provider timestamp 20:45Z, on the trading day
    await clearQuote('MSFT'); // u2 has no mark at the close
    const r = await job().runDue(h.clock.now());
    expect(r.lastClosedSession).toBe('2026-11-10');
    const s = (await snaps(u1.accountId)).find((x) => x.date === '2026-11-10');
    expect(s).toEqual({
      date: '2026-11-10',
      cash: '8099.6',
      positionsValue: '1950',
      equity: '10049.6',
      complete: true,
      asOf: '2026-11-10T20:45:00.000Z',
    });
    // equals what the portfolio endpoint reports at that instant (the same marks, the same rules)
    const p = (await getAs(h, u1, '/v1/portfolio')).body;
    expect([p.cash, p.positionsValue, p.equity]).toEqual(['8099.60', '1950.00', '10049.60']);
  });

  it('an unavailable mark is stored as valued_complete = false: positions value excludes the position, equity is cash only, never invented', async () => {
    const s = (await snaps(u2.accountId)).find((x) => x.date === '2026-11-10');
    expect(s).toEqual({
      date: '2026-11-10',
      cash: '9699.94', // 10000 - 3 x 100.02
      positionsValue: '0',
      equity: '9699.94',
      complete: false,
      asOf: null,
    });
  });

  it('running the job again writes nothing and changes nothing (idempotent); a concurrent double run is also safe', async () => {
    const before = await db.migrator.query(`SELECT count(*)::int AS n FROM equity_snapshots`);
    const again = await job().runDue(h.clock.now());
    expect(again.written).toBe(0);
    const [a, b] = await Promise.all([job().runDue(h.clock.now()), job().runDue(h.clock.now())]);
    expect(a.written + b.written).toBe(0);
    expect(
      (await db.migrator.query(`SELECT count(*)::int AS n FROM equity_snapshots`)).rows[0]?.n,
    ).toBe(before.rows[0]?.n);
    expect((await snaps(u1.accountId)).filter((x) => x.date === '2026-11-10')).toHaveLength(1);
  });

  it('only active accounts, and only from the day they existed: frozen, suspended and not-yet-opened accounts have no snapshot', async () => {
    expect(await snaps(u4.accountId)).toEqual([]); // frozen account
    expect(await snaps(u5.accountId)).toEqual([]); // suspended user
    expect(await snaps(u3.accountId)).toEqual([]); // opened after the Tuesday close
    // control: the active accounts do have one
    for (const u of [u1, u2, u7]) expect((await snaps(u.accountId)).length).toBeGreaterThan(0);
  });

  it('GET /v1/portfolio/history returns the stored snapshots oldest first, 2 dp with exact companions and the complete flag', async () => {
    const res = await getAs(h, u2, '/v1/portfolio/history?from=2026-11-01&to=2026-11-12');
    expect(res.status).toBe(200);
    expect(res.body.snapshots).toEqual([
      {
        date: '2026-11-09',
        cash: '10000.00',
        positionsValue: '0.00',
        equity: '10000.00',
        valuedComplete: true,
        quoteAsOf: null,
        exact: { cash: '10000.00', positionsValue: '0.00', equity: '10000.00' },
      },
      {
        date: '2026-11-10',
        cash: '9699.94',
        positionsValue: '0.00',
        equity: '9699.94',
        valuedComplete: false,
        quoteAsOf: null,
        exact: { cash: '9699.94', positionsValue: '0.00', equity: '9699.94' },
      },
    ]);
    // the range filters: a window that contains neither day is empty (control: the first contains both)
    expect(
      (await getAs(h, u2, '/v1/portfolio/history?from=2026-11-11&to=2026-11-12')).body.snapshots,
    ).toEqual([]);
    expect(
      (await getAs(h, u2, '/v1/portfolio/history?from=2026-11-10&to=2026-11-10')).body.snapshots,
    ).toHaveLength(1);
    // and another user never sees them
    expect(
      (await getAs(h, u3, '/v1/portfolio/history?from=2026-11-01&to=2026-11-12')).body.snapshots,
    ).toEqual([]);
  });

  it('snapshots are append-only for the app role: the job wrote them, and vantage_app cannot change them (control: it can read them)', async () => {
    const id = u1.accountId;
    expect(
      (await db.app.query(`SELECT 1 FROM equity_snapshots WHERE account_id = $1::uuid`, [id]))
        .rowCount,
    ).toBeGreaterThan(0);
    await expect(
      db.app.query(
        `UPDATE equity_snapshots SET valued_complete = false WHERE account_id = $1::uuid`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.app.query(`DELETE FROM equity_snapshots WHERE account_id = $1::uuid`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('6b. catch-up after downtime uses only stored data', () => {
  it('the app was down Wednesday and Thursday; restarted Friday 09:00 New York: Wednesday has no mark (incomplete), Thursday uses the stored Thursday mark', async () => {
    // Wednesday and Thursday: u1 sells everything on Thursday at 10:00 New York
    at('2026-11-12T15:00:00.000Z');
    await setQuote(h, 'AAPL', '195.00', '195.05');
    expect(
      (await placeOrder(h, u1, newKey(), { ...BUY_AAPL, side: 'SELL', referencePrice: '195.00' }))
        .body.status,
    ).toBe('FILLED');
    // Friday 09:00 New York, before the open. Stored marks: AAPL has a Thursday 15:50 quote, MSFT only a Friday quote.
    at('2026-11-13T14:00:00.000Z');
    await setQuoteAt('AAPL', '196.00', '196.05', new Date('2026-11-12T20:50:00.000Z'));
    await setQuoteAt('MSFT', '101.00', '101.05', new Date('2026-11-13T13:55:00.000Z')); // today's price
    const r = await job().runDue(h.clock.now());
    expect(r.lastClosedSession).toBe('2026-11-12');

    // u7 holds 10 AAPL throughout (cash 8,099.60)
    const s7 = await snaps(u7.accountId);
    expect(s7.map((s) => s.date)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
    expect(s7[2]).toEqual({
      date: '2026-11-11',
      cash: '8099.6',
      positionsValue: '0',
      equity: '8099.6',
      complete: false,
      asOf: null,
    }); // no Wednesday mark
    expect(s7[3]).toEqual({
      date: '2026-11-12',
      cash: '8099.6',
      positionsValue: '1960', // 10 x 196.00, the stored Thursday bid
      equity: '10059.6',
      complete: true,
      asOf: '2026-11-12T20:50:00.000Z',
    });

    // u1 sold on Thursday: Wednesday still held the shares (no mark: incomplete), Thursday holds nothing (complete, cash only)
    const s1 = await snaps(u1.accountId);
    expect(s1.map((s) => s.date)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
    expect(s1[2]).toMatchObject({
      date: '2026-11-11',
      cash: '8099.6',
      equity: '8099.6',
      complete: false,
    });
    expect(s1[3]).toEqual({
      date: '2026-11-12',
      cash: '10049.2',
      positionsValue: '0',
      equity: '10049.2',
      complete: true,
      asOf: null,
    });

    // u2: the only stored MSFT mark is from Friday: never used for Wednesday or Thursday
    const s2 = await snaps(u2.accountId);
    expect(s2.slice(2).map((s) => [s.date, s.complete, s.positionsValue, s.asOf])).toEqual([
      ['2026-11-11', false, '0', null],
      ['2026-11-12', false, '0', null],
    ]);
    // the Friday price was not put anywhere in a snapshot
    for (const s of s2) expect(s.positionsValue).toBe('0');
  });

  it('a second run changes nothing; an account opened on Tuesday evening gets its first snapshot for Thursday only (no backfill, nothing before it existed)', async () => {
    const before = await db.migrator.query(`SELECT count(*)::int AS n FROM equity_snapshots`);
    expect((await job().runDue(h.clock.now())).written).toBe(0);
    expect(
      (await db.migrator.query(`SELECT count(*)::int AS n FROM equity_snapshots`)).rows[0]?.n,
    ).toBe(before.rows[0]?.n);
    expect(await snaps(u3.accountId)).toEqual([
      {
        date: '2026-11-12',
        cash: '10000',
        positionsValue: '0',
        equity: '10000',
        complete: true,
        asOf: null,
      },
    ]);
  });

  it('the books still reconcile after all of this (the job writes only equity_snapshots)', async () => {
    for (const u of [u1, u2, u7]) expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });
});

describe('6c. the early-close day and holidays', () => {
  it('Friday 2026-11-27 closes at 13:00 New York: no snapshot at 17:59:59Z, one at 18:00:00Z; the Thanksgiving holiday and the weekend have none', async () => {
    at('2026-11-25T15:00:00.000Z'); // Wednesday, a normal day
    await setQuote(h, 'AAPL', '189.95', '190.00');
    u8 = await newUser(h, db, 'eight');
    await backdate(u8, '2026-11-02T00:00:00Z');
    expect((await placeOrder(h, u8, newKey(), BUY_AAPL)).body.status).toBe('FILLED');

    // Friday just before the early close: the latest closed session is still Wednesday
    at('2026-11-27T17:59:59.000Z');
    await setQuoteAt('AAPL', '200.00', '200.05', new Date('2026-11-27T17:45:00.000Z'));
    const before = await job().runDue(h.clock.now());
    expect(before.lastClosedSession).toBe('2026-11-25');
    expect((await snaps(u8.accountId)).map((s) => s.date)).toEqual(['2026-11-25']);

    // at 18:00:00Z the early close has happened
    at('2026-11-27T18:00:00.000Z');
    const after = await job().runDue(h.clock.now());
    expect(after.lastClosedSession).toBe('2026-11-27');
    const s = await snaps(u8.accountId);
    expect(s.map((x) => x.date)).toEqual(['2026-11-25', '2026-11-27']); // nothing for the holiday 11-26
    expect(s[1]).toEqual({
      date: '2026-11-27',
      cash: '8099.6',
      positionsValue: '2000', // 10 x 200.00, the stored Friday mark
      equity: '10099.6',
      complete: true,
      asOf: '2026-11-27T17:45:00.000Z',
    });
    // Wednesday had no Wednesday-dated mark in the store: incomplete, not valued at Friday's price
    expect(s[0]).toMatchObject({
      date: '2026-11-25',
      complete: false,
      positionsValue: '0',
      equity: '8099.6',
    });

    // Saturday: no new session, nothing is written (control: the next session would be Monday)
    at('2026-11-28T15:00:00.000Z');
    const sat = await job().runDue(h.clock.now());
    expect(sat.written).toBe(0);
    expect((await snaps(u8.accountId)).map((x) => x.date)).toEqual(['2026-11-25', '2026-11-27']);
  });
});

describe('the scheduler', () => {
  it('a tick runs the job once with the injected clock, never throws, and does not run in the test environment on its own', async () => {
    const sched = h.app.get(SnapshotScheduler);
    at('2026-11-30T22:00:00.000Z'); // Monday after the close
    await setQuoteAt('AAPL', '201.00', '201.05', new Date('2026-11-30T20:50:00.000Z'));
    await sched.tick();
    const s = await snaps(u8.accountId);
    expect(s[s.length - 1]).toMatchObject({
      date: '2026-11-30',
      complete: true,
      positionsValue: '2010',
      equity: '10109.6',
    });
    // a second tick adds nothing
    const n = s.length;
    await sched.tick();
    expect((await snaps(u8.accountId)).length).toBe(n);
    expect(h.config.appEnv).toBe('test'); // the timer is only started outside the test environment
  });
});
