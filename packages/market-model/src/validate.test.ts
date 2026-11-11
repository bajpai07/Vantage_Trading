import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compare, parse } from '@vantage/money';
import { validateQuote } from './validate.js';
import type { PendingGap, ValidationResult } from './validate.js';
import type { Quote, RawQuote } from './types.js';

const NOW = new Date('2026-11-10T16:00:00.000Z');
const T = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

function raw(over: Partial<RawQuote> = {}): RawQuote {
  return {
    symbol: 'AAPL',
    bid: '100.00',
    ask: '100.02',
    providerTs: T(-900_000),
    receivedAt: NOW,
    source: 'FIXTURE',
    entitlement: 'DELAYED',
    delaySeconds: 900,
    ...over,
  };
}
const accepted = (r: ValidationResult): Quote => {
  if (!r.accepted) throw new Error(`expected accepted, got ${r.reason}`);
  return r.quote;
};
const reason = (r: ValidationResult): string => (r.accepted ? 'accepted' : r.reason);

describe('validateQuote: accepts a good quote (control)', () => {
  it('accepts a normal first quote and a normal follow-up', () => {
    const first = validateQuote(raw(), null, null, NOW);
    expect(first.accepted).toBe(true);
    const second = validateQuote(
      raw({ providerTs: T(-800_000), bid: '100.05', ask: '100.07' }),
      accepted(first),
      null,
      NOW,
    );
    expect(second.accepted).toBe(true);
    expect(accepted(second).gapConfirmed).toBeUndefined();
  });
  it('accepts exactly 2 s in the future and an equal timestamp (boundaries are inclusive)', () => {
    expect(validateQuote(raw({ providerTs: T(2000) }), null, null, NOW).accepted).toBe(true);
    const last = accepted(validateQuote(raw(), null, null, NOW));
    expect(validateQuote(raw({ providerTs: last.providerTs }), last, null, NOW).accepted).toBe(
      true,
    );
  });
  it('accepts a locked market (bid equals ask)', () => {
    expect(validateQuote(raw({ bid: '100.00', ask: '100.00' }), null, null, NOW).accepted).toBe(
      true,
    );
  });
});

describe('validateQuote: every rejection reason (each with its control above)', () => {
  it.each([
    ['bid zero', { bid: '0' }, 'NON_POSITIVE_PRICE'],
    ['ask zero', { ask: '0.00' }, 'NON_POSITIVE_PRICE'],
    ['bid negative', { bid: '-1.00' }, 'NON_POSITIVE_PRICE'],
    ['ask negative', { ask: '-0.01' }, 'NON_POSITIVE_PRICE'],
    ['last zero', { last: '0' }, 'NON_POSITIVE_PRICE'],
    ['crossed by one tick', { bid: '100.03', ask: '100.02' }, 'CROSSED'],
    ['future by 2.001 s', { providerTs: T(2001) }, 'FUTURE_TIMESTAMP'],
    ['future by an hour', { providerTs: T(3_600_000) }, 'FUTURE_TIMESTAMP'],
    ['negative bid size', { bidSize: '-1' }, 'NEGATIVE_SIZE'],
    ['negative ask size', { askSize: '-100' }, 'NEGATIVE_SIZE'],
    ['negative last size', { lastSize: '-0.5' }, 'NEGATIVE_SIZE'],
    ['malformed bid (exponent)', { bid: '1e2' }, 'MALFORMED'],
    ['malformed ask (NaN)', { ask: 'NaN' }, 'MALFORMED'],
    ['malformed size', { bidSize: 'ten' }, 'MALFORMED'],
    ['invalid timestamp', { providerTs: new Date('nope') }, 'MALFORMED'],
  ] as Array<[string, Partial<RawQuote>, string]>)('rejects %s as %s', (_n, over, why) => {
    const r = validateQuote(raw(over), null, null, NOW);
    expect(reason(r)).toBe(why);
  });

  it('rejects a quote older than the last accepted one as OUT_OF_ORDER', () => {
    const last = accepted(validateQuote(raw({ providerTs: T(-100_000) }), null, null, NOW));
    expect(reason(validateQuote(raw({ providerTs: T(-100_001) }), last, null, NOW))).toBe(
      'OUT_OF_ORDER',
    );
    expect(validateQuote(raw({ providerTs: T(-100_000) }), last, null, NOW).accepted).toBe(true); // control
  });

  it('never rewrites a rejected quote (nothing is silently fixed)', () => {
    const r = validateQuote(raw({ bid: '100.03', ask: '100.02' }), null, null, NOW);
    expect(r.accepted).toBe(false);
    expect('quote' in r).toBe(false);
  });
});

