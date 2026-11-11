import pg from 'pg';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NOW,
  accountState,
  command,
  createFundedAccount,
  createInstrument,
  run,
} from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import { executeMarketOrder } from './execute-market-order.js';

let db: TestDatabase;
let big: pg.Pool;
let aapl: TestInstrument;

beforeAll(async () => {
  db = await createTestDatabase();
  aapl = await createInstrument(db, 'AAPL');
  big = new pg.Pool({ connectionString: db.appUrl, max: 40 });
  big.on('error', () => undefined);
});
afterAll(async () => {
  await big.end();
  await db.dispose();
});

const clean = async (accountId: string): Promise<void> => {
  expect(await reconcileAccount(big, accountId, { trading: true })).toEqual([]);
};
const positionQty = async (accountId: string): Promise<string> =>
  (
    await db.migrator.query<{ q: string }>(
      `SELECT COALESCE(SUM(qty), 0) AS q FROM positions WHERE account_id = $1::uuid`,
      [accountId],
    )
  ).rows[0]?.q ?? '0';

describe('5a. 50 parallel BUYs of 4 shares at 100.02 on 10,000 cash', () => {
  it('exactly 24 fill, 26 are rejected INSUFFICIENT_BUYING_POWER, cash is the exact remainder, no deadlock', async () => {
    const acct = await createFundedAccount(big);
    // ask 100.00 x 1.0002 = 100.02; each order costs 4 x 100.02 = 400.08
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_x, i) =>
        run(
          big,
          command(acct, aapl, {
            clientOrderId: `race-${String(i)}`,
            qty: '4',
            bid: '99.98',
            ask: '100.00',
          }),
        ),
      ),
    );
    const thrown = results.filter((r) => r.status === 'rejected');
    expect(
      thrown,
      thrown.map((t) => String((t as PromiseRejectedResult).reason)).join('; '),
    ).toHaveLength(0); // no deadlock, no error
    const done = results.map(
      (r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof run>>>).value,
    );
    expect(done.filter((r) => r.outcome === 'FILLED')).toHaveLength(24);
    const rejected = done.filter((r) => r.outcome === 'REJECTED');
    expect(rejected).toHaveLength(26);
    for (const r of rejected)
      expect(r.outcome === 'REJECTED' && r.rejectCode).toBe('INSUFFICIENT_BUYING_POWER');

    const state = await accountState(db, acct);
    // 10000 - 24 x 400.08 = 10000 - 9601.92 = 398.08 (never negative: 25 x 400.08 would need 10002.00)
    expect(state.balances.CASH).toBe('398.0800000000');
    expect(state.counts).toMatchObject({
      orders: 50,
      executions: 24,
      lots: 24,
      ledgerTransactions: 25,
    });
    expect(await positionQty(acct)).toBe('96.0000000000');
    await clean(acct);
  });
});

