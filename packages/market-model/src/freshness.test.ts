import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { marketState } from './calendar.js';
import { DELAYED_TOLERANCE_SECONDS, REAL_TIME_MAX_AGE_SECONDS, freshness } from './freshness.js';
import { NYSE_CALENDAR_2026_2027 } from './testing.js';
import type { Entitlement, Quote } from './types.js';

const NOW = new Date('2026-11-10T16:00:00.000Z'); // a Tuesday, market open (11:00 EST)
const OPEN = { state: 'OPEN' as const };
const CLOSED = { state: 'CLOSED' as const };

function quote(ageMs: number, entitlement: Entitlement, delaySeconds: number): Quote {
  return {
    symbol: 'AAPL',
    bid: '100.00',
    ask: '100.02',
    providerTs: new Date(NOW.getTime() - ageMs),
    receivedAt: NOW,
    source: 'FIXTURE',
    entitlement,
    delaySeconds,
  };
}

describe('freshness: constants', () => {
  it('uses the thresholds of TRADING_ENGINE section 3', () => {
    expect(REAL_TIME_MAX_AGE_SECONDS.EQUITY).toBe(5);
    expect(REAL_TIME_MAX_AGE_SECONDS.CRYPTO).toBe(3);
    expect(DELAYED_TOLERANCE_SECONDS).toBe(60);
  });
});

describe('freshness: every state and boundary', () => {
  const rt = (ms: number) => quote(ms, 'REAL_TIME', 0);
  const dl = (ms: number) => quote(ms, 'DELAYED', 900);

  it.each([
    ['REAL_TIME: age 0', rt(0), OPEN, 'REAL_TIME', 0],
    ['REAL_TIME: age 4.999 s', rt(4999), OPEN, 'REAL_TIME', 4],
    ['REAL_TIME: age exactly 5 s (inclusive)', rt(5000), OPEN, 'REAL_TIME', 5],
    ['STALE: age 5.001 s', rt(5001), OPEN, 'STALE', 5],
    ['STALE: age 5 minutes', rt(300_000), OPEN, 'STALE', 300],
    ['DELAYED: age equals the declared delay (900 s)', dl(900_000), OPEN, 'DELAYED', 900],
    ['DELAYED: age 959.999 s (delay + 59.999 s)', dl(959_999), OPEN, 'DELAYED', 959],
    ['DELAYED: age exactly delay + 60 s (inclusive)', dl(960_000), OPEN, 'DELAYED', 960],
    ['STALE: age delay + 60.001 s', dl(960_001), OPEN, 'STALE', 960],
    ['DELAYED: fresher than the declared delay', dl(100_000), OPEN, 'DELAYED', 100],
    ['CLOSED: delayed quote while the market is closed', dl(900_000), CLOSED, 'CLOSED', 900],
    ['CLOSED: real-time quote while the market is closed', rt(0), CLOSED, 'CLOSED', 0],
    ['CLOSED beats STALE', rt(86_400_000), CLOSED, 'CLOSED', 86_400],
  ])('%s', (_name, q, cal, state, age) => {
    expect(freshness(q, 'ACTIVE', cal, NOW)).toEqual({ state, ageSeconds: age });
  });

  it('a quote timestamped slightly in the future has age 0, never negative', () => {
    const q = quote(-1500, 'REAL_TIME', 0);
    expect(freshness(q, 'ACTIVE', OPEN, NOW)).toEqual({ state: 'REAL_TIME', ageSeconds: 0 });
  });

  it('crypto uses the 3 s real-time threshold (control: equity 4 s is still REAL_TIME)', () => {
    expect(
      freshness(quote(4000, 'REAL_TIME', 0), 'ACTIVE', OPEN, NOW, { assetClass: 'CRYPTO' }).state,
    ).toBe('STALE');
    expect(
      freshness(quote(3000, 'REAL_TIME', 0), 'ACTIVE', OPEN, NOW, { assetClass: 'CRYPTO' }).state,
    ).toBe('REAL_TIME');
    expect(freshness(quote(4000, 'REAL_TIME', 0), 'ACTIVE', OPEN, NOW).state).toBe('REAL_TIME');
  });

  it('UNAVAILABLE: no quote ever (even when the market is closed)', () => {
    expect(freshness(null, 'ACTIVE', OPEN, NOW)).toEqual({
      state: 'UNAVAILABLE',
      ageSeconds: null,
    });
    expect(freshness(null, 'ACTIVE', CLOSED, NOW)).toEqual({
      state: 'UNAVAILABLE',
      ageSeconds: null,
    });
  });

  it('UNAVAILABLE: feed disabled by a kill switch (control: enabled gives DELAYED)', () => {
    const q = quote(900_000, 'DELAYED', 900);
    expect(freshness(q, 'ACTIVE', OPEN, NOW, { feedEnabled: false }).state).toBe('UNAVAILABLE');
    expect(freshness(q, 'ACTIVE', OPEN, NOW, { feedEnabled: true }).state).toBe('DELAYED');
  });

  it('UNAVAILABLE: a DELISTED instrument; HALTED and SELL_ONLY keep their quote', () => {
    const q = quote(900_000, 'DELAYED', 900);
    expect(freshness(q, 'DELISTED', OPEN, NOW).state).toBe('UNAVAILABLE');
    expect(freshness(q, 'HALTED', OPEN, NOW).state).toBe('DELAYED');
    expect(freshness(q, 'SELL_ONLY', OPEN, NOW).state).toBe('DELAYED');
    expect(freshness(q, 'ACTIVE', OPEN, NOW).state).toBe('DELAYED');
  });
});

describe('freshness: properties', () => {
  const instant = fc.integer({
    min: Date.parse('2026-01-01T00:00:00Z'),
    max: Date.parse('2027-12-31T23:59:59Z'),
  });
  const entitlement = fc.constantFrom<Entitlement>('REAL_TIME', 'DELAYED');

  it('never returns an open-market state while the calendar says closed', () => {
    fc.assert(
      fc.property(
        instant,
        fc.integer({ min: 0, max: 2_000_000 }),
        entitlement,
        (ms, ageMs, ent) => {
          const at = new Date(ms);
          const cal = marketState(NYSE_CALENDAR_2026_2027, at);
          const q: Quote = {
            ...quote(0, ent, ent === 'DELAYED' ? 900 : 0),
            providerTs: new Date(ms - ageMs),
          };
          const r = freshness(q, 'ACTIVE', cal, at);
          if (cal.state === 'CLOSED') expect(r.state).toBe('CLOSED');
          else expect(['REAL_TIME', 'DELAYED', 'STALE']).toContain(r.state);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('the state is monotone in age: once STALE, an older quote is never fresh again', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        entitlement,
        (age, extra, ent) => {
          const d = ent === 'DELAYED' ? 900 : 0;
          const a = freshness(quote(age, ent, d), 'ACTIVE', OPEN, NOW).state;
          const b = freshness(quote(age + extra, ent, d), 'ACTIVE', OPEN, NOW).state;
          if (a === 'STALE') expect(b).toBe('STALE');
        },
      ),
      { numRuns: 500 },
    );
  });
});
