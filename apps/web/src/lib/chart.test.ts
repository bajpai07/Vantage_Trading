import { describe, expect, it } from 'vitest';
import { scaleSeries, toScaledBigInt } from './chart';

describe('toScaledBigInt: exact, no floats', () => {
  it.each([
    ['10049.60', 1004960000000n],
    ['0.00', 0n],
    ['-5.17', -517000000n],
    ['0.12345678', 12345678n],
    ['1', 100000000n],
    ['12345678901234567890.12345678', 1234567890123456789012345678n],
  ])('%s', (v, n) => {
    expect(toScaledBigInt(v)).toBe(n);
  });
  it.each(['', 'abc', '1e3', '1,000.00', '+1'])('not a plain decimal: %s -> null', (v) => {
    expect(toScaledBigInt(v)).toBeNull();
  });
  it('values a float cannot hold keep their exact order', () => {
    const a = toScaledBigInt('9007199254740993.00') as bigint;
    const b = toScaledBigInt('9007199254740992.00') as bigint;
    expect(a > b).toBe(true); // 2^53 + 1 versus 2^53: equal as floats, different here
  });
});

describe('scaleSeries', () => {
  it('puts the first value at the left, the last at the right, the highest at the top (y = 0) and the lowest at the bottom', () => {
    const pts = scaleSeries(['10000.00', '10049.60', '9900.00'], 400, 100);
    expect(pts).toEqual([
      { x: 0, y: 34 }, // (10000 - 9900) / (10049.60 - 9900) = 0.668: 66 of 100 px up from the bottom, so y = 34
      { x: 200, y: 0 },
      { x: 400, y: 100 },
    ]);
  });

  it('a flat series is drawn through the middle', () => {
    expect(scaleSeries(['10000.00', '10000.00', '10000.00'], 300, 100)).toEqual([
      { x: 0, y: 50 },
      { x: 150, y: 50 },
      { x: 300, y: 50 },
    ]);
  });

  it('fewer than two values, or any invalid value, gives no chart (the screen then hides it)', () => {
    expect(scaleSeries([], 100, 100)).toBeNull();
    expect(scaleSeries(['10000.00'], 100, 100)).toBeNull();
    expect(scaleSeries(['10000.00', 'oops'], 100, 100)).toBeNull();
  });

  it('every point lies inside the box', () => {
    const pts = scaleSeries(['1.00', '1000000.00', '-500.25', '3.14', '999999.99'], 600, 140) ?? [];
    expect(pts).toHaveLength(5);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(600);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(140);
    }
  });
});
