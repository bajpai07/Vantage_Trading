// The simulated feed end to end (M7a): real Postgres, the real Nest app, the SIM provider through the existing ingest and
// validator, source labelling, the 24/7 session override, display-only crypto. No network: the feed is computed.
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { parse } from '@vantage/money';
import { SIM_CRYPTO, SIM_STOCKS, simQuoteAt } from '@vantage/market-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookie } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import {
  createOrdersHarness,
  getAs,
  newKey,
  newUser,
  placeOrder,
} from '../../testing/orders-kit.js';
import { FeedInfoService } from '../feed/feed.module.js';
import { MarketRefresher } from './market.startup.js';
import { QuoteIngest } from './quote.ingest.js';

const TUESDAY = '2026-11-10T15:00:00.000Z'; // NYSE open
const SUNDAY = '2026-11-15T12:00:00.000Z'; // NYSE closed (weekend)
const secOf = (iso: string): number => Date.parse(iso) / 1000;
const SEED = 'vantage-demo-1';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.dispose();
});

const SIM_ENV = { MARKET_DATA_SOURCE: 'SIM', CRYPTO_FEED: 'sim' };

async function boot(env: Record<string, string>, now: string): Promise<Harness> {
  return createOrdersHarness(db, { now, env });
}

async function quotes(h: Harness, token: string, symbols: string) {
  const res = await getAs(h, { token }, `/v1/quotes?symbols=${symbols}`);
  expect(res.status).toBe(200);
  return res.body.quotes as Array<Record<string, unknown>>;
}

