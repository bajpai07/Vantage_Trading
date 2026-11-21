// M8b-2 T4: depth contracts. Valid and invalid levels, non-fresh answers without levels, strict objects, strings for numbers.
import { describe, expect, it } from 'vitest';
import {
  DEPTH_NOTE,
  DepthQuery,
  DepthResponse,
  MyDepthOrder,
  MyDepthOrdersResponse,
} from './index.js';

const level = { price: '90010.00', size: '0.5', cumPct: 40 };
const fresh = {
  symbol: 'BTC-USD',
  freshness: 'REAL_TIME',
  simulated: true,
  quoteAt: '2026-11-10T15:00:00.000Z',
  spread: '20.00',
  mid: '90000.00',
  levels: { bids: [{ ...level, price: '89990.00' }], asks: [level] },
  note: DEPTH_NOTE,
};

describe('DepthQuery', () => {
  it('accepts levels 1 to 25 (and none), upper-cases the symbol', () => {
    expect(DepthQuery.parse({ symbol: 'btc-usd' })).toEqual({ symbol: 'BTC-USD' });
    expect(DepthQuery.parse({ symbol: 'BTC-USD', levels: '1' }).levels).toBe(1);
    expect(DepthQuery.parse({ symbol: 'BTC-USD', levels: '25' }).levels).toBe(25);
  });
  it.each(['0', '26', '1.5', '-1', 'abc', '', '100'])('rejects levels=%s', (levels) => {
    expect(DepthQuery.safeParse({ symbol: 'BTC-USD', levels }).success).toBe(false);
  });
  it('rejects extra parameters and a bad symbol', () => {
    expect(DepthQuery.safeParse({ symbol: 'BTC-USD', x: '1' }).success).toBe(false);
    expect(DepthQuery.safeParse({ symbol: '!!!' }).success).toBe(false);
    expect(DepthQuery.safeParse({}).success).toBe(false);
  });
});

describe('DepthResponse', () => {
  it('accepts a fresh book (control)', () => {
    expect(DepthResponse.safeParse(fresh).success).toBe(true);
  });
  it.each(['STALE', 'CLOSED', 'UNAVAILABLE'])('a %s answer carries no levels', (freshness) => {
    const r = DepthResponse.safeParse({
      ...fresh,
      freshness,
      levels: null,
      spread: null,
      mid: null,
    });
    expect(r.success).toBe(true);
  });
  it('rejects simulated: false, extra fields and numbers where strings belong', () => {
    expect(DepthResponse.safeParse({ ...fresh, simulated: false }).success).toBe(false);
    expect(DepthResponse.safeParse({ ...fresh, extra: 1 }).success).toBe(false);
    expect(
      DepthResponse.safeParse({
        ...fresh,
        levels: { ...fresh.levels, asks: [{ ...level, price: 90010 }] },
      }).success,
    ).toBe(false);
    expect(
      DepthResponse.safeParse({
        ...fresh,
        levels: { ...fresh.levels, asks: [{ ...level, size: 0.5 }] },
      }).success,
    ).toBe(false);
    expect(DepthResponse.safeParse({ ...fresh, spread: 20 }).success).toBe(false);
    expect(
      DepthResponse.safeParse({
        ...fresh,
        levels: { ...fresh.levels, asks: [{ ...level, cumPct: 40.5 }] },
      }).success,
    ).toBe(false);
    expect(
      DepthResponse.safeParse({
        ...fresh,
        levels: { ...fresh.levels, asks: [{ ...level, cumPct: 101 }] },
      }).success,
    ).toBe(false);
    expect(
      DepthResponse.safeParse({
        ...fresh,
        levels: { ...fresh.levels, asks: [{ ...level, extra: 1 }] },
      }).success,
    ).toBe(false);
  });
});

describe('MyDepthOrdersResponse', () => {
  const order = {
    orderId: '2b0a8a0e-0000-4000-8000-000000000001',
    side: 'BUY',
    price: '89970.72',
    qty: '0.0025',
    onBook: true,
    level: 3,
  };
  it('accepts an on-book order and an off-book one (controls)', () => {
    expect(MyDepthOrder.safeParse(order).success).toBe(true);
    expect(MyDepthOrder.safeParse({ ...order, onBook: false, level: null }).success).toBe(true);
  });
  it('rejects numbers for prices, level 0, level 26 and extra fields', () => {
    expect(MyDepthOrder.safeParse({ ...order, price: 89970.72 }).success).toBe(false);
    expect(MyDepthOrder.safeParse({ ...order, level: 0 }).success).toBe(false);
    expect(MyDepthOrder.safeParse({ ...order, level: 26 }).success).toBe(false);
    expect(MyDepthOrder.safeParse({ ...order, userId: 'x' }).success).toBe(false);
    expect(
      MyDepthOrdersResponse.safeParse({
        symbol: 'BTC-USD',
        freshness: 'STALE',
        orders: [order],
        x: 1,
      }).success,
    ).toBe(false);
  });
});
