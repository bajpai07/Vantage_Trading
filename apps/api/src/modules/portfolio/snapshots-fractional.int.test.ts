// M8b-1 T0(b): the daily equity snapshot of an account that holds a FRACTIONAL crypto position and a whole-share stock.
// The snapshot is rebuilt from the stored executions and marked with the day's stored quotes (the M5 rule); it must value
// exact decimals, equal the portfolio endpoint for the same quotes, and the equity identity must hold exactly.
// Independent expectation (hand arithmetic, units of 1e-8 in the test): positions value = 7 x 189.95 (the AAPL bid) +
// 0.00257777 x 89,990.00 (the BTC bid) = 1,329.65 + 231.9735223 = 1,561.6235223.
//   0.00257777 x 89,990 = 257,777 x 89,990 / 1e8 = 23,197,352,230 / 1e8 = 231.9735223 (exact, 7 decimals).
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { parse } from '@vantage/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from '../../testing/harness.js';
import {
  createOrdersHarness,
  getAs,
  newKey,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import { SnapshotService } from './snapshot.service.js';

let db: TestDatabase;
let h: Harness;
beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db, {
    env: { SESSION_IDLE_MINUTES: '10080', SESSION_ABSOLUTE_DAYS: '90' },
  });
}, 120_000);
afterAll(async () => {
  await h?.close();
  await db?.dispose();
});

describe('the equity snapshot with a fractional crypto holding and a stock holding', () => {
  it('values exact decimals, equals the portfolio endpoint for the same quotes, and the equity identity is exact', async () => {
    h.clock.set('2026-11-10T15:00:00.000Z'); // Tuesday 10:00 New York: open
    const u = await newUser(h, db, 'snapf');
    // accounts.created_at is the real wall clock; the job compares it with the injected clock (as the other snapshot tests do)
    await db.migrator.query(
      `UPDATE accounts SET created_at = $2::timestamptz WHERE id = $1::uuid`,
      [u.accountId, h.clock.now()],
    );
    await setQuote(h, 'BTC-USD', '89990.00', '90010.00');
    await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });
    const orders = [
      { symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: '7', referencePrice: '190.00' },
      { symbol: 'BTC-USD', side: 'BUY', type: 'MARKET', qty: '0.0025', referencePrice: '90010.00' },
      {
        symbol: 'BTC-USD',
        side: 'BUY',
        type: 'MARKET',
        qty: '0.00007777',
        referencePrice: '90010.00',
      },
    ];
    for (const o of orders) {
      const r = await placeOrder(h, u, newKey(), o);
      expect(r.body, JSON.stringify(r.body)).toMatchObject({ status: 'FILLED' });
    }
    expect(await reconcileAccount(db.migrator, u.accountId)).toEqual([]);

    // after the close (21:00Z) of that Tuesday: the job writes that day's snapshot from the same stored quotes
    h.clock.set('2026-11-10T22:00:00.000Z');
    const run = await h.app.get(SnapshotService).runDue(h.clock.now());
    expect(run.written).toBeGreaterThanOrEqual(1);
    const row = await db.migrator.query<{
      cash: string;
      positions_value: string;
      equity: string;
      valued_complete: boolean;
    }>(
      `SELECT cash, positions_value, equity, valued_complete FROM equity_snapshots
        WHERE account_id = $1::uuid AND snapshot_date = '2026-11-10'`,
      [u.accountId],
    );
    const snap = row.rows[0];
    expect(snap?.valued_complete).toBe(true);

    // the independent expectation
    expect(parse(snap?.positions_value ?? '0').toString()).toBe('1561.6235223');

    // the portfolio endpoint at the same instant with the same quotes
    const p = (await getAs(h, u, '/v1/portfolio')).body;
    expect(p.incomplete).toBe(false);
    expect(parse(snap?.cash ?? '0').toString()).toBe(parse(p.exact.cash).toString());
    expect(parse(snap?.positions_value ?? '0').toString()).toBe(
      parse(p.exact.positionsValue).toString(),
    );
    expect(parse(snap?.equity ?? '0').toString()).toBe(parse(p.exact.equity).toString());
    // equity = cash + positions value, exactly
    expect(
      parse(snap?.cash ?? '0')
        .add(parse(snap?.positions_value ?? '0'))
        .toString(),
    ).toBe(parse(snap?.equity ?? '0').toString());
    // the identity: cash + costBasis + fees - realisedPnl = 10,000 (exact fields of the same portfolio response)
    expect(
      parse(p.exact.cash)
        .add(parse(p.exact.costBasis))
        .add(parse(p.exact.fees))
        .sub(parse(p.exact.realisedPnl))
        .toString(),
    ).toBe('10000');
    // the fractional position is shown as stored
    const btc = p.positions.find((x: { symbol: string }) => x.symbol === 'BTC-USD');
    expect(btc.qty).toBe('0.00257777');
    expect(await reconcileAccount(db.migrator, u.accountId)).toEqual([]);
  });
});
