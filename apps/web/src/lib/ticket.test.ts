import { describe, expect, it } from 'vitest';
import {
  FreshnessState,
  InstrumentStatus,
  MAX_ORDER_QTY,
  ORDER_REJECT_CODES,
} from '@vantage/contracts';
import type { OrderPreviewResponse, OrderResponse } from '@vantage/contracts';
import { networkFailure } from './api-core';
import type { ApiFailure, ApiFailureKind } from './api-core';
import { REJECT_COPY } from './reject-copy';
import { loginUrlFor, safeReturnTo } from './return-to';
import {
  disabledReason,
  initialPreview,
  initialTicket,
  isDigitsOnly,
  isRetryable,
  qtyEmpty,
  qtyTooLarge,
  referencePriceFor,
  sanitizeQty,
  ticketReducer,
} from './ticket';
import type { ReasonInput, TicketAction, TicketState } from './ticket';

const estimate = (over: Partial<OrderPreviewResponse> = {}): OrderPreviewResponse => ({
  wouldFill: true,
  rejectCode: null,
  estimatedPrice: '190.04',
  estimatedNotional: '1900.40',
  estimatedFee: '0.19',
  estimatedCashAfter: '8099.41',
  estimatedProceeds: null,
  slippageBps: '2',
  quote: {
    bid: '189.95',
    ask: '190.00',
    last: '189.97',
    asOf: '2026-11-10T14:45:00.000Z',
    source: 'FIXTURE',
    freshness: 'DELAYED',
  },
  disclaimer: 'Estimate — final price is decided when the order executes.' as never,
  generatedAt: '2026-11-10T15:00:00.000Z',
  ...over,
});

const order = (over: Partial<OrderResponse> = {}): OrderResponse => ({
  id: '11111111-1111-4111-8111-111111111111',
  symbol: 'AAPL',
  side: 'BUY',
  type: 'MARKET',
  status: 'FILLED',
  qty: '10',
  filledQty: '10',
  rejectCode: null,
  createdAt: '2026-11-10T15:00:00.000Z',
  execution: null,
  ...over,
});

const fail = (kind: ApiFailureKind, status = 0): ApiFailure => ({
  ...networkFailure(),
  kind,
  status,
});

function run(actions: readonly TicketAction[], from: TicketState = initialTicket): TicketState {
  return actions.reduce(ticketReducer, from);
}

/** A ticket with a BUY 10 estimate on screen, ready to review. */
const ready = (): TicketState =>
  run([
    { type: 'setQty', qty: '10' },
    {
      type: 'previewStart',
      requestId: 1,
      for: { side: 'BUY', qty: '10', referencePrice: '190.00' },
    },
    { type: 'previewOk', requestId: 1, data: estimate() },
  ]);

describe('quantity input', () => {
  it.each([
    ['10', '10'],
    ['1.5', '15'],
    ['-3', '3'],
    ['1e3', '13'],
    [' 7 ', '7'],
    ['007', '7'],
    ['0', ''],
    ['', ''],
    ['abc', ''],
    ['12345678901', '1234567'],
  ])('sanitizeQty(%j) = %j', (raw, out) => {
    expect(sanitizeQty(raw)).toBe(out);
  });

  it('a paste is refused unless it is only digits', () => {
    expect(isDigitsOnly('25')).toBe(true);
    for (const t of ['1.5', '-1', '1e3', '', ' 1', '١٢']) expect(isDigitsOnly(t), t).toBe(false);
  });

  it('the maximum is compared as text, at the boundary', () => {
    const max = String(MAX_ORDER_QTY);
    expect(qtyTooLarge(max)).toBe(false);
    expect(qtyTooLarge(String(MAX_ORDER_QTY + 1))).toBe(true);
    expect(qtyTooLarge('99999999')).toBe(true);
    expect(qtyEmpty('')).toBe(true);
    expect(qtyEmpty('0')).toBe(true);
    expect(qtyEmpty('1')).toBe(false);
  });

  it('the reference price is the ask for a BUY and the bid for a SELL; none without a quote', () => {
    const q = { bid: '189.95', ask: '190.00' };
    expect(referencePriceFor('BUY', q)).toBe('190.00');
    expect(referencePriceFor('SELL', q)).toBe('189.95');
    expect(referencePriceFor('BUY', {})).toBeNull();
  });
});

