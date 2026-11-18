import { describe, expect, it } from 'vitest';
import { SIM_CRYPTO, SIM_STOCKS, simQuoteAt, validateQuote } from '@vantage/market-model';
import { SIM_INSTRUMENT_ATTRS, SIM_SOURCE, SimProvider } from './sim.provider.js';

const at = (iso: string) => ({ now: () => new Date(iso) });
const make = (
  over: Partial<ConstructorParameters<typeof SimProvider>[0]> = {},
  iso = '2026-11-10T15:00:00.123Z',
) =>
  new SimProvider({
    clock: at(iso),
    seed: 'vantage-demo-1',
    crypto: true,
    session: 'NYSE',
    ...over,
  });

describe('SimProvider (the MarketDataProvider for the simulated feed)', () => {
  it('is labelled SIM, REAL_TIME and zero delay, and says which asset classes it serves', () => {
    expect(make().id).toBe(SIM_SOURCE);
    expect(make().capabilities()).toEqual({
      assetClasses: ['EQUITY', 'ETF', 'CRYPTO'],
      entitlement: 'REAL_TIME',
      delaySeconds: 0,
      maxSymbols: 500,
    });
    expect(make({ crypto: false }).capabilities().assetClasses).toEqual(['EQUITY', 'ETF']);
  });

  it('master: 12 stocks tradable in the MVP (whole shares); crypto tradable since M8 (MVP gate), fractional step of 8 dp, base asset set', async () => {
    const master = await make().loadInstrumentMaster();
    expect(master).toHaveLength(SIM_STOCKS.length + SIM_CRYPTO.length);
    for (const e of master.filter((m) => m.assetClass !== 'CRYPTO')) {
      expect(e).toMatchObject({
        tradableIn: ['MVP'],
        qtyStep: '1',
        minQty: '1',
        fractionalOk: false,
        tickSize: '0.01',
        quoteCurrency: 'USD',
        status: 'ACTIVE',
      });
    }
    for (const e of master.filter((m) => m.assetClass === 'CRYPTO')) {
      expect(e).toMatchObject({
        exchange: 'CRYPTO',
        tradableIn: ['MVP'],
        qtyStep: '0.00000001',
        minQty: '0.00000001',
        fractionalOk: true,
      });
      expect(e.baseAsset).toBe(e.symbol.split('-')[0]);
    }
    expect(master.find((m) => m.symbol === 'DOGE-USD')?.tickSize).toBe('0.00001');
    expect(master.find((m) => m.symbol === 'XRP-USD')?.tickSize).toBe('0.0001');
    for (const e of master) expect(e.attrs).toEqual(SIM_INSTRUMENT_ATTRS); // labelled simulated, never FIXTURE or real
  });

  it('CRYPTO_FEED off: the master has no crypto and a crypto symbol gets no quote (never a made-up price)', async () => {
    const p = make({ crypto: false });
    expect((await p.loadInstrumentMaster()).some((m) => m.assetClass === 'CRYPTO')).toBe(false);
    expect(await p.getSnapshot(['BTC-USD'])).toEqual([]);
  });

  it('snapshot: one quote per known symbol, unknown symbols skipped, all fields from the injected clock', async () => {
    const quotes = await make().getSnapshot(['AAPL', 'NOPE', 'BTC-USD']);
    expect(quotes.map((q) => q.symbol)).toEqual(['AAPL', 'BTC-USD']);
    for (const q of quotes) {
      expect(q).toMatchObject({ source: 'SIM', entitlement: 'REAL_TIME', delaySeconds: 0 });
      expect(q.providerTs.toISOString()).toBe('2026-11-10T15:00:00.000Z'); // the whole second (the .123 is dropped)
      expect(q.receivedAt.toISOString()).toBe('2026-11-10T15:00:00.123Z');
    }
  });

  it('prices are the pure model at that second, and the same second always gives the same quote', async () => {
    const aapl = SIM_STOCKS[0];
    if (aapl === undefined) throw new Error('no stock');
    const [a] = await make().getSnapshot(['AAPL']);
    const [b] = await make({}, '2026-11-10T15:00:00.900Z').getSnapshot(['AAPL']);
    const expected = simQuoteAt('vantage-demo-1', aapl, Date.parse('2026-11-10T15:00:00Z') / 1000, {
      gaps: true,
    });
    expect({ bid: a?.bid, ask: a?.ask, last: a?.last }).toEqual(expected);
    expect({ bid: b?.bid, ask: b?.ask }).toEqual({ bid: a?.bid, ask: a?.ask });
  });

  it('the seed changes the prices (control); ALWAYS_OPEN only switches off the overnight gap, nothing else', async () => {
    const [a] = await make().getSnapshot(['TSLA']);
    const [b] = await make({ seed: 'other-seed' }).getSnapshot(['TSLA']);
    expect(a?.bid).not.toBe(b?.bid);
    // a day with a gap: session mode changes the price on that day, and never on a day without one
    let differing = 0;
    for (let d = 0; d < 40; d += 1) {
      const iso = new Date(Date.parse('2026-11-01T16:00:00Z') + d * 86400_000).toISOString();
      const [n] = await make({}, iso).getSnapshot(['AAPL']);
      const [o] = await make({ session: 'ALWAYS_OPEN' }, iso).getSnapshot(['AAPL']);
      if (n?.bid !== o?.bid) differing += 1;
    }
    expect(differing).toBeGreaterThan(3);
    expect(differing).toBeLessThan(30);
  });

  it('every quote it makes passes the existing validator (a feed of 60 consecutive seconds)', async () => {
    let last = null;
    for (let i = 0; i < 60; i += 1) {
      const iso = new Date(Date.parse('2026-11-10T15:00:00Z') + i * 1000).toISOString();
      const [q] = await make({}, iso).getSnapshot(['BTC-USD']);
      if (q === undefined) throw new Error('no quote');
      const r = validateQuote(q, last, null, new Date(iso), { tickSize: '0.01' });
      expect(r.accepted).toBe(true);
      last = r.accepted ? r.quote : null;
    }
  });

  it('health is OK and reports the injected time', async () => {
    expect(await make().health()).toEqual({
      status: 'OK',
      asOf: new Date('2026-11-10T15:00:00.123Z'),
    });
  });
});