describe('SIM feed: stocks and crypto, labelled SIM, REAL_TIME, straight from the pure model', () => {
  let h: Harness;
  let token: string;
  beforeAll(async () => {
    h = await boot(SIM_ENV, TUESDAY);
    token = (await newUser(h, db)).token;
  });
  afterAll(async () => {
    await h.close();
  });

  it('startup ingested a quote for all 12 stocks/ETFs and all 6 crypto pairs, none rejected', async () => {
    const symbols = [...SIM_STOCKS, ...SIM_CRYPTO].map((s) => s.symbol);
    const qs = await quotes(h, token, symbols.join(','));
    expect(qs).toHaveLength(18);
    for (const q of qs) {
      expect(q, String(q.symbol)).toMatchObject({
        known: true,
        freshness: 'REAL_TIME',
        source: 'SIM',
        entitlement: 'REAL_TIME',
        delaySeconds: 0,
        ageSeconds: 0,
        asOf: TUESDAY,
      });
    }
    const counters = h.app.get(QuoteIngest).counters('SIM');
    expect(counters).toMatchObject({
      received: 18,
      accepted: 18,
      outOfOrder: 0,
      warnings: 0,
      rejected: {},
    });
  });

  it('every price equals what the pure generator gives for (seed, symbol, that second): exact strings', async () => {
    const qs = await quotes(h, token, 'AAPL,BTC-USD,DOGE-USD');
    const t = secOf(TUESDAY);
    for (const q of qs) {
      const cfg = [...SIM_STOCKS, ...SIM_CRYPTO].find((c) => c.symbol === q.symbol);
      if (cfg === undefined) throw new Error('config missing');
      const e = simQuoteAt(SEED, cfg, t, { gaps: true });
      const canon = (p: string): string => parse(p).toCanonicalString(); // the API's price format
      expect({ bid: q.bid, ask: q.ask, last: q.last }).toEqual({
        bid: canon(e.bid),
        ask: canon(e.ask),
        last: canon(e.last),
      });
    }
  });

  it('time moves the price: a later second gives the model price for that second (refresh with the injected clock)', async () => {
    h.clock.advance(30_000);
    await h.app.get(MarketRefresher).refresh();
    const [q] = await quotes(h, token, 'BTC-USD');
    const cfg = SIM_CRYPTO.find((c) => c.symbol === 'BTC-USD');
    if (cfg === undefined) throw new Error('config missing');
    expect(q).toMatchObject({ freshness: 'REAL_TIME', ageSeconds: 0 });
    expect({ bid: q?.bid, ask: q?.ask }).toMatchObject({
      bid: simQuoteAt(SEED, cfg, secOf(TUESDAY) + 30, { gaps: false }).bid,
      ask: simQuoteAt(SEED, cfg, secOf(TUESDAY) + 30, { gaps: false }).ask,
    });
  });

  it('crypto goes STALE after 3 seconds, stocks after 5 (the shared freshness function, per class)', async () => {
    h.clock.advance(4_000);
    const [btc, aapl] = await quotes(h, token, 'BTC-USD,AAPL');
    expect(btc).toMatchObject({ freshness: 'STALE', ageSeconds: 4 });
    expect(aapl).toMatchObject({ freshness: 'REAL_TIME', ageSeconds: 4 }); // control: 4 s is inside the 5 s stock window
    h.clock.advance(2_000);
    expect((await quotes(h, token, 'AAPL'))[0]).toMatchObject({
      freshness: 'STALE',
      ageSeconds: 6,
    });
    await h.app.get(MarketRefresher).refresh(); // the runner publishes again: fresh
    expect((await quotes(h, token, 'AAPL,BTC-USD')).map((q) => q.freshness)).toEqual([
      'REAL_TIME',
      'REAL_TIME',
    ]);
  });

  it('instrument rows: stocks tradable and labelled SIM; crypto display-only (tradable false), asset class CRYPTO, 8 dp step noted', async () => {
    const aapl = await getAs(h, { token }, '/v1/instruments/AAPL');
    expect(aapl.body).toMatchObject({
      assetClass: 'EQUITY',
      source: 'SIM',
      tradable: true,
      entitlement: 'REAL_TIME',
      delaySeconds: 0,
    });
    const btc = await getAs(h, { token }, '/v1/instruments/BTC-USD');
    expect(btc.body).toMatchObject({
      assetClass: 'CRYPTO',
      exchange: 'CRYPTO',
      source: 'SIM',
      tradable: false,
      tickSize: '0.01',
      currency: 'USD',
    });
    const doge = await getAs(h, { token }, '/v1/instruments/DOGE-USD');
    expect(doge.body).toMatchObject({ tickSize: '0.00001', tradable: false });
    const rows = await db.migrator.query<{
      symbol: string;
      qty_step: string;
      min_qty: string;
      fractional_ok: boolean;
      tradable_in: string[];
      base_asset: string;
    }>(
      `SELECT symbol, qty_step::text, min_qty::text, fractional_ok, tradable_in, base_asset FROM instruments WHERE asset_class = 'CRYPTO' ORDER BY symbol`,
    );
    expect(rows.rows).toHaveLength(6);
    for (const r of rows.rows) {
      expect(r.tradable_in).toEqual([]);
      expect(r.fractional_ok).toBe(true);
      expect(r.qty_step).toBe('0.0000000100');
      expect(r.base_asset).toBe(r.symbol.split('-')[0]);
    }
    const search = await getAs(h, { token }, '/v1/instruments/search?q=bitcoin');
    expect(search.body.results[0]).toMatchObject({
      symbol: 'BTC-USD',
      assetClass: 'CRYPTO',
      tradable: false,
    });
  });

  it('GET /v1/market/feed is truthful per source: SIM labels, classes, sessions, status and last message', async () => {
    await h.app.get(MarketRefresher).refresh();
    const NOW = h.clock.now().toISOString();
    const res = await h.http.get('/v1/market/feed');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source: 'SIM',
      entitlement: 'REAL_TIME',
      delaySeconds: 0,
      enabled: true,
      demoMode: false,
    });
    expect(res.body.sources).toEqual([
      {
        assetClass: 'EQUITY',
        source: 'SIM',
        label: 'Simulated market data',
        mode: 'SIMULATED',
        session: 'NYSE',
        status: 'CONNECTED',
        lastMessageAt: NOW,
      },
      {
        assetClass: 'ETF',
        source: 'SIM',
        label: 'Simulated market data',
        mode: 'SIMULATED',
        session: 'NYSE',
        status: 'CONNECTED',
        lastMessageAt: NOW,
      },
      {
        assetClass: 'CRYPTO',
        source: 'SIM',
        label: 'Simulated market data',
        mode: 'SIMULATED',
        session: '24_7',
        status: 'CONNECTED',
        lastMessageAt: NOW,
      },
    ]);
  });

  it('a feed that stops publishing is reported DISCONNECTED (not healthy), and CONNECTED again when it resumes', async () => {
    await h.app.get(MarketRefresher).refresh();
    const PUBLISHED = h.clock.now().toISOString();
    h.clock.advance(60_000);
    const stale = await h.http.get('/v1/market/feed');
    expect(stale.body.sources.map((s: { status: string }) => s.status)).toEqual([
      'DISCONNECTED',
      'DISCONNECTED',
      'DISCONNECTED',
    ]);
    expect(stale.body.sources[0].lastMessageAt).toBe(PUBLISHED); // says when it last published
    await h.app.get(MarketRefresher).refresh();
    const back = await h.http.get('/v1/market/feed');
    expect(back.body.sources.map((s: { status: string }) => s.status)).toEqual([
      'CONNECTED',
      'CONNECTED',
      'CONNECTED',
    ]);
  });

  it('kill switch: every class is OFF and every quote UNAVAILABLE with no price; back on, quotes return', async () => {
    const feed = h.app.get(FeedInfoService);
    feed.setEnabled(false);
    try {
      const res = await h.http.get('/v1/market/feed');
      expect(res.body.enabled).toBe(false);
      expect(res.body.sources.map((s: { status: string }) => s.status)).toEqual([
        'OFF',
        'OFF',
        'OFF',
      ]);
      for (const q of await quotes(h, token, 'AAPL,BTC-USD')) {
        expect(q).toMatchObject({ freshness: 'UNAVAILABLE', source: 'SIM' });
        expect(q).not.toHaveProperty('bid');
      }
    } finally {
      feed.setEnabled(true);
    }
    await h.app.get(MarketRefresher).refresh();
    expect((await quotes(h, token, 'AAPL'))[0]).toMatchObject({ freshness: 'REAL_TIME' });
  });

  it('a SIM stock order fills against a SIM quote and the execution row stores quote_source SIM', async () => {
    await h.app.get(MarketRefresher).refresh();
    const u = await newUser(h, db);
    const [q] = await quotes(h, u.token, 'AAPL');
    const res = await placeOrder(h, u, newKey(), {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      qty: '10',
      referencePrice: q?.ask,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'FILLED', filledQty: '10' });
    const ex = await db.migrator.query<{ quote_source: string }>(
      `SELECT quote_source FROM executions WHERE order_id = $1::uuid`,
      [res.body.id],
    );
    expect(ex.rows).toEqual([{ quote_source: 'SIM' }]);
  });

  it('crypto cannot be traded yet: INSTRUMENT_NOT_TRADABLE (control: the same user fills a stock order)', async () => {
    const u = await newUser(h, db);
    const [btc] = await quotes(h, u.token, 'BTC-USD');
    const rejected = await placeOrder(h, u, newKey(), {
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'MARKET',
      qty: '1',
      referencePrice: btc?.ask,
    });
    expect(rejected.status).toBe(201);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      rejectCode: 'INSTRUMENT_NOT_TRADABLE',
      filledQty: '0',
    });
    const preview = await h.http
      .post('/v1/orders/preview')
      .set('Cookie', cookie(u.token))
      .set('Origin', 'http://localhost:3000')
      .send({ symbol: 'BTC-USD', side: 'BUY', type: 'MARKET', qty: '1', referencePrice: btc?.ask });
    expect(preview.body).toMatchObject({ wouldFill: false, rejectCode: 'INSTRUMENT_NOT_TRADABLE' });
    const [aapl] = await quotes(h, u.token, 'AAPL');
    const ok = await placeOrder(h, u, newKey(), {
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      qty: '1',
      referencePrice: aapl?.ask,
    });
    expect(ok.body).toMatchObject({ status: 'FILLED' });
    const moved = await db.migrator.query(
      `SELECT 1 FROM executions e JOIN orders o ON o.id = e.order_id WHERE o.id = $1::uuid`,
      [rejected.body.id],
    );
    expect(moved.rowCount).toBe(0); // the rejected crypto order moved nothing
  });
});