describe('idempotency key lifecycle (D-72)', () => {
  it('a new key exists only after the review step is opened, and it is the one given', () => {
    expect(ready().attempt).toBeNull();
    const s = ticketReducer(ready(), { type: 'openReview', key: 'key-1', symbol: 'AAPL' });
    expect(s.phase).toBe('review');
    expect(s.attempt).toMatchObject({
      key: 'key-1',
      side: 'BUY',
      qty: '10',
      referencePrice: '190.00',
    });
  });

  it('a network failure keeps the attempt: the retry is sent with the SAME key', () => {
    const s = run(
      [
        { type: 'openReview', key: 'key-1', symbol: 'AAPL' },
        { type: 'submitStart' },
        { type: 'submitRetryable', failure: fail('network') },
        { type: 'submitStart' },
      ],
      ready(),
    );
    expect(s.phase).toBe('submitting');
    expect(s.attempt?.key).toBe('key-1');
  });

  it.each(['network', 'server', 'rate_limited', 'invalid_response'] as const)(
    '%s is retryable with the same key',
    (kind) => {
      expect(isRetryable(fail(kind))).toBe(true);
      const s = run(
        [
          { type: 'openReview', key: 'k', symbol: 'AAPL' },
          { type: 'submitStart' },
          { type: 'submitRetryable', failure: fail(kind) },
        ],
        ready(),
      );
      expect(s.phase).toBe('review');
      expect(s.attempt?.key).toBe('k');
      expect(s.outcome?.kind).toBe('retryable');
    },
  );

  it.each(['validation', 'forbidden', 'not_found', 'conflict', 'unknown'] as const)(
    '%s is definitive: the key is discarded and the order is not retried',
    (kind) => {
      expect(isRetryable(fail(kind))).toBe(false);
      const s = run(
        [
          { type: 'openReview', key: 'k', symbol: 'AAPL' },
          { type: 'submitStart' },
          { type: 'submitFailed', failure: fail(kind) },
        ],
        ready(),
      );
      expect(s.phase).toBe('done');
      expect(s.attempt).toBeNull();
    },
  );

  it('a fill or a reject discards the key', () => {
    for (const o of [order(), order({ status: 'REJECTED', rejectCode: 'PRICE_MOVED' })]) {
      const s = run(
        [
          { type: 'openReview', key: 'k', symbol: 'AAPL' },
          { type: 'submitStart' },
          { type: 'submitDone', order: o },
        ],
        ready(),
      );
      expect(s.attempt).toBeNull();
      expect(s.outcome?.kind).toBe(o.status === 'FILLED' ? 'filled' : 'rejected');
    }
  });

  it('cancelling the review discards the key; the next review gets a new one', () => {
    const cancelled = run(
      [{ type: 'openReview', key: 'old', symbol: 'AAPL' }, { type: 'cancelReview' }],
      ready(),
    );
    expect(cancelled.attempt).toBeNull();
    expect(cancelled.phase).toBe('idle');
    const again = ticketReducer(cancelled, { type: 'openReview', key: 'new', symbol: 'AAPL' });
    expect(again.attempt?.key).toBe('new');
  });

  it('editing side or quantity during review closes it, drops the key and the stale estimate', () => {
    for (const edit of [
      { type: 'setQty', qty: '11' } as const,
      { type: 'setSide', side: 'SELL' } as const,
    ]) {
      const s = run([{ type: 'openReview', key: 'old', symbol: 'AAPL' }, edit], ready());
      expect(s.phase).toBe('idle');
      expect(s.attempt).toBeNull();
      expect(s.preview.data).toBeNull();
      expect(s.preview.status).toBe('none');
    }
  });

  it('setting the same value again is not an edit (the attempt survives)', () => {
    const s = run(
      [
        { type: 'openReview', key: 'k', symbol: 'AAPL' },
        { type: 'setQty', qty: '10' },
        { type: 'setSide', side: 'BUY' },
      ],
      ready(),
    );
    expect(s.attempt?.key).toBe('k');
  });

  it('while the request is in flight, edits and a second submit do nothing', () => {
    const inflight = run(
      [{ type: 'openReview', key: 'k', symbol: 'AAPL' }, { type: 'submitStart' }],
      ready(),
    );
    expect(ticketReducer(inflight, { type: 'setQty', qty: '99' })).toBe(inflight);
    expect(ticketReducer(inflight, { type: 'setSide', side: 'SELL' })).toBe(inflight);
    expect(ticketReducer(inflight, { type: 'submitStart' })).toBe(inflight);
    expect(ticketReducer(inflight, { type: 'cancelReview' })).toBe(inflight);
  });

  it('after a reject, "review again" goes back to the form with no estimate and no key', () => {
    const s = run(
      [
        { type: 'openReview', key: 'k', symbol: 'AAPL' },
        { type: 'submitStart' },
        { type: 'submitDone', order: order({ status: 'REJECTED', rejectCode: 'PRICE_MOVED' }) },
        { type: 'reviewAgain' },
      ],
      ready(),
    );
    expect(s).toMatchObject({ phase: 'idle', attempt: null, outcome: null });
    expect(s.preview.data).toBeNull();
    expect(s.qty).toBe('10'); // what the user typed is kept
  });
});