describe('5b. concurrent SELLs never oversell', () => {
  it('a position of 10 shares, 20 SELLs of 1 and 10 SELLs of 2 in parallel: exactly 10 are sold', async () => {
    const acct = await createFundedAccount(big);
    const buy = await run(big, command(acct, aapl, { qty: '10', bid: '99.98', ask: '100.00' })); // 10 @ 100.02
    expect(buy.outcome).toBe('FILLED');
    const sells = [
      ...Array.from({ length: 20 }, (_x, i) => ({ id: `s1-${String(i)}`, qty: '1' })),
      ...Array.from({ length: 10 }, (_x, i) => ({ id: `s2-${String(i)}`, qty: '2' })),
    ];
    const results = await Promise.allSettled(
      sells.map((s) =>
        run(
          big,
          command(acct, aapl, {
            clientOrderId: s.id,
            side: 'SELL',
            qty: s.qty,
            bid: '99.00',
            ask: '99.05',
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    const done = results.map(
      (r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof run>>>).value,
    );
    const sold = done.reduce((n, r) => (r.outcome === 'FILLED' ? n + Number(r.order.qty) : n), 0);
    expect(sold).toBe(10); // never more than the position; all 10 shares go because 1-share sells remain
    for (const r of done)
      if (r.outcome === 'REJECTED') expect(r.rejectCode).toBe('INSUFFICIENT_POSITION');

    expect(await positionQty(acct)).toBe('0.0000000000');
    const open = await db.migrator.query(
      `SELECT 1 FROM position_lots WHERE account_id = $1::uuid AND qty_open > 0`,
      [acct],
    );
    expect(open.rowCount).toBe(0);
    // cash: 10000 - 10 x 100.02 + 10 x 98.98 = 9989.60; realised -10.40 (REALIZED_PNL +10.40)
    const state = await accountState(db, acct);
    expect(state.balances).toMatchObject({
      CASH: '9989.6000000000',
      POSITION_COST: '0.0000000000',
      REALIZED_PNL: '10.4000000000',
    });
    await clean(acct);
  });
});

describe('5c. mixed parallel BUYs and SELLs on one account', () => {
  it('60 mixed orders reconcile clean; cash and shares never go negative', async () => {
    const acct = await createFundedAccount(big);
    await run(big, command(acct, aapl, { qty: '5', bid: '99.98', ask: '100.00' }));
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_x, i) =>
        i % 2 === 0
          ? run(
              big,
              command(acct, aapl, {
                clientOrderId: `mix-${String(i)}`,
                qty: String((i % 3) + 1),
                bid: '99.98',
                ask: '100.00',
              }),
            )
          : run(
              big,
              command(acct, aapl, {
                clientOrderId: `mix-${String(i)}`,
                side: 'SELL',
                qty: String((i % 3) + 1),
                bid: '99.00',
                ask: '99.05',
              }),
            ),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    const state = await accountState(db, acct);
    expect(Number(state.balances.CASH)).toBeGreaterThanOrEqual(0);
    expect(Number(await positionQty(acct))).toBeGreaterThanOrEqual(0);
    expect(state.counts.orders).toBe(61);
    await clean(acct);
  });
});

describe('5d. different accounts do not block each other', () => {
  it('an order on account B completes while account A is locked; a second order on A waits (control)', async () => {
    const a = await createFundedAccount(big);
    const b = await createFundedAccount(big);
    const holder = await big.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT * FROM lock_account_for_order($1::uuid)`, [a]); // account A is locked and stays locked

      // B completes immediately even with a short lock timeout (it never waits for A)
      const cb = await big.connect();
      try {
        await cb.query('BEGIN');
        await cb.query(`SET LOCAL lock_timeout = '2s'`);
        const t0 = Date.now();
        const rb = await executeMarketOrder(cb, command(b, aapl, { qty: '1' }));
        await cb.query('COMMIT');
        expect(rb.outcome).toBe('FILLED');
        expect(Date.now() - t0).toBeLessThan(1500);
      } finally {
        cb.release();
      }

      // control: another order on A cannot get the account lock and times out (SQLSTATE 55P03)
      const ca = await big.connect();
      try {
        await ca.query('BEGIN');
        await ca.query(`SET LOCAL lock_timeout = '500ms'`);
        await expect(executeMarketOrder(ca, command(a, aapl, { qty: '1' }))).rejects.toMatchObject({
          code: '55P03',
        });
      } finally {
        await ca.query('ROLLBACK').catch(() => undefined);
        ca.release();
      }
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    // after A is released its orders work (control)
    expect((await run(big, command(a, aapl, { qty: '1' }))).outcome).toBe('FILLED');
  });

  it('20 accounts trading in parallel (5 orders each) all complete without lock timeouts', async () => {
    const accounts = await Promise.all(Array.from({ length: 20 }, () => createFundedAccount(big)));
    const jobs = accounts.flatMap((acct) => Array.from({ length: 5 }, (_x, i) => ({ acct, i })));
    const results = await Promise.allSettled(
      jobs.map(({ acct, i }) =>
        run(big, command(acct, aapl, { clientOrderId: `multi-${String(i)}`, qty: '1', now: NOW })),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    for (const acct of accounts) await clean(acct);
  });
});