describe('SIM_SESSION: the 24/7 override (D-76) and its NYSE control, at a Sunday instant', () => {
  it('ALWAYS_OPEN: stocks are OPEN and REAL_TIME on a Sunday, labelled "Simulated 24/7 session", and an order fills', async () => {
    const h = await boot({ ...SIM_ENV, SIM_SESSION: 'ALWAYS_OPEN' }, SUNDAY);
    try {
      const u = await newUser(h, db);
      const status = await getAs(h, u, '/v1/market/status');
      for (const x of status.body.exchanges as Array<Record<string, unknown>>) {
        expect(x, String(x.exchange)).toMatchObject({
          state: 'OPEN',
          note: x.exchange === 'CRYPTO' ? 'Open 24/7' : 'Simulated 24/7 session',
        });
      }
      const [q] = await quotes(h, u.token, 'AAPL');
      expect(q).toMatchObject({ freshness: 'REAL_TIME', source: 'SIM' });
      const feed = await h.http.get('/v1/market/feed');
      expect(
        feed.body.sources.find((s: { assetClass: string }) => s.assetClass === 'EQUITY').session,
      ).toBe('ALWAYS_OPEN');
      expect(
        feed.body.sources.find((s: { assetClass: string }) => s.assetClass === 'CRYPTO').session,
      ).toBe('24_7');
      const res = await placeOrder(h, u, newKey(), {
        symbol: 'AAPL',
        side: 'BUY',
        type: 'MARKET',
        qty: '3',
        referencePrice: q?.ask,
      });
      expect(res.body).toMatchObject({ status: 'FILLED' });
      // no overnight gap in ALWAYS_OPEN: the price is the pure model without gaps
      const cfg = SIM_STOCKS.find((c) => c.symbol === 'AAPL');
      if (cfg === undefined) throw new Error('config missing');
      expect(q?.bid).toBe(simQuoteAt(SEED, cfg, secOf(SUNDAY), { gaps: false }).bid);
    } finally {
      await h.close();
    }
  });

  it('control, NYSE session at the same Sunday instant: stocks are CLOSED and an order is rejected MARKET_CLOSED; crypto is still open', async () => {
    const h = await boot(SIM_ENV, SUNDAY);
    try {
      const u = await newUser(h, db);
      const status = await getAs(h, u, '/v1/market/status');
      const byEx = new Map(
        (status.body.exchanges as Array<Record<string, unknown>>).map((x) => [x.exchange, x]),
      );
      expect(byEx.get('XNAS')).toMatchObject({ state: 'CLOSED', reason: 'WEEKEND' });
      expect(byEx.get('CRYPTO')).toMatchObject({ state: 'OPEN' });
      const [aapl, btc] = await quotes(h, u.token, 'AAPL,BTC-USD');
      expect(aapl).toMatchObject({ freshness: 'CLOSED' });
      expect(btc).toMatchObject({ freshness: 'REAL_TIME' }); // crypto never closes
      const res = await placeOrder(h, u, newKey(), {
        symbol: 'AAPL',
        side: 'BUY',
        type: 'MARKET',
        qty: '3',
        referencePrice: aapl?.ask,
      });
      expect(res.body).toMatchObject({ status: 'REJECTED', rejectCode: 'MARKET_CLOSED' });
      const feed = await h.http.get('/v1/market/feed');
      expect(
        feed.body.sources.find((s: { assetClass: string }) => s.assetClass === 'EQUITY').session,
      ).toBe('NYSE');
    } finally {
      await h.close();
    }
  });
});