describe('reviewing needs the estimate of what is on the form', () => {
  it('cannot open the review without a ready estimate, for a reject, or for another quantity', () => {
    const open: TicketAction = { type: 'openReview', key: 'k', symbol: 'AAPL' };
    expect(ticketReducer(initialTicket, open)).toBe(initialTicket);
    const rejected = run([
      { type: 'setQty', qty: '10' },
      {
        type: 'previewStart',
        requestId: 1,
        for: { side: 'BUY', qty: '10', referencePrice: '190.00' },
      },
      {
        type: 'previewOk',
        requestId: 1,
        data: estimate({ wouldFill: false, rejectCode: 'INSUFFICIENT_BUYING_POWER' }),
      },
    ]);
    expect(ticketReducer(rejected, open)).toBe(rejected);
    expect(ticketReducer(ready(), open).phase).toBe('review'); // control
  });

  it('only the newest preview answer is used', () => {
    const s = run([
      { type: 'setQty', qty: '10' },
      {
        type: 'previewStart',
        requestId: 1,
        for: { side: 'BUY', qty: '10', referencePrice: '190.00' },
      },
      {
        type: 'previewStart',
        requestId: 2,
        for: { side: 'BUY', qty: '10', referencePrice: '191.00' },
      },
      { type: 'previewOk', requestId: 1, data: estimate({ estimatedPrice: '1.00' }) },
    ]);
    expect(s.preview.data).toBeNull();
    const t = ticketReducer(s, { type: 'previewOk', requestId: 2, data: estimate() });
    expect(t.preview.data?.estimatedPrice).toBe('190.04');
  });

  it('a price-only re-preview keeps the old estimate on screen, marked loading; a new quantity does not', () => {
    const price = ticketReducer(ready(), {
      type: 'previewStart',
      requestId: 2,
      for: { side: 'BUY', qty: '10', referencePrice: '191.00' },
    });
    expect(price.preview.status).toBe('loading');
    expect(price.preview.data).not.toBeNull();
    const qty = run([{ type: 'setQty', qty: '11' }], ready());
    expect(qty.preview.data).toBeNull();
  });

  it('the reviewed estimate is frozen: a preview that arrives during review changes nothing', () => {
    const s = run([{ type: 'openReview', key: 'k', symbol: 'AAPL' }], ready());
    const t = ticketReducer(s, {
      type: 'previewStart',
      requestId: 5,
      for: { side: 'BUY', qty: '10', referencePrice: '200.00' },
    });
    expect(t).toBe(s);
  });
});

