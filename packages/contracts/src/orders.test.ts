import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_KEY_PATTERN,
  ListOrdersQuery,
  MAX_ORDER_QTY,
  ORDER_ERROR_CODES,
  ORDER_REJECT_CODES,
  OrderResponse,
  PlaceOrderRequest,
  PositionResponse,
} from './index.js';

const valid = { symbol: 'aapl', side: 'BUY', type: 'MARKET', qty: '10', referencePrice: '190.00' };
const fails = (over: Record<string, unknown>): boolean =>
  !PlaceOrderRequest.safeParse({ ...valid, ...over }).success;

describe('PlaceOrderRequest', () => {
  it('accepts a valid request and upper-cases the symbol (control)', () => {
    const r = PlaceOrderRequest.parse(valid);
    expect(r).toEqual({
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      qty: '10',
      referencePrice: '190.00',
    });
  });

  it('qty: a JSON integer and a digit string normalise to the same digit string (control)', () => {
    expect(PlaceOrderRequest.parse({ ...valid, qty: 10 }).qty).toBe('10');
    expect(PlaceOrderRequest.parse({ ...valid, qty: '10' }).qty).toBe('10');
    expect(PlaceOrderRequest.parse({ ...valid, qty: MAX_ORDER_QTY }).qty).toBe(
      String(MAX_ORDER_QTY),
    );
  });

  it('qty (M8): a decimal with at most 8 decimals is accepted and normalised to one canonical spelling', () => {
    const q = (qty: unknown) => PlaceOrderRequest.parse({ ...valid, qty }).qty;
    expect(q('0.0025')).toBe('0.0025');
    expect(q('0.00250000')).toBe('0.0025'); // trailing zeros removed
    expect(q('10.0')).toBe('10'); // and a bare dot
    expect(q('1.50')).toBe('1.5');
    expect(q('0.00000001')).toBe('0.00000001'); // the smallest step
    expect(q('999999.99999999')).toBe('999999.99999999');
    expect(q('1000000.00')).toBe('1000000'); // the maximum, spelled with zeros
  });

  it.each([
    ['nine decimals', '0.000000001'],
    ['exponent', '1.5e-3'],
    ['exponent upper case', '1E3'],
    ['leading dot', '.5'],
    ['trailing dot', '5.'],
    ['leading zeros', '00.5'],
    ['sign', '-0.5'],
    ['plus', '+0.5'],
    ['comma', '0,5'],
    ['zero with decimals', '0.00000000'],
    ['zero', '0.0'],
    ['one step over the maximum', '1000000.00000001'],
    ['two dots', '1.2.3'],
    ['thousands separator', '1_000'],
    ['text', 'abc'],
    ['whitespace', '0.5 '],
  ])('qty (M8) rejects %s', (_name, qty) => {
    expect(fails({ qty })).toBe(true);
  });

  it.each([
    ['float 10.5', 10.5],
    ['float 1.0e-7', 1e-7],
    ['zero', 0],
    ['zero string', '0'],
    ['negative', -1],
    ['negative string', '-1'],
    ['leading zero', '010'],
    ['plus sign', '+5'],
    ['exponent string', '1e3'],
    ['hex', '0x10'],
    ['empty', ''],
    ['spaces', ' 5'],
    ['one over the maximum', MAX_ORDER_QTY + 1],
    ['huge string', '99999999999999999999'],
    ['unsafe integer', 2 ** 60],
    ['Infinity as text', 'Infinity'],
    ['NaN as text', 'NaN'],
    ['null', null],
    ['boolean', true],
    ['array', [1]],
  ])('qty rejects %s', (_name, qty) => {
    expect(fails({ qty })).toBe(true);
  });

  it.each([
    ['a number instead of a string', 190],
    ['a float number', 190.5],
    ['negative', '-1.00'],
    ['zero', '0'],
    ['zero with decimals', '0.00'],
    ['exponent', '1e2'],
    ['comma', '1,5'],
    ['too many decimals', '1.123456789'],
    ['too many integer digits', '1234567890123.00'],
    ['empty', ''],
    ['text', 'abc'],
    ['leading plus', '+5'],
    ['trailing dot', '5.'],
  ])('referencePrice rejects %s', (_name, referencePrice) => {
    expect(fails({ referencePrice })).toBe(true);
  });

  it('referencePrice accepts plain decimals (controls)', () => {
    for (const p of ['190', '190.00', '0.01', '0.00000001', '999999999999.99999999']) {
      expect(PlaceOrderRequest.safeParse({ ...valid, referencePrice: p }).success, p).toBe(true);
    }
  });

  it('rejects every field the client must not send (account id, price, fee, time, client id)', () => {
    for (const extra of [
      { accountId: '0198d0d0-0000-7000-8000-000000000000' },
      { price: '190.00' },
      { fee: '0' },
      { now: '2026-11-10T15:00:00Z' },
      { clientOrderId: 'abc12345' },
      { tradingEnabled: true },
      { extra: 1 },
    ]) {
      expect(fails(extra), JSON.stringify(extra)).toBe(true);
    }
  });

  it('rejects an unknown side, type and a bad symbol; a non-object body', () => {
    expect(fails({ side: 'HOLD' })).toBe(true);
    expect(fails({ side: 'buy' })).toBe(true);
    expect(fails({ type: 'LIMIT' })).toBe(true);
    expect(fails({ symbol: '' })).toBe(true);
    expect(fails({ symbol: 'A B' })).toBe(true);
    expect(fails({ symbol: "AAPL'; DROP TABLE orders;--" })).toBe(true);
    for (const body of [null, 'x', 1, [], undefined]) {
      expect(PlaceOrderRequest.safeParse(body).success).toBe(false);
    }
  });

  it('every required field is required', () => {
    for (const k of Object.keys(valid)) {
      const copy: Record<string, unknown> = { ...valid };
      delete copy[k];
      expect(PlaceOrderRequest.safeParse(copy).success, k).toBe(false);
    }
  });
});

