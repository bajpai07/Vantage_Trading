import { describe, expect, it } from 'vitest';
import {
  ORDER_REJECT_CODES,
  OrderPreviewResponse,
  ORDER_PREVIEW_DISCLAIMER,
} from '@vantage/contracts';
import { decideForCommand } from './execute-market-order.js';
import type { MarketOrderCommand } from './execute-market-order.js';
import { previewMarketOrder } from './preview.js';

// Every expected value is hand-worked (the M4a vectors), never computed by the code under test.
const NOW = new Date('2026-11-10T15:00:00.000Z');
function cmd(over: Partial<MarketOrderCommand> = {}): MarketOrderCommand {
  return {
    orderId: 'o',
    accountId: 'a',
    clientOrderId: 'preview',
    instrument: {
      id: 'i',
      symbol: 'AAPL',
      status: 'ACTIVE',
      tradableIn: ['MVP'],
      tickSize: '0.01',
      minQty: '1',
      qtyStep: '1',
    },
    side: 'BUY',
    qty: '10',
    referencePrice: '190.00',
    quote: {
      bid: '189.95',
      ask: '190.00',
      providerTs: new Date(NOW.getTime() - 900_000),
      source: 'FIXTURE',
      entitlement: 'DELAYED',
      delaySeconds: 900,
    },
    freshness: 'DELAYED',
    feeSchedule: {
      commissionBps: '0',
      commissionMinLocal: '0',
      slippageBaseBps: '2',
      slippageSizeCoef: '0',
      modelVersion: 'QBX-1/r8he',
    },
    allowExecutionOnDelayed: true,
    tradingEnabled: true,
    now: NOW,
    ...over,
  };
}
const state = { accountActive: true, cash: '10000', positionQty: '0' };

describe('previewMarketOrder', () => {
  it('vector 1: BUY 10 at ask 190.00 fills at 190.04, notional 1900.40, fee 0, cash after 8099.60', () => {
    expect(previewMarketOrder(cmd(), state)).toEqual({
      wouldFill: true,
      rejectCode: null,
      estimate: {
        price: '190.04',
        notional: '1900.4',
        fee: '0',
        slippageBps: '2',
        cashAfter: '8099.6',
        proceeds: null,
      },
    });
  });

  it('vector 2: SELL 10 at bid 195.00 fills at 194.96: proceeds 1949.60, cash after 10049.20', () => {
    const out = previewMarketOrder(
      cmd({
        side: 'SELL',
        referencePrice: '195.00',
        quote: {
          ...(cmd().quote as NonNullable<MarketOrderCommand['quote']>),
          bid: '195.00',
          ask: '195.05',
        },
      }),
      { accountActive: true, cash: '8099.60', positionQty: '10' },
    );
    expect(out.wouldFill).toBe(true);
    expect(out.estimate).toMatchObject({
      price: '194.96',
      notional: '1949.6',
      proceeds: '1949.6',
      cashAfter: '10049.2',
    });
  });

  it('vector 3: a 10 bps commission gives fee 1.9004 and cash after 8097.6996', () => {
    const out = previewMarketOrder(
      cmd({ feeSchedule: { ...cmd().feeSchedule, commissionBps: '10' } }),
      state,
    );
    expect(out.estimate).toMatchObject({ fee: '1.9004', cashAfter: '8097.6996' });
  });

  it('the decision is exactly decideForCommand (the executor uses the same function): same code for every state', () => {
    const states = [
      state,
      { ...state, cash: '1000' },
      { ...state, accountActive: false },
      { ...state, positionQty: '10' },
    ];
    const cmds = [
      cmd(),
      cmd({ tradingEnabled: false }),
      cmd({ freshness: 'STALE' }),
      cmd({ freshness: 'CLOSED' }),
      cmd({ freshness: 'UNAVAILABLE', quote: null }),
      cmd({ qty: '2.5' }),
      cmd({ referencePrice: '180.00' }),
      cmd({ side: 'SELL', referencePrice: '189.95' }),
    ];
    for (const c of cmds) {
      for (const s of states) {
        const d = decideForCommand(c, s);
        const p = previewMarketOrder(c, s);
        expect(p.wouldFill).toBe(d.decision === 'FILL');
        expect(p.rejectCode).toBe(d.decision === 'REJECT' ? d.code : null);
      }
    }
  });

  it('a reject after the price check still shows the estimate; an earlier reject shows none', () => {
    const noCash = previewMarketOrder(cmd({ qty: '53' }), state);
    expect(noCash).toMatchObject({ wouldFill: false, rejectCode: 'INSUFFICIENT_BUYING_POWER' });
    expect(noCash.estimate).toMatchObject({
      price: '190.04',
      notional: '10072.12',
      cashAfter: '-72.12',
    });
    expect(previewMarketOrder(cmd({ referencePrice: '180.00' }), state).estimate?.price).toBe(
      '190.04',
    ); // PRICE_MOVED

    for (const c of [
      cmd({ tradingEnabled: false }),
      cmd({ freshness: 'STALE' }),
      cmd({ freshness: 'CLOSED' }),
      cmd({ freshness: 'UNAVAILABLE', quote: null }),
      cmd({ instrument: { ...cmd().instrument, status: 'HALTED' } }),
    ]) {
      const p = previewMarketOrder(c, state);
      expect(p.wouldFill).toBe(false);
      expect(p.estimate).toBeNull();
    }
  });

  it("a throwing or malformed quantity is the HTTP layer's problem: nothing here swallows it", () => {
    expect(() => previewMarketOrder(cmd({ qty: '0' }), state)).toThrow();
  });
});

describe('OrderPreviewResponse contract', () => {
  const ok = {
    wouldFill: true,
    rejectCode: null,
    estimatedPrice: '190.04',
    estimatedNotional: '1900.40',
    estimatedFee: '0.00',
    estimatedCashAfter: '8099.60',
    estimatedProceeds: null,
    slippageBps: '2',
    quote: {
      bid: '189.95',
      ask: '190.00',
      last: null,
      asOf: '2026-11-10T14:45:00.000Z',
      source: 'FIXTURE',
      freshness: 'DELAYED',
    },
    disclaimer: ORDER_PREVIEW_DISCLAIMER,
    generatedAt: '2026-11-10T15:00:00.000Z',
  };
  it('accepts a valid body (control) and refuses numbers for money, unknown fields, a changed disclaimer and unknown reject codes', () => {
    expect(OrderPreviewResponse.safeParse(ok).success).toBe(true);
    expect(OrderPreviewResponse.safeParse({ ...ok, estimatedPrice: 190.04 }).success).toBe(false);
    expect(OrderPreviewResponse.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(
      OrderPreviewResponse.safeParse({ ...ok, disclaimer: 'The price is guaranteed.' }).success,
    ).toBe(false);
    expect(
      OrderPreviewResponse.safeParse({ ...ok, rejectCode: 'NOPE', wouldFill: false }).success,
    ).toBe(false);
    for (const code of ORDER_REJECT_CODES) {
      expect(
        OrderPreviewResponse.safeParse({ ...ok, wouldFill: false, rejectCode: code }).success,
        code,
      ).toBe(true);
    }
  });
});