describe('disabledReason: every state that blocks an order says why', () => {
  const base = (over: Partial<ReasonInput> = {}): ReasonInput => ({
    symbol: 'AAPL',
    side: 'BUY',
    qty: '10',
    status: 'ACTIVE',
    quote: { freshness: 'DELAYED', bid: '189.95', ask: '190.00' },
    refreshFailed: false,
    positionQty: '20',
    preview: { ...initialPreview, status: 'ready', data: estimate() },
    submitting: false,
    ...over,
  });

  it('control: everything fine is allowed', () => {
    expect(disabledReason(base())).toBeNull();
    expect(disabledReason(base({ side: 'SELL' }))).toBeNull();
  });

  it('every instrument status on both sides: blocked exactly as the engine blocks it', () => {
    const blocked = {
      ACTIVE: [],
      SELL_ONLY: ['BUY'],
      HALTED: ['BUY', 'SELL'],
      DELISTED: ['BUY', 'SELL'],
    };
    for (const status of InstrumentStatus.options) {
      for (const side of ['BUY', 'SELL'] as const) {
        const r = disabledReason(base({ status, side }));
        if (blocked[status].includes(side as never)) {
          expect(r, `${status} ${side}`).toBeTruthy();
          expect(r).not.toContain(status);
        } else expect(r, `${status} ${side}`).toBeNull();
      }
    }
  });

  it('every freshness state: only REAL_TIME and DELAYED allow an order; the others say why', () => {
    for (const freshness of FreshnessState.options) {
      const usable = freshness === 'REAL_TIME' || freshness === 'DELAYED';
      const r = disabledReason(base({ quote: { freshness, bid: '1.00', ask: '1.01' } }));
      if (usable) expect(r, freshness).toBeNull();
      else expect(r, freshness).toMatch(/price|market/i);
    }
  });

  it('no bid or ask, a failed refresh, empty, zero and too large quantities', () => {
    expect(disabledReason(base({ quote: { freshness: 'DELAYED' } }))).toContain('no usable price');
    expect(disabledReason(base({ refreshFailed: true }))).toContain('refresh the price');
    expect(disabledReason(base({ qty: '' }))).toBe('Enter a quantity.');
    expect(disabledReason(base({ qty: '0' }))).toBe('Enter a quantity.');
    expect(disabledReason(base({ qty: String(MAX_ORDER_QTY + 1) }))).toContain(
      'most you can order',
    );
  });

  it('selling with no position says so; an unknown position is left to the preview (control)', () => {
    expect(disabledReason(base({ side: 'SELL', positionQty: null }))).toBe(
      'You do not own any AAPL to sell.',
    );
    expect(disabledReason(base({ side: 'SELL', positionQty: '0' }))).toContain('do not own');
    expect(disabledReason(base({ side: 'SELL', positionQty: undefined }))).toBeNull();
    expect(disabledReason(base({ side: 'BUY', positionQty: null }))).toBeNull();
  });

  it('in flight, and while the estimate is loading or failed', () => {
    expect(disabledReason(base({ submitting: true }))).toContain('Placing');
    expect(disabledReason(base({ preview: initialPreview }))).toContain('Calculating');
    expect(disabledReason(base({ preview: { ...initialPreview, status: 'loading' } }))).toContain(
      'Calculating',
    );
    expect(disabledReason(base({ preview: { ...initialPreview, status: 'error' } }))).toContain(
      "couldn't calculate",
    );
  });

  it('all 13 reject codes: a previewed reject disables the button with that code’s own sentence', () => {
    expect(ORDER_REJECT_CODES).toHaveLength(13);
    for (const code of ORDER_REJECT_CODES) {
      const r = disabledReason(
        base({
          preview: {
            ...initialPreview,
            status: 'ready',
            data: estimate({ wouldFill: false, rejectCode: code }),
          },
        }),
      );
      expect(r, code).toBe(REJECT_COPY[code]);
      expect(r).not.toContain(code);
    }
  });
});

describe('return-to after a session expires mid-order', () => {
  it.each([
    ['/portfolio', '/portfolio'],
    ['/orders', '/orders'],
    ['/activity', '/activity'],
    ['/instruments/AAPL', '/instruments/AAPL'],
    ['/instruments/BRK.B', '/instruments/BRK.B'],
  ])('%s is accepted', (p, out) => {
    expect(safeReturnTo(p)).toBe(out);
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/instruments/../admin',
    '/instruments/AAPL?x=1',
    '/login',
    '/api/v1/auth/logout',
    '',
    '/instruments/',
  ])('%j falls back to the portfolio', (p) => {
    expect(safeReturnTo(p)).toBe('/portfolio');
  });

  it('non-strings fall back too, and the login URL carries the page back', () => {
    for (const v of [undefined, null, 5, ['/orders'], {}])
      expect(safeReturnTo(v)).toBe('/portfolio');
    expect(loginUrlFor('/instruments/AAPL')).toBe(
      '/login?reason=expired&next=%2Finstruments%2FAAPL',
    );
    expect(loginUrlFor('/something-else')).toBe('/login?reason=expired');
  });
});
