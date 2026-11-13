// Portfolio, executions and ledger activity over real HTTP and real Postgres. Orders are placed through the M4b API;
// quotes are FIXTURE data put in the store with an injected clock. Every "must fail" has a control that succeeds.
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUOTE_STORE } from '../../tokens.js';
import { cookie } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import {
  BUY_AAPL,
  OPEN_TIME,
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

let db: TestDatabase;
let h: Harness;
beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db);
  await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const sell = (qty: string, bid = '195.00') => ({
  ...BUY_AAPL,
  side: 'SELL',
  qty,
  referencePrice: bid,
});
const portfolio = async (u: TestUser) => {
  const res = await getAs(h, u, '/v1/portfolio');
  expect(res.status).toBe(200);
  return res.body;
};
const quoteTs = (ageSeconds = 900): string =>
  new Date(h.clock.now().getTime() - ageSeconds * 1000).toISOString();

describe('1. golden valuation vectors through HTTP (orders placed through the M4b API)', () => {
  let u: TestUser;
  beforeAll(async () => {
    u = await newUser(h, db, 'golden');
  });

  it('a new account: all cash, no positions, equity 10,000.00, return 0.00, complete', async () => {
    const p = await portfolio(u);
    expect(p).toMatchObject({
      currency: 'USD',
      cash: '10000.00',
      positionsValue: '0.00',
      costBasis: '0.00',
      unrealisedPnl: '0.00',
      realisedPnl: '0.00',
      fees: '0.00',
      equity: '10000.00',
      initialCapital: '10000.00',
      totalReturn: '0.00',
      incomplete: false,
      unvaluedCount: 0,
      positions: [],
      asOf: null,
    });
  });

  it('V1: BUY 10 (190.04) then the bid moves to 195.00: value 1,950.00, unrealised +49.60, equity 10,049.60, return +49.60', async () => {
    expect((await placeOrder(h, u, newKey(), BUY_AAPL)).body.status).toBe('FILLED');
    await setQuote(h, 'AAPL', '195.00', '195.05'); // delayed quote, fresh
    const p = await portfolio(u);
    expect(p.positions).toEqual([
      {
        symbol: 'AAPL',
        qty: '10',
        avgCost: '190.04',
        costBasis: '1900.40',
        valuation: 'VALUED',
        unavailableReason: null,
        mark: '195.00', // the bid, never the ask (195.05)
        markBasis: 'BID',
        marketValue: '1950.00',
        unrealisedPnl: '49.60',
        quote: { freshness: 'DELAYED', asOf: quoteTs(), source: 'FIXTURE' },
        exact: { costBasis: '1900.40', marketValue: '1950.00', unrealisedPnl: '49.60' },
      },
    ]);
    expect(p).toMatchObject({
      cash: '8099.60',
      positionsValue: '1950.00',
      costBasis: '1900.40',
      unrealisedPnl: '49.60',
      realisedPnl: '0.00',
      fees: '0.00',
      equity: '10049.60',
      totalReturn: '49.60',
      incomplete: false,
      asOf: quoteTs(),
    });
    expect(p.exact).toMatchObject({ equity: '10049.60', totalReturn: '49.60', cash: '8099.60' });
    for (const k of ['cash', 'positionsValue', 'equity', 'unrealisedPnl', 'totalReturn']) {
      expect(typeof p[k], k).toBe('string');
    }
  });

  it('partial SELL of 4 at bid 195.00 (194.96): realised +19.68, cash 8,879.44, 6 shares cost 1,140.24 worth 1,170.00, equity 10,049.44', async () => {
    // 4 x 194.96 = 779.84; basis 4 x 190.04 = 760.16; realised 19.68; 6 x 190.04 = 1140.24; 6 x 195.00 = 1170.00
    const r = await placeOrder(h, u, newKey(), sell('4'));
    expect(r.body).toMatchObject({
      status: 'FILLED',
      execution: { price: '194.96', notional: '779.84' },
    });
    await setQuote(h, 'AAPL', '195.00', '195.05');
    const p = await portfolio(u);
    expect(p).toMatchObject({
      cash: '8879.44',
      costBasis: '1140.24',
      positionsValue: '1170.00',
      unrealisedPnl: '29.76',
      realisedPnl: '19.68',
      equity: '10049.44',
      totalReturn: '49.44', // = realised 19.68 + unrealised 29.76
    });
    expect(p.positions[0]).toMatchObject({ qty: '6', avgCost: '190.04', costBasis: '1140.24' });
    // ledger identity: cash + costBasis + fees - realised = 8879.44 + 1140.24 + 0 - 19.68 = 10000
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });

  it('full SELL of the remaining 6: realised +49.20 in total (the M4a vector), no positions, equity 10,049.20, return +49.20', async () => {
    // 6 x 194.96 = 1169.76; basis 1140.24; realised 29.52; total 19.68 + 29.52 = 49.20; cash 8879.44 + 1169.76 = 10049.20
    expect((await placeOrder(h, u, newKey(), sell('6'))).body.status).toBe('FILLED');
    const p = await portfolio(u);
    expect(p).toMatchObject({
      cash: '10049.20',
      positions: [],
      costBasis: '0.00',
      positionsValue: '0.00',
      unrealisedPnl: '0.00',
      realisedPnl: '49.20',
      equity: '10049.20',
      totalReturn: '49.20',
      incomplete: false,
      asOf: null,
    });
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });

  it('executions (newest first) carry price, fee, the quote used and the realised P&L of each sell; the BUY has none', async () => {
    const res = await getAs(h, u, '/v1/executions');
    expect(res.status).toBe(200);
    const ex = res.body.executions;
    expect(ex.map((e: { side: string; qty: string }) => `${e.side} ${e.qty}`)).toEqual([
      'SELL 6',
      'SELL 4',
      'BUY 10',
    ]);
    expect(ex[0]).toMatchObject({
      symbol: 'AAPL',
      price: '194.96',
      notional: '1169.76',
      fee: '0.00',
      realisedPnl: '29.52',
      exact: { realisedPnl: '29.52', notional: '1169.76', fee: '0.00' },
      quote: { source: 'FIXTURE', entitlement: 'DELAYED', bid: '195.00', ask: '195.05' },
    });
    expect(ex[1]).toMatchObject({ realisedPnl: '19.68', price: '194.96' });
    expect(ex[2]).toMatchObject({
      realisedPnl: null,
      exact: { realisedPnl: null },
      price: '190.04',
    });
    expect(ex[2].quote).toMatchObject({ bid: '189.95', ask: '190.00', last: '189.97' });
    expect(res.body.nextCursor).toBeNull();
    // the sum of the sells' realised P&L equals the portfolio's realised P&L
    expect((Number(ex[0].realisedPnl) * 100 + Number(ex[1].realisedPnl) * 100) / 100).toBe(
      Number((await portfolio(u)).realisedPnl),
    );
  });

  it('ledger activity in plain language: signed cash effect, linked order, newest first, no ledger account ids', async () => {
    const res = await getAs(h, u, '/v1/ledger/activity');
    expect(res.status).toBe(200);
    const a = res.body.activity;
    expect(a.map((x: { cashEffect: string }) => x.cashEffect)).toEqual([
      '1169.76',
      '779.84',
      '-1900.40',
      '10000.00',
    ]);
    expect(a.map((x: { title: string }) => x.title)).toEqual([
      'Trade',
      'Trade',
      'Trade',
      'Starting capital',
    ]);
    expect(a[0]).toMatchObject({ kind: 'FILL', description: 'SELL 6 AAPL @ 194.96' });
    expect(a[0].orderId).toEqual(expect.any(String));
    expect(a[3]).toMatchObject({
      kind: 'GRANT',
      orderId: null,
      description: 'Initial capital grant',
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /ledger_account|ledgerAccount|account_id|accountId/,
    );
    // the cash effects add up to the cash balance
    const sum = a.reduce(
      (s: number, x: { cashEffect: string }) => s + Math.round(Number(x.cashEffect) * 100),
      0,
    );
    expect(sum).toBe(1004920);
  });
});

describe('2. honesty: no quote is ever shown as better than it is', () => {
  const store = (): InMemoryQuoteStore => h.app.get<InMemoryQuoteStore>(QUOTE_STORE);
  async function holder(label: string): Promise<TestUser> {
    await setQuote(h, 'AAPL', '189.95', '190.00');
    const u = await newUser(h, db, label);
    expect((await placeOrder(h, u, newKey(), BUY_AAPL)).body.status).toBe('FILLED');
    return u;
  }

  it('UNAVAILABLE quote: the position is excluded with an explicit flag, equity is cash only, return is null, never zero-valued; a quote brings it back (control)', async () => {
    const u = await holder('unavail');
    await store().set('AAPL', { lastAccepted: null, pending: null });
    const p = await portfolio(u);
    expect(p.positions[0]).toMatchObject({
      symbol: 'AAPL',
      valuation: 'UNAVAILABLE',
      unavailableReason: 'NO_QUOTE',
      mark: null,
      markBasis: null,
      marketValue: null,
      unrealisedPnl: null,
      costBasis: '1900.40', // still part of the books
      quote: { freshness: 'UNAVAILABLE', asOf: null, source: null },
      exact: { marketValue: null, unrealisedPnl: null },
    });
    expect(p).toMatchObject({
      cash: '8099.60',
      positionsValue: '0.00',
      equity: '8099.60', // excludes the position: not valued at zero, not valued at cost
      incomplete: true,
      unvaluedCount: 1,
      totalReturn: null,
      costBasis: '1900.40',
      unrealisedPnl: '0.00',
      asOf: null,
    });
    expect(p.exact.totalReturn).toBeNull();
    expect(p.equity).not.toBe('10000.00'); // not silently valued at cost either
    await setQuote(h, 'AAPL', '195.00', '195.05');
    expect(await portfolio(u)).toMatchObject({ incomplete: false, totalReturn: '49.60' });
  });

  it('a quote with no positive bid or last is UNAVAILABLE (NO_USABLE_PRICE)', async () => {
    const u = await holder('noprice');
    const ts = new Date(h.clock.now().getTime() - 900_000);
    await store().set('AAPL', {
      lastAccepted: {
        symbol: 'AAPL',
        bid: '0',
        ask: '195.05',
        providerTs: ts,
        receivedAt: ts,
        source: 'FIXTURE',
        entitlement: 'DELAYED',
        delaySeconds: 900,
      },
      pending: null,
    });
    const p = await portfolio(u);
    expect(p.positions[0]).toMatchObject({
      valuation: 'UNAVAILABLE',
      unavailableReason: 'NO_USABLE_PRICE',
      marketValue: null,
    });
    expect(p).toMatchObject({ incomplete: true, totalReturn: null, positionsValue: '0.00' });
  });

  it('STALE quote: valued but labelled STALE with its own timestamp; a fresh quote is labelled DELAYED (control)', async () => {
    const u = await holder('stale');
    await setQuote(h, 'AAPL', '195.00', '195.05', { ageSeconds: 2000 });
    const stale = await portfolio(u);
    expect(stale.positions[0]).toMatchObject({
      valuation: 'VALUED',
      marketValue: '1950.00',
      quote: { freshness: 'STALE', asOf: quoteTs(2000) },
    });
    expect(stale.asOf).toBe(quoteTs(2000));
    await setQuote(h, 'AAPL', '195.00', '195.05');
    expect((await portfolio(u)).positions[0].quote.freshness).toBe('DELAYED');
  });

  it('CLOSED market: valued at the last bid, labelled CLOSED, with the quote time shown (never presented as live)', async () => {
    const u = await holder('closed');
    h.clock.set('2026-11-10T22:00:00.000Z'); // 17:00 New York, after the close
    try {
      await setQuote(h, 'AAPL', '195.00', '195.05');
      const p = await portfolio(u);
      expect(p.positions[0]).toMatchObject({
        valuation: 'VALUED',
        mark: '195.00',
        markBasis: 'BID',
        marketValue: '1950.00',
        quote: { freshness: 'CLOSED', asOf: quoteTs(), source: 'FIXTURE' },
      });
      expect(p.asOf).toBe(quoteTs());
    } finally {
      h.clock.set(OPEN_TIME);
    }
  });

  it('the bid is the mark (the ask is never used); last is used only when there is no positive bid, and is labelled LAST', async () => {
    const u = await holder('basis');
    await setQuote(h, 'AAPL', '195.00', '250.00', { last: '199.00' });
    expect((await portfolio(u)).positions[0]).toMatchObject({
      mark: '195.00',
      markBasis: 'BID',
      marketValue: '1950.00',
    });
    const ts = new Date(h.clock.now().getTime() - 900_000);
    await store().set('AAPL', {
      lastAccepted: {
        symbol: 'AAPL',
        bid: '0',
        ask: '250.00',
        last: '196.50',
        providerTs: ts,
        receivedAt: ts,
        source: 'FIXTURE',
        entitlement: 'DELAYED',
        delaySeconds: 900,
      },
      pending: null,
    });
    expect((await portfolio(u)).positions[0]).toMatchObject({
      mark: '196.50',
      markBasis: 'LAST',
      marketValue: '1965.00',
      unrealisedPnl: '64.60',
    });
  });

  it('two positions with one unavailable: only the valued one is in the totals and the response says so', async () => {
    await setQuote(h, 'AAPL', '189.95', '190.00');
    await setQuote(h, 'MSFT', '99.98', '100.00');
    const u = await newUser(h, db, 'two');
    await placeOrder(h, u, newKey(), BUY_AAPL);
    await placeOrder(h, u, newKey(), {
      ...BUY_AAPL,
      symbol: 'MSFT',
      qty: '3',
      referencePrice: '100.00',
    });
    await setQuote(h, 'AAPL', '195.00', '195.05');
    await store().set('MSFT', { lastAccepted: null, pending: null });
    const p = await portfolio(u);
    expect(
      p.positions.map((x: { symbol: string; valuation: string }) => `${x.symbol}:${x.valuation}`),
    ).toEqual(['AAPL:VALUED', 'MSFT:UNAVAILABLE']);
    // cash 10000 - 1900.40 - 300.06 = 7799.54; only AAPL (1950.00) is valued; MSFT cost 300.06 stays in costBasis
    expect(p).toMatchObject({
      cash: '7799.54',
      positionsValue: '1950.00',
      equity: '9749.54',
      costBasis: '2200.46',
      incomplete: true,
      unvaluedCount: 1,
      totalReturn: null,
    });
  });
});

describe('5. authentication and isolation', () => {
  it('no session is 401 on every read endpoint (control: with a session the same routes answer 200)', async () => {
    const u = await newUser(h, db, 'auth');
    for (const path of [
      '/v1/portfolio',
      '/v1/portfolio/history',
      '/v1/executions',
      '/v1/ledger/activity',
    ]) {
      const anon = await h.http.get(path);
      expect(anon.status, path).toBe(401);
      expect(anon.body.error.code).toBe('UNAUTHENTICATED');
      expect((await h.http.get(path).set('Cookie', cookie('garbage-token'))).status).toBe(401);
      expect((await getAs(h, u, path)).status, path).toBe(200);
    }
  });

  it("user B never sees user A's portfolio, executions, activity or snapshots, with or without A's cursor", async () => {
    await setQuote(h, 'AAPL', '189.95', '190.00');
    const a = await newUser(h, db, 'isoA');
    const b = await newUser(h, db, 'isoB');
    for (let i = 0; i < 3; i += 1) await placeOrder(h, a, newKey(), { ...BUY_AAPL, qty: '1' });
    const aPage = await getAs(h, a, '/v1/executions?limit=1');
    expect(aPage.body.executions).toHaveLength(1);
    expect(aPage.body.nextCursor).toEqual(expect.any(String));

    expect((await portfolio(b)).positions).toEqual([]);
    expect((await portfolio(b)).cash).toBe('10000.00');
    expect((await getAs(h, b, '/v1/executions')).body.executions).toEqual([]);
    expect(
      (await getAs(h, b, `/v1/executions?cursor=${String(aPage.body.nextCursor)}`)).body.executions,
    ).toEqual([]);
    const act = (await getAs(h, b, '/v1/ledger/activity')).body.activity;
    expect(act).toHaveLength(1); // only B's own starting capital
    expect(act[0].kind).toBe('GRANT');
    expect((await getAs(h, b, '/v1/portfolio/history')).body.snapshots).toEqual([]);
    // control: A sees their own
    expect((await portfolio(a)).positions).toHaveLength(1);
    expect((await getAs(h, a, '/v1/executions')).body.executions).toHaveLength(3);
  });

  it('bad queries are 400 (limits, cursors, dates, unknown parameters, an account id) and never 500; controls pass', async () => {
    const u = await newUser(h, db, 'bad');
    for (const q of [
      '/v1/executions?limit=0',
      '/v1/executions?limit=101',
      '/v1/executions?cursor=!!!',
      '/v1/executions?accountId=x',
      '/v1/ledger/activity?limit=abc',
      '/v1/ledger/activity?cursor=e30',
      '/v1/ledger/activity?foo=1',
      '/v1/portfolio/history?from=2026-13-01',
      '/v1/portfolio/history?from=20261101',
      '/v1/portfolio/history?from=2026-11-10&to=2026-11-01',
      '/v1/portfolio/history?from=2025-01-01&to=2026-11-10',
      '/v1/portfolio/history?foo=bar',
    ]) {
      const r = await getAs(h, u, q);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    for (const q of [
      '/v1/executions?limit=100',
      '/v1/ledger/activity?limit=1',
      '/v1/portfolio/history?from=2026-01-01&to=2026-11-10',
      '/v1/portfolio/history?from=2025-11-10&to=2026-11-10', // 366 days inclusive: the maximum
    ]) {
      expect((await getAs(h, u, q)).status, q).toBe(200);
    }
  });
});

describe('5b. pagination is stable under concurrent inserts', () => {
  it('executions: 25 fills paged 10 at a time newest first; inserts between pages cause no duplicate or skip', async () => {
    await setQuote(h, 'AAPL', '99.98', '100.00');
    const u = await newUser(h, db, 'pager');
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      if (i % 5 === 4) h.clock.advance(1000); // some distinct timestamps, the rest tie (broken by id)
      const r = await placeOrder(h, u, newKey(), {
        ...BUY_AAPL,
        qty: '1',
        referencePrice: '100.00',
      });
      ids.push(String(r.body.execution.id));
    }
    const newestFirst = [...ids].reverse();
    const walk = async (): Promise<{ got: string[]; sizes: number[] }> => {
      const got: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const q: string = cursor === null ? '?limit=10' : `?limit=10&cursor=${cursor}`;
        const page = await getAs(h, u, `/v1/executions${q}`);
        expect(page.status).toBe(200);
        sizes.push(page.body.executions.length);
        got.push(...page.body.executions.map((e: { id: string }) => e.id));
        cursor = page.body.nextCursor;
      } while (cursor !== null);
      return { got, sizes };
    };
    const full = await walk();
    expect(full.sizes).toEqual([10, 10, 5]);
    expect(full.got).toEqual(newestFirst);

    // concurrent inserts between page 1 and page 2
    const page1 = await getAs(h, u, '/v1/executions?limit=10');
    expect(page1.body.executions.map((e: { id: string }) => e.id)).toEqual(
      newestFirst.slice(0, 10),
    );
    for (let i = 0; i < 3; i += 1) {
      if (i === 2) h.clock.advance(5000);
      await placeOrder(h, u, newKey(), { ...BUY_AAPL, qty: '1', referencePrice: '100.00' });
    }
    const page2 = await getAs(
      h,
      u,
      `/v1/executions?limit=10&cursor=${String(page1.body.nextCursor)}`,
    );
    expect(page2.body.executions.map((e: { id: string }) => e.id)).toEqual(
      newestFirst.slice(10, 20),
    );
    // control: a fresh walk now has 28 items, newest first, no duplicates
    const after = await walk();
    expect(after.got).toHaveLength(28);
    expect(new Set(after.got).size).toBe(28);
  });

  it('ledger activity: the same property (26 transactions: grant + 25 fills)', async () => {
    await setQuote(h, 'AAPL', '99.98', '100.00');
    const u = await newUser(h, db, 'actpager');
    for (let i = 0; i < 25; i += 1) {
      await placeOrder(h, u, newKey(), { ...BUY_AAPL, qty: '1', referencePrice: '100.00' });
    }
    const all = await getAs(h, u, '/v1/ledger/activity?limit=100');
    const ids = all.body.activity.map((x: { id: string }) => x.id);
    expect(ids).toHaveLength(26);
    expect(all.body.activity[25].kind).toBe('GRANT'); // oldest last
    const p1 = await getAs(h, u, '/v1/ledger/activity?limit=10');
    await placeOrder(h, u, newKey(), { ...BUY_AAPL, qty: '1', referencePrice: '100.00' });
    const p2 = await getAs(
      h,
      u,
      `/v1/ledger/activity?limit=10&cursor=${String(p1.body.nextCursor)}`,
    );
    expect(p1.body.activity.map((x: { id: string }) => x.id)).toEqual(ids.slice(0, 10));
    expect(p2.body.activity.map((x: { id: string }) => x.id)).toEqual(ids.slice(10, 20));
    const p3 = await getAs(
      h,
      u,
      `/v1/ledger/activity?limit=10&cursor=${String(p2.body.nextCursor)}`,
    );
    expect(p3.body.activity.map((x: { id: string }) => x.id)).toEqual(ids.slice(20, 26));
    expect(p3.body.nextCursor).toBeNull();
  });
});