describe('Idempotency-Key pattern (D-58 amendment)', () => {
  it.each([
    'abcdefgh',
    'a'.repeat(128),
    'order:2026-11-10.abc_def-1',
    'AbCd1234',
    '0198d0d0-1111-7000',
  ])('accepts %s', (k) => expect(IDEMPOTENCY_KEY_PATTERN.test(k)).toBe(true));
  it.each([
    ['too short', 'abcdefg'],
    ['too long', 'a'.repeat(129)],
    ['space', 'abcd efgh'],
    ['slash', 'abcd/efgh'],
    ['non-ascii', 'abcdefghé'],
    ['newline', 'abcdefgh\n'],
    ['quote', "abcdefgh'"],
    ['empty', ''],
  ])('rejects %s', (_n, k) => expect(IDEMPOTENCY_KEY_PATTERN.test(k)).toBe(false));
});

describe('ListOrdersQuery', () => {
  it('accepts an empty query, limit 1 and 100, filters (controls)', () => {
    expect(ListOrdersQuery.parse({})).toEqual({});
    expect(ListOrdersQuery.parse({ limit: '1' }).limit).toBe(1);
    expect(ListOrdersQuery.parse({ limit: '100' }).limit).toBe(100);
    expect(ListOrdersQuery.parse({ status: 'FILLED', symbol: 'msft', cursor: 'abc' })).toEqual({
      status: 'FILLED',
      symbol: 'MSFT',
      cursor: 'abc',
    });
  });
  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: '-1' },
    { limit: '1.5' },
    { limit: 'abc' },
    { limit: '' },
    { status: 'OPEN' },
    { status: 'filled' },
    { symbol: 'A B' },
    { cursor: '' },
    { cursor: 'x'.repeat(201) },
    { unknown: '1' },
  ])('rejects %j', (q) => expect(ListOrdersQuery.safeParse(q).success).toBe(false));
});

describe('responses and code lists', () => {
  const order = {
    id: '0198d0d0-1111-7000-8000-000000000001',
    symbol: 'AAPL',
    side: 'BUY',
    type: 'MARKET',
    status: 'FILLED',
    qty: '10',
    filledQty: '10',
    rejectCode: null,
    createdAt: '2026-11-10T15:00:00.000Z',
    execution: {
      id: '0198d0d0-1111-7000-8000-000000000002',
      qty: '10',
      price: '190.04',
      notional: '1900.40',
      fee: '0.00',
      slippageBps: '2',
      executedAt: '2026-11-10T15:00:00.000Z',
      quoteSource: 'FIXTURE',
    },
  };
  it('an order response is strict and money is a string (control + failures)', () => {
    expect(OrderResponse.safeParse(order).success).toBe(true);
    expect(OrderResponse.safeParse({ ...order, qty: 10 }).success).toBe(false);
    expect(OrderResponse.safeParse({ ...order, secret: 'x' }).success).toBe(false);
    expect(
      OrderResponse.safeParse({ ...order, execution: { ...order.execution, price: 190.04 } })
        .success,
    ).toBe(false);
    expect(OrderResponse.safeParse({ ...order, rejectCode: 'NOPE' }).success).toBe(false);
    expect(
      OrderResponse.safeParse({
        ...order,
        status: 'REJECTED',
        rejectCode: 'STALE_QUOTE',
        execution: null,
      }).success,
    ).toBe(true);
  });
  it('a position response carries no market value or P&L', () => {
    expect(
      PositionResponse.safeParse({ symbol: 'AAPL', qty: '10', avgCost: '190.04' }).success,
    ).toBe(true);
    expect(
      PositionResponse.safeParse({
        symbol: 'AAPL',
        qty: '10',
        avgCost: '190.04',
        marketValue: '1',
      }).success,
    ).toBe(false);
  });
  it('the code lists are stable and unique', () => {
    expect(new Set(ORDER_REJECT_CODES).size).toBe(ORDER_REJECT_CODES.length);
    expect(ORDER_REJECT_CODES).toContain('FEE_EXCEEDS_PROCEEDS');
    expect(ORDER_REJECT_CODES).toHaveLength(14);
    expect(new Set(ORDER_ERROR_CODES).size).toBe(ORDER_ERROR_CODES.length);
    expect(ORDER_ERROR_CODES).toContain('IDEMPOTENCY_MISMATCH');
  });
});