describe('validateQuote: outliers need a second consecutive tick', () => {
  const last = accepted(validateQuote(raw({ providerTs: T(-100_000) }), null, null, NOW)); // mid 100.01
  const jump = (n: number, ts: number): RawQuote =>
    raw({ providerTs: T(ts), bid: String(n), ask: String(n + 1) });

  it('exactly 10% is not an outlier; just over 10% is held as pending', () => {
    // previous mid 100.01; 110.01 is exactly +10%
    expect(
      validateQuote(raw({ providerTs: T(-90_000), bid: '110.00', ask: '110.02' }), last, null, NOW)
        .accepted,
    ).toBe(true);
    const held = validateQuote(
      raw({ providerTs: T(-90_000), bid: '110.01', ask: '110.03' }),
      last,
      null,
      NOW,
    );
    expect(reason(held)).toBe('OUTLIER_UNCONFIRMED');
    expect(held.nextPending).not.toBeNull();
  });

  it('a confirming second tick is accepted with gapConfirmed and clears the pending state', () => {
    const first = validateQuote(jump(150, -90_000), last, null, NOW);
    expect(reason(first)).toBe('OUTLIER_UNCONFIRMED');
    const second = validateQuote(jump(151, -80_000), last, first.nextPending, NOW);
    expect(second.accepted).toBe(true);
    expect(accepted(second).gapConfirmed).toBe(true);
    expect(second.nextPending).toBeNull();
  });

  it('an unconfirmed outlier is discarded: the next normal tick is accepted without the flag', () => {
    const first = validateQuote(jump(150, -90_000), last, null, NOW);
    const normal = validateQuote(
      raw({ providerTs: T(-80_000), bid: '100.04', ask: '100.06' }),
      last,
      first.nextPending,
      NOW,
    );
    expect(normal.accepted).toBe(true);
    expect(accepted(normal).gapConfirmed).toBeUndefined();
    expect(normal.nextPending).toBeNull();
  });

  it('a second outlier at a different level replaces the pending tick instead of confirming it', () => {
    const first = validateQuote(jump(150, -90_000), last, null, NOW);
    const other = validateQuote(jump(60, -80_000), last, first.nextPending, NOW);
    expect(reason(other)).toBe('OUTLIER_UNCONFIRMED');
    expect(other.nextPending?.mid).not.toBe(first.nextPending?.mid);
  });

  it('a tick rejected for another reason leaves the pending state untouched', () => {
    const first = validateQuote(jump(150, -90_000), last, null, NOW);
    const crossed = validateQuote(raw({ bid: '200', ask: '100' }), last, first.nextPending, NOW);
    expect(reason(crossed)).toBe('CROSSED');
    expect(crossed.nextPending).toEqual(first.nextPending);
  });

  it('a big drop is an outlier too', () => {
    expect(reason(validateQuote(jump(50, -90_000), last, null, NOW))).toBe('OUTLIER_UNCONFIRMED');
  });

  it('with no previous quote there is nothing to compare, so a first tick is accepted', () => {
    expect(validateQuote(jump(5000, -90_000), null, null, NOW).accepted).toBe(true);
  });
});

describe('validateQuote: tick size is a warning only', () => {
  it('flags a price off the tick but still accepts it (control: on the tick has no warning)', () => {
    const off = validateQuote(raw({ bid: '100.005', ask: '100.02' }), null, null, NOW, {
      tickSize: '0.01',
    });
    expect(off.accepted && off.warnings).toEqual(['NOT_ON_TICK']);
    const on = validateQuote(raw(), null, null, NOW, { tickSize: '0.01' });
    expect(on.accepted && on.warnings).toEqual([]);
  });
});

describe('validateQuote: properties', () => {
  const digits = (lo: number, hi: number) =>
    fc.stringMatching(new RegExp(`^[0-9]{${String(lo)},${String(hi)}}$`));
  const price = fc
    .tuple(digits(1, 6), digits(0, 4))
    .map(([i, f]) => `${i}${f === '' ? '' : `.${f}`}`);

  it('never accepts a crossed quote, whatever else is true', () => {
    fc.assert(
      fc.property(price, price, fc.integer({ min: -10_000, max: 10_000 }), (a, b, tsOffset) => {
        fc.pre(compare(parse(a), parse(b)) > 0); // bid=a is strictly greater than ask=b: crossed
        const r = validateQuote(raw({ bid: a, ask: b, providerTs: T(tsOffset) }), null, null, NOW);
        expect(r.accepted).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('never accepts a non-positive or future-dated quote', () => {
    fc.assert(
      fc.property(price, fc.integer({ min: 2001, max: 10_000_000 }), (p, future) => {
        expect(
          validateQuote(raw({ bid: p, ask: p, providerTs: T(future) }), null, null, NOW).accepted,
        ).toBe(false);
        expect(validateQuote(raw({ bid: `-${p}`, ask: p }), null, null, NOW).accepted).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('an accepted quote is always unchanged or only flagged (never rewritten)', () => {
    fc.assert(
      fc.property(price, price, (a, b) => {
        fc.pre(compare(parse(a), parse(b)) <= 0);
        const input = raw({ bid: a, ask: b });
        const r = validateQuote(input, null, null, NOW);
        if (r.accepted) expect(r.quote).toEqual(input);
      }),
      { numRuns: 300 },
    );
  });

  it('pending is only ever set together with a rejection', () => {
    fc.assert(
      fc.property(price, price, (a, b) => {
        const last = accepted(validateQuote(raw({ providerTs: T(-100_000) }), null, null, NOW));
        const r = validateQuote(raw({ bid: a, ask: b, providerTs: T(-90_000) }), last, null, NOW);
        const pending: PendingGap | null = r.nextPending;
        if (r.accepted) expect(pending).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});
