// M8b-2: the depth view helpers are pure lookups and text. The caller's orders are matched to rows by the server's `level` only.
import { describe, expect, it } from 'vitest';
import type { DepthLevel, MyDepthOrder } from '@vantage/contracts';
import { bookRows, outsideBook, unavailableMessage } from './depth';

const lv = (price: string, size = '1', cumPct = 10): DepthLevel => ({ price, size, cumPct });
const order = (over: Partial<MyDepthOrder>): MyDepthOrder => ({
  orderId: '2b0a8a0e-0000-4000-8000-000000000001',
  side: 'BUY',
  price: '89970.72',
  qty: '0.0025',
  onBook: true,
  level: 3,
  ...over,
});

describe('bookRows', () => {
  const bids = [lv('89990.00'), lv('89980.36'), lv('89970.72')];
  it('puts a BUY order at the row whose level the server named, on the bid side only', () => {
    const rows = bookRows(bids, 'BUY', [order({})]);
    expect(rows.map((r) => r.level)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.mine.length)).toEqual([0, 0, 1]);
    // control: the same order is not shown on the ask side
    expect(bookRows(bids, 'SELL', [order({})]).every((r) => r.mine.length === 0)).toBe(true);
  });
  it('shows nothing for an order that is not on the book, whatever its price string looks like', () => {
    const rows = bookRows(bids, 'BUY', [order({ onBook: false, level: null, price: '89970.72' })]);
    expect(rows.every((r) => r.mine.length === 0)).toBe(true);
  });
  it('keeps the price, size and percent strings exactly as received (no reformatting, no arithmetic)', () => {
    const [r] = bookRows([lv('90010.00', '0.89690034', 9)], 'SELL', []);
    expect(r).toMatchObject({ price: '90010.00', size: '0.89690034', cumPct: 9, level: 1 });
  });
  it('two orders at one level are both listed', () => {
    const rows = bookRows(bids, 'BUY', [order({ orderId: 'a' }), order({ orderId: 'b' })]);
    expect(rows[2]?.mine).toHaveLength(2);
  });
});

describe('outsideBook', () => {
  it('lists only the orders the server said are off the visible book', () => {
    const inside = order({});
    const out = order({ orderId: 'x', onBook: false, level: null, price: '89000.00' });
    expect(outsideBook([inside, out])).toEqual([out]);
    expect(outsideBook([inside])).toEqual([]);
  });
});

describe('unavailableMessage', () => {
  it.each([
    ['STALE', 'Depth unavailable: quote is stale.'],
    ['CLOSED', 'Depth unavailable: market is closed.'],
    ['UNAVAILABLE', 'Depth unavailable: no quote right now.'],
  ])('%s', (state, text) => {
    expect(unavailableMessage(state)).toBe(text);
  });
});