describe('CRYPTO_FEED=off (control): crypto is reported OFF and has no price, stocks are unaffected', () => {
  it('feed says crypto OFF; BTC-USD is UNAVAILABLE with no price; AAPL still has a SIM quote', async () => {
    const h = await boot({ MARKET_DATA_SOURCE: 'SIM', CRYPTO_FEED: 'off' }, TUESDAY);
    try {
      const u = await newUser(h, db);
      const feed = await h.http.get('/v1/market/feed');
      expect(
        feed.body.sources.map((s: { assetClass: string; status: string }) => [
          s.assetClass,
          s.status,
        ]),
      ).toEqual([
        ['EQUITY', 'CONNECTED'],
        ['ETF', 'CONNECTED'],
        ['CRYPTO', 'OFF'],
      ]);
      const [btc, aapl] = await quotes(h, u.token, 'BTC-USD,AAPL');
      expect(btc).toMatchObject({ freshness: 'UNAVAILABLE' });
      expect(btc).not.toHaveProperty('bid');
      expect(aapl).toMatchObject({ freshness: 'REAL_TIME', source: 'SIM' });
    } finally {
      await h.close();
    }
  });
});

describe('determinism through the whole stack, and demo mode', () => {
  it('two apps with the same seed and clock serve identical quotes; another seed serves different ones (control)', async () => {
    const symbols = 'AAPL,TSLA,BTC-USD,XRP-USD';
    const grab = async (env: Record<string, string>): Promise<string> => {
      const h = await boot({ ...SIM_ENV, ...env }, TUESDAY);
      try {
        const u = await newUser(h, db);
        return JSON.stringify(await quotes(h, u.token, symbols));
      } finally {
        await h.close();
      }
    };
    const a = await grab({});
    expect(await grab({})).toBe(a);
    expect(await grab({ SIM_SEED: 'another-seed' })).not.toBe(a);
  });

  it('DEMO_MODE is reported by the feed endpoint (false by default, true when set)', async () => {
    const h1 = await boot(SIM_ENV, TUESDAY);
    const h2 = await boot({ ...SIM_ENV, DEMO_MODE: 'true' }, TUESDAY);
    try {
      expect((await h1.http.get('/v1/market/feed')).body.demoMode).toBe(false);
      expect((await h2.http.get('/v1/market/feed')).body.demoMode).toBe(true);
    } finally {
      await h1.close();
      await h2.close();
    }
  });

  it('the SIM provider goes through the existing validator: a crossed quote is rejected and counted (control: no second path)', async () => {
    const h = await boot(SIM_ENV, TUESDAY);
    try {
      const ingest = h.app.get(QuoteIngest);
      const r = await ingest.ingest(
        'AAPL',
        {
          symbol: 'AAPL',
          bid: '200.00',
          ask: '199.00',
          providerTs: new Date(Date.parse(TUESDAY) + 1000),
          receivedAt: new Date(TUESDAY),
          source: 'SIM',
          entitlement: 'REAL_TIME',
          delaySeconds: 0,
        },
        '0.01',
      );
      expect(r).toMatchObject({ accepted: false, reason: 'CROSSED' });
      expect(ingest.counters('SIM').rejected).toMatchObject({ CROSSED: 1 });
    } finally {
      await h.close();
    }
  });
});

