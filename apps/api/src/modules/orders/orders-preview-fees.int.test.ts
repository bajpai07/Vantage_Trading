// Preview with non-zero fees (own database: fee schedules are append-only and permanent, so they must not leak into
// the other preview tests). Golden vector 3 (10 bps commission) and the FEE_EXCEEDS_PROCEEDS reject (D-57).
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { parse } from '@vantage/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_ORIGIN, cookie } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import {
  BUY_AAPL,
  cash,
  counts,
  createOrdersHarness,
  newKey,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import type { TestUser } from '../../testing/orders-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';

let db: TestDatabase;
let h: Harness;
beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db, { env: { ORDER_PREVIEW_RATE_LIMIT_PER_MINUTE: '100000' } });
  const insert = (version: number, effective: string, bps: string, min: string) =>
    db.migrator.query(
      `INSERT INTO fee_schedules (id, asset_class, exchange_id, version, effective_from, commission_bps,
                                  commission_min_local, slippage_base_bps, slippage_size_coef, model_version)
       VALUES (gen_random_uuid(), 'EQUITY', NULL, $1, $2::timestamptz, $3::numeric, $4::numeric, 2, 0, 'QBX-1/r8he')`,
      [version, effective, bps, min],
    );
  await insert(2, '2026-11-10T15:30:00Z', '10', '0'); // 10 bps, no minimum
  await insert(3, '2026-11-10T17:00:00Z', '0', '5'); // no bps, a 5.00 minimum commission
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const preview = (u: Pick<TestUser, 'token'>, body: unknown) =>
  h.http
    .post('/v1/orders/preview')
    .set('Cookie', cookie(u.token))
    .set('Origin', WEB_ORIGIN)
    .send(body as object);
const dec = (s: unknown): string => parse(String(s)).toString();

describe('golden vector 3 and FEE_EXCEEDS_PROCEEDS', () => {
  let u: TestUser;
  it('vector 3: BUY 10 with a 10 bps commission: fee 1.9004, cash after 8,097.6996; the real order equals the preview', async () => {
    h.clock.set('2026-11-10T16:00:00.000Z'); // schedule v2 is in force
    await setQuote(h, 'AAPL', '189.95', '190.00');
    u = await newUser(h, db, 'fee');
    const p = await preview(u, BUY_AAPL);
    expect(p.body).toMatchObject({
      wouldFill: true,
      estimatedPrice: '190.04',
      estimatedNotional: '1900.40',
      estimatedFee: '1.9004', // 1900.40 x 10 / 10000
      estimatedCashAfter: '8097.6996',
    });
    const o = await placeOrder(h, u, newKey(), BUY_AAPL);
    expect(o.body.execution).toMatchObject({ price: '190.04', notional: '1900.40', fee: '1.9004' });
    expect(dec(await cash(db, u.accountId))).toBe('8097.6996');
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });

  it('FEE_EXCEEDS_PROCEEDS: a 1-share SELL (proceeds 1.99) under a 5.00 minimum commission would be rejected, with the estimate; the real order rejects the same way; 3 shares (proceeds 5.97) fill', async () => {
    h.clock.set('2026-11-10T17:30:00.000Z'); // schedule v3 is in force
    await setQuote(h, 'AAPL', '2.00', '2.05');
    const before = await counts(db, u.accountId);
    const tiny = { ...BUY_AAPL, side: 'SELL', qty: '1', referencePrice: '2.00' };
    const p = await preview(u, tiny);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({
      wouldFill: false,
      rejectCode: 'FEE_EXCEEDS_PROCEEDS',
      estimatedPrice: '1.99', // 2.00 x 0.9998 = 1.9996, down to the tick
      estimatedNotional: '1.99',
      estimatedFee: '5.00',
      estimatedProceeds: '-3.01',
    });
    expect(await counts(db, u.accountId)).toEqual(before); // the preview stored nothing
    const o = await placeOrder(h, u, newKey(), tiny);
    expect(o.body).toMatchObject({ status: 'REJECTED', rejectCode: 'FEE_EXCEEDS_PROCEEDS' });

    const three = { ...tiny, qty: '3' };
    const p3 = await preview(u, three);
    expect(p3.body).toMatchObject({
      wouldFill: true,
      estimatedNotional: '5.97',
      estimatedFee: '5.00',
      estimatedProceeds: '0.97',
    });
    const o3 = await placeOrder(h, u, newKey(), three);
    expect(o3.body.execution).toMatchObject({ price: '1.99', notional: '5.97', fee: '5.00' });
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  });
});
