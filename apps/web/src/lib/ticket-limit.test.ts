// M8b-1 (D-93, D-97): the limit order in the ticket's pure state machine and helpers, and the order view helpers. Text in, text
// out: nothing here converts to a number or calculates; a property test proves the sanitiser only ever yields digits and one dot.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { OrderPreviewResponse, OrderResponse } from '@vantage/contracts';
import { heldLabel, releasedSentence, STATUS_CHIPS, typeLabel } from './orders-view';
import {
  disabledReason,
  initialPreview,
  initialTicket,
  orderRequestBody,
  sanitizeLimitPrice,
  tickMessage,
  ticketReducer,
} from './ticket';
import type { ReasonInput, TicketAction, TicketState } from './ticket';

const estimate = (over: Partial<OrderPreviewResponse> = {}): OrderPreviewResponse => ({
  wouldFill: false,
  rejectCode: null,
  estimatedPrice: null,
  estimatedNotional: null,
  estimatedFee: null,
  estimatedCashAfter: '9775.02525',
  estimatedProceeds: null,
  slippageBps: null,
  reserveUsd: '224.97475',
  marketable: false,
  expiresAt: '2027-02-08T15:00:00.000Z',
  maxQty: '0.1109',
  quote: {
    bid: '89990.00',
    ask: '90010.00',
    last: null,
    asOf: '2026-11-10T14:45:00.000Z',
    source: 'FIXTURE',
    freshness: 'DELAYED',
  },
  disclaimer: 'Estimate — final price is decided when the order executes.' as never,
  generatedAt: '2026-11-10T15:00:00.000Z',
  ...over,
});

const run = (actions: readonly TicketAction[], from: TicketState = initialTicket): TicketState =>
  actions.reduce(ticketReducer, from);

const limitReady = (over: Partial<OrderPreviewResponse> = {}): TicketState =>
  run([
    { type: 'setKind', kind: 'LIMIT' },
    { type: 'setQty', qty: '0.0025' },
    { type: 'setLimitPrice', limitPrice: '89900.00' },
    { type: 'setTif', tif: 'GTC' },
    {
      type: 'previewStart',
      requestId: 1,
      for: {
        side: 'BUY',
        qty: '0.0025',
        referencePrice: '',
        kind: 'LIMIT',
        limitPrice: '89900.00',
        tif: 'GTC',
      },
    },
    { type: 'previewOk', requestId: 1, data: estimate(over) },
  ]);