describe('the runner (D-78): the simulated feed publishes by itself outside tests, every SIM_TICK_MS', () => {
  const waitFor = async (check: () => Promise<boolean>, ms = 5000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  it('APP_ENV=local: after the clock moves, the runner publishes a new quote without anyone calling refresh', async () => {
    const h = await boot({ ...SIM_ENV, APP_ENV: 'local', SIM_TICK_MS: '200' }, TUESDAY);
    try {
      const u = await newUser(h, db);
      expect((await quotes(h, u.token, 'AAPL'))[0]?.asOf).toBe(TUESDAY);
      h.clock.advance(10_000);
      const moved = await waitFor(
        async () => (await quotes(h, u.token, 'AAPL'))[0]?.asOf === '2026-11-10T15:00:10.000Z',
      );
      expect(moved).toBe(true);
      const feed = await h.http.get('/v1/market/feed');
      expect(feed.body.sources[0]).toMatchObject({
        status: 'CONNECTED',
        lastMessageAt: '2026-11-10T15:00:10.000Z',
      });
    } finally {
      await h.close();
    }
  });

  it('control, APP_ENV=test: no runner, so the same wait changes nothing (a test drives refresh() with its own clock)', async () => {
    const h = await boot({ ...SIM_ENV, SIM_TICK_MS: '200' }, TUESDAY);
    try {
      const u = await newUser(h, db);
      h.clock.advance(10_000);
      const moved = await waitFor(
        async () => (await quotes(h, u.token, 'AAPL'))[0]?.asOf !== TUESDAY,
        1200,
      );
      expect(moved).toBe(false);
    } finally {
      await h.close();
    }
  });
});
