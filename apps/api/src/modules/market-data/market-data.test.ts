import { describe, expect, it } from 'vitest';
import { compare, mul, parse } from '@vantage/money';
import type { RawQuote } from '@vantage/market-model';
import { createLogger } from '../../log.js';
import { escapeLike } from '../instruments/search.js';
import { FIXTURE_INSTRUMENTS, FIXTURE_PRICE_STEP } from './fixture/fixture.data.js';
import { FixtureForbiddenError, FixtureProvider } from './fixture/fixture.provider.js';
import { QuoteIngest } from './quote.ingest.js';
import { InMemoryQuoteStore } from './quote.store.js';

function fakeClock(iso = '2026-11-10T15:00:00.000Z') {
  let t = Date.parse(iso);
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('FixtureProvider', () => {
  const clock = fakeClock();
  const provider = new FixtureProvider({ appEnv: 'test', clock });

  it('is labelled FIXTURE, DELAYED, 900 seconds', () => {
    expect(provider.id).toBe('FIXTURE');
    expect(provider.capabilities()).toMatchObject({ entitlement: 'DELAYED', delaySeconds: 900 });
  });

  it('is deterministic: the same clock gives identical quotes', async () => {
    const a = await provider.getSnapshot(['AAPL', 'SPY']);
    const b = await new FixtureProvider({ appEnv: 'local', clock }).getSnapshot(['AAPL', 'SPY']);
    expect(a).toEqual(b);
  });

  it('every quote is FIXTURE, delayed by 900 s, with a bid below the ask and an obviously synthetic price', async () => {
    const quotes = await provider.getSnapshot(FIXTURE_INSTRUMENTS.map((i) => i.symbol));
    expect(quotes).toHaveLength(FIXTURE_INSTRUMENTS.length);
    for (const q of quotes) {
      expect(q.source).toBe('FIXTURE');
      expect(q.entitlement).toBe('DELAYED');
      expect(q.delaySeconds).toBe(900);
      expect(q.providerTs.getTime()).toBe(clock.now().getTime() - 900_000);
      expect(compare(parse(q.bid), parse(q.ask))).toBe(-1);
      // a multiple of 11.11: nothing here could be mistaken for a real market price
      const ratio = parse(q.bid).div(parse(FIXTURE_PRICE_STEP), 0, 'HALF_EVEN');
      expect(mul(ratio, parse(FIXTURE_PRICE_STEP)).equals(parse(q.bid))).toBe(true);
    }
  });

  it('knows about 30 or so real US stocks and ETFs on real exchange codes, whole shares only', async () => {
    expect(FIXTURE_INSTRUMENTS.length).toBeGreaterThanOrEqual(30);
    const master = await provider.loadInstrumentMaster();
    expect(new Set(master.map((m) => m.exchange))).toEqual(new Set(['XNAS', 'XNYS', 'ARCX']));
    expect(new Set(master.map((m) => m.assetClass))).toEqual(new Set(['EQUITY', 'ETF']));
    for (const m of master) {
      expect(m.fractionalOk).toBe(false);
      expect(m.qtyStep).toBe('1');
      expect(m.minQty).toBe('1');
      expect(m.attrs).toMatchObject({ source: 'FIXTURE' });
    }
    expect(master.find((m) => m.symbol === 'AAPL')).toMatchObject({
      name: 'Apple Inc.',
      exchange: 'XNAS',
    });
  });

  it('returns no quote for a symbol it does not know (never a made-up price)', async () => {
    expect(await provider.getSnapshot(['NOPE'])).toEqual([]);
  });

  it('scripted steps are consumed one per snapshot, then it is normal again', async () => {
    const p = new FixtureProvider({ appEnv: 'test', clock });
    p.script('AAPL', [{ kind: 'crossed' }]);
    const [first] = await p.getSnapshot(['AAPL']);
    const [second] = await p.getSnapshot(['AAPL']);
    expect(compare(parse(first?.bid ?? '0'), parse(first?.ask ?? '0'))).toBe(1); // crossed
    expect(compare(parse(second?.bid ?? '0'), parse(second?.ask ?? '0'))).toBe(-1); // normal again
  });

  it('refuses to be built in staging or production (control: local works)', () => {
    expect(() => new FixtureProvider({ appEnv: 'staging', clock })).toThrow(FixtureForbiddenError);
    expect(() => new FixtureProvider({ appEnv: 'production', clock })).toThrow(
      FixtureForbiddenError,
    );
    expect(() => new FixtureProvider({ appEnv: 'local', clock })).not.toThrow();
  });
});

describe('QuoteIngest: counters and the 1% degradation rule (injected clock)', () => {
  function setup() {
    const clock = fakeClock();
    const lines: string[] = [];
    const ingest = new QuoteIngest(
      new InMemoryQuoteStore(),
      clock,
      createLogger('debug', (l) => lines.push(l)),
    );
    const good = (symbol: string, ts = clock.now()): RawQuote => ({
      symbol,
      bid: '10.00',
      ask: '10.02',
      providerTs: ts,
      receivedAt: clock.now(),
      source: 'FIXTURE',
      entitlement: 'DELAYED',
      delaySeconds: 900,
    });
    const crossed = (symbol: string): RawQuote => ({ ...good(symbol), bid: '10.05', ask: '10.02' });
    return { clock, lines, ingest, good, crossed };
  }

  it('counts accepted, rejected by reason and out-of-order', async () => {
    const { clock, ingest, good, crossed } = setup();
    await ingest.ingest('AAA', good('AAA'));
    await ingest.ingest('AAA', crossed('AAA'));
    await ingest.ingest('AAA', good('AAA', new Date(clock.now().getTime() - 60_000))); // older than the last accepted
    expect(ingest.counters('FIXTURE')).toEqual({
      received: 3,
      accepted: 1,
      rejected: { CROSSED: 1, OUT_OF_ORDER: 1 },
      outOfOrder: 1,
      warnings: 0,
    });
    expect(ingest.counters('OTHER')).toEqual({
      received: 0,
      accepted: 0,
      rejected: {},
      outOfOrder: 0,
      warnings: 0,
    });
  });

  it('exactly 1% rejected is still HEALTHY; just over 1% is DEGRADED; it recovers after the window', async () => {
    const { clock, ingest, good, crossed, lines } = setup();
    for (let i = 0; i < 99; i += 1) await ingest.ingest(`S${String(i)}`, good(`S${String(i)}`));
    expect(ingest.feedStatus('FIXTURE')).toBe('HEALTHY');
    await ingest.ingest('BAD', crossed('BAD')); // 1 of 100 = 1%
    expect(ingest.feedStatus('FIXTURE')).toBe('HEALTHY');
    await ingest.ingest('BAD2', crossed('BAD2')); // 2 of 101 is above 1%
    expect(ingest.feedStatus('FIXTURE')).toBe('DEGRADED');
    expect(lines.some((l) => l.includes('feed_status_changed') && l.includes('DEGRADED'))).toBe(
      true,
    );
    clock.advance(5 * 60_000 + 1);
    expect(ingest.feedStatus('FIXTURE')).toBe('HEALTHY');
  });

  it('logs the symbol and reason of a rejection, never the prices', async () => {
    const { ingest, crossed, lines } = setup();
    await ingest.ingest('AAA', crossed('AAA'));
    const line = lines.find((l) => l.includes('quote_rejected')) ?? '';
    expect(line).toContain('CROSSED');
    expect(line).not.toContain('10.05');
  });
});

describe('InMemoryQuoteStore', () => {
  it('stores and returns per-symbol state', async () => {
    const store = new InMemoryQuoteStore();
    expect(await store.get('A')).toBeUndefined();
    await store.set('A', { lastAccepted: null, pending: null });
    expect(await store.get('A')).toEqual({ lastAccepted: null, pending: null });
    expect(await store.symbols()).toEqual(['A']);
  });
});

describe('escapeLike', () => {
  it('escapes %, _ and backslash so user text is matched literally', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('AAPL')).toBe('AAPL');
  });
});