describe('sanitizeLimitPrice: digits and one dot, at most 12 integer digits and 8 decimals, no sign or exponent', () => {
  it.each([
    ['89900.00', '89900.00'],
    ['89900', '89900'],
    ['.5', '0.5'],
    ['00.5', '0.5'],
    ['1.123456789', '1.12345678'],
    ['1e5', '15'],
    ['-5', '5'],
    ['1,000.5', '1000.5'],
    ['1.2.3', '1.23'],
    ['1234567890123', '123456789012'],
    ['1.', '1.'],
    ['abc', ''],
    ['', ''],
  ])('sanitizeLimitPrice(%j) = %j', (raw, out) => {
    expect(sanitizeLimitPrice(raw)).toBe(out);
  });
  it('the output only ever has digits and at most one dot, at most 12 + 8 digits (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        const out = sanitizeLimitPrice(raw);
        expect(out).toMatch(/^(\d*|\d+\.\d*)$/);
        expect((out.split('.')[0] ?? '').length).toBeLessThanOrEqual(12);
        expect((out.split('.')[1] ?? '').length).toBeLessThanOrEqual(8);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('tickMessage: more decimals than the tick cannot be a multiple of it', () => {
  it('names the tick; a price with the tick decimals or fewer passes (control)', () => {
    expect(tickMessage('89900.005', '0.01')).toBe('The limit price must be a multiple of 0.01.');
    expect(tickMessage('89900.01', '0.01')).toBeNull();
    expect(tickMessage('89900', '0.01')).toBeNull();
    expect(tickMessage('0.123456', '0.00001')).toBe(
      'The limit price must be a multiple of 0.00001.',
    );
    expect(tickMessage('0.12345', '0.00001')).toBeNull();
    expect(tickMessage('1.5', undefined)).toBeNull();
  });
});

describe('orderRequestBody: one body for the preview and the order', () => {
  const base = {
    symbol: 'BTC-USD',
    side: 'BUY' as const,
    qty: '0.0025',
    referencePrice: '90010.00',
    limitPrice: '89900.00',
    tif: 'GTC' as const,
  };
  it('a MARKET order carries the reference price and no limit fields; a LIMIT order the reverse', () => {
    expect(orderRequestBody({ ...base, kind: 'MARKET' })).toEqual({
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'MARKET',
      qty: '0.0025',
      referencePrice: '90010.00',
    });
    expect(orderRequestBody({ ...base, kind: 'LIMIT' })).toEqual({
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'LIMIT',
      qty: '0.0025',
      limitPrice: '89900.00',
      tif: 'GTC',
    });
  });
});

describe('the limit order in the state machine', () => {
  it('changing the type, the limit price or the time in force discards the estimate and any review', () => {
    const s = limitReady();
    expect(s.preview.status).toBe('ready');
    for (const a of [
      { type: 'setKind', kind: 'MARKET' } as const,
      { type: 'setLimitPrice', limitPrice: '89800.00' } as const,
      { type: 'setTif', tif: 'DAY' } as const,
    ]) {
      const e = ticketReducer(s, a);
      expect(e.preview.data).toBeNull();
      expect(e.phase).toBe('idle');
    }
    // the same value again changes nothing (control)
    expect(ticketReducer(s, { type: 'setTif', tif: 'GTC' })).toBe(s);
  });

  it('a limit order that would REST (no reject code, wouldFill false) can be reviewed; one that would be rejected cannot', () => {
    const rest = ticketReducer(limitReady(), { type: 'openReview', key: 'k1', symbol: 'BTC-USD' });
    expect(rest.phase).toBe('review');
    expect(rest.attempt).toMatchObject({
      kind: 'LIMIT',
      limitPrice: '89900.00',
      tif: 'GTC',
      key: 'k1',
    });
    const rejected = ticketReducer(limitReady({ rejectCode: 'INSUFFICIENT_BUYING_POWER' }), {
      type: 'openReview',
      key: 'k2',
      symbol: 'BTC-USD',
    });
    expect(rejected.phase).toBe('idle'); // not reviewable
    // a preview for another limit price is not the estimate of what is on the form
    const stale = run([{ type: 'setLimitPrice', limitPrice: '89800.00' }], limitReady());
    expect(ticketReducer(stale, { type: 'openReview', key: 'k3', symbol: 'BTC-USD' }).phase).toBe(
      'idle',
    );
  });

  it('an ACCEPTED order is its own outcome (resting), distinct from filled and rejected; the key is discarded after it', () => {
    const reviewing = ticketReducer(limitReady(), {
      type: 'openReview',
      key: 'k1',
      symbol: 'BTC-USD',
    });
    const submitting = ticketReducer(reviewing, { type: 'submitStart' });
    const order = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'ACCEPTED',
    } as OrderResponse;
    const done = ticketReducer(submitting, { type: 'submitDone', order });
    expect(done.outcome?.kind).toBe('accepted');
    expect(done.attempt).toBeNull(); // a definitive answer: the key is discarded
    expect(
      ticketReducer(submitting, {
        type: 'submitDone',
        order: { ...order, status: 'FILLED' } as OrderResponse,
      }).outcome?.kind,
    ).toBe('filled');
    expect(
      ticketReducer(submitting, {
        type: 'submitDone',
        order: { ...order, status: 'REJECTED' } as OrderResponse,
      }).outcome?.kind,
    ).toBe('rejected');
  });
});

describe('disabledReason for a limit order', () => {
  const base = (over: Partial<ReasonInput> = {}): ReasonInput => ({
    symbol: 'BTC-USD',
    side: 'BUY',
    kind: 'LIMIT',
    qty: '0.0025',
    limitPrice: '89900.00',
    tickSize: '0.01',
    tradable: true,
    qtyStep: '0.00000001',
    minQty: '0.00000001',
    status: 'ACTIVE',
    quote: { freshness: 'REAL_TIME', bid: '89990.00', ask: '90010.00' },
    refreshFailed: false,
    positionQty: undefined,
    preview: { ...initialPreview, status: 'ready' },
    submitting: false,
    ...over,
  });
  it('allowed with a quantity and a limit price; asks for the limit price; names the tick', () => {
    expect(disabledReason(base())).toBeNull();
    expect(disabledReason(base({ limitPrice: '' }))).toBe('Enter a limit price.');
    expect(disabledReason(base({ limitPrice: '0.' }))).toBe('Enter a limit price.');
    expect(disabledReason(base({ limitPrice: '89900.005' }))).toBe(
      'The limit price must be a multiple of 0.01.',
    );
  });
  it('a preview that says the order would REST (no reject code, wouldFill false) is not a reason to block; a reject code is', () => {
    const preview = (data: OrderPreviewResponse) => ({
      ...initialPreview,
      status: 'ready' as const,
      data,
    });
    expect(disabledReason(base({ preview: preview(estimate()) }))).toBeNull();
    expect(
      disabledReason(base({ preview: preview(estimate({ rejectCode: 'TICK_VIOLATION' })) })),
    ).toMatch(/price step/);
    expect(
      disabledReason(
        base({ preview: preview(estimate({ rejectCode: 'INSUFFICIENT_BUYING_POWER' })) }),
      ),
    ).toMatch(/enough cash/);
  });
  it('a stale, closed or unavailable quote does NOT block a limit order (it rests), but still blocks a market order (control)', () => {
    for (const freshness of ['STALE', 'CLOSED', 'UNAVAILABLE'] as const) {
      expect(
        disabledReason(base({ quote: { freshness, bid: undefined, ask: undefined } })),
        freshness,
      ).toBeNull();
      expect(
        disabledReason(
          base({ kind: 'MARKET', quote: { freshness, bid: undefined, ask: undefined } }),
        ),
        freshness,
      ).not.toBeNull();
    }
    expect(disabledReason(base({ refreshFailed: true }))).toBeNull();
    expect(disabledReason(base({ kind: 'MARKET', refreshFailed: true }))).toMatch(/can't refresh/);
  });
  it('a SELL that has nothing left to sell says why: nothing owned, or everything is committed to open orders', () => {
    expect(disabledReason(base({ side: 'SELL', positionQty: '0' }))).toBe(
      'You do not own any BTC-USD to sell.',
    );
    expect(
      disabledReason(base({ side: 'SELL', positionQty: '0.0015', positionAvailable: '0' })),
    ).toBe('All of your BTC-USD is already committed to open orders.');
    expect(
      disabledReason(base({ side: 'SELL', positionQty: '0.0015', positionAvailable: '0.0005' })),
    ).toBeNull();
  });
});

describe('order view helpers', () => {
  const order = (over: Partial<OrderResponse> = {}): OrderResponse =>
    ({
      id: '11111111-1111-4111-8111-111111111111',
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'LIMIT',
      status: 'ACCEPTED',
      tif: 'GTC',
      qty: '0.0025',
      filledQty: '0',
      limitPrice: '89900.00',
      reservedUsd: '224.97475',
      expiresAt: '2027-02-08T15:00:00.000Z',
      version: 1,
      rejectCode: null,
      createdAt: '2026-11-10T15:00:00.000Z',
      execution: null,
      ...over,
    }) as OrderResponse;

  it('every status has a word and a glyph (colour is never the only signal)', () => {
    for (const [status, chip] of Object.entries(STATUS_CHIPS)) {
      expect(chip.label.length, status).toBeGreaterThan(2);
      expect(chip.glyph.length, status).toBeGreaterThan(0);
    }
    expect(Object.keys(STATUS_CHIPS).sort()).toEqual([
      'ACCEPTED',
      'CANCELLED',
      'EXPIRED',
      'FILLED',
      'REJECTED',
    ]);
  });
  it('typeLabel, heldLabel and the cancel sentence read the strings as received', () => {
    expect(typeLabel(order())).toBe('Limit 89,900.00 (GTC)');
    expect(typeLabel(order({ type: 'MARKET', limitPrice: null, tif: 'DAY' }))).toBe('Market');
    expect(heldLabel(order())).toBe('224.97475 cash');
    expect(heldLabel(order({ side: 'SELL', reservedUsd: '0.00' }))).toBe('0.0025 BTC-USD');
    expect(heldLabel(order({ reservedUsd: '0.00' }))).toBeNull();
    expect(releasedSentence({ usd: '224.97475', qty: '0' }, 'BTC-USD')).toBe(
      'Cancelled. 224.97475 is back in your cash.',
    );
    expect(releasedSentence({ usd: '0.00', qty: '0.001' }, 'BTC-USD')).toBe(
      'Cancelled. 0.001 BTC-USD is free to sell again.',
    );
  });
});
