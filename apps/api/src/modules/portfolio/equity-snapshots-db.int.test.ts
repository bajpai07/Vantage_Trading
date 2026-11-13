// equity_snapshots is append-only at the database (D-62): the app role can only SELECT and INSERT, and the
// append-only triggers stop even the owner. Every "must fail" has a control that succeeds.
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFundedAccount } from '../../testing/trading-kit.js';

let db: TestDatabase;
let acct: string;
beforeAll(async () => {
  db = await createTestDatabase();
  acct = await createFundedAccount(db.app);
});
afterAll(async () => {
  await db.dispose();
});

const insert = (
  account: string,
  date: string,
  cash = '10000',
  pv = '0',
  eq = '10000',
  complete = true,
) =>
  db.app.query(
    `INSERT INTO equity_snapshots (account_id, snapshot_date, cash, positions_value, equity, valued_complete, quote_asof)
     VALUES ($1::uuid, $2::date, $3::numeric, $4::numeric, $5::numeric, $6, NULL)`,
    [account, date, cash, pv, eq, complete],
  );

describe('equity_snapshots protection', () => {
  it('the app role can insert and read a snapshot (control)', async () => {
    await insert(acct, '2026-11-09');
    const r = await db.app.query(
      `SELECT cash, equity, valued_complete FROM equity_snapshots WHERE account_id = $1::uuid`,
      [acct],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.valued_complete).toBe(true);
  });

  it('as vantage_app UPDATE, DELETE and TRUNCATE are refused (no privilege)', async () => {
    for (const sql of [
      `UPDATE equity_snapshots SET equity = 1, cash = 1`,
      `DELETE FROM equity_snapshots`,
      `TRUNCATE equity_snapshots`,
    ]) {
      await expect(db.app.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
    const n = await db.migrator.query(`SELECT count(*)::int AS n FROM equity_snapshots`);
    expect(n.rows[0]?.n).toBe(1);
  });

  it('even the owner is stopped by the append-only triggers (UPDATE, DELETE, TRUNCATE)', async () => {
    for (const sql of [
      `UPDATE equity_snapshots SET valued_complete = false`,
      `DELETE FROM equity_snapshots`,
      `TRUNCATE equity_snapshots`,
    ]) {
      await expect(db.migrator.query(sql), sql).rejects.toThrow(/append-only/);
    }
  });

  it('one snapshot per account and date: a duplicate is refused, another date is accepted (control)', async () => {
    await expect(insert(acct, '2026-11-09')).rejects.toMatchObject({ code: '23505' });
    await insert(acct, '2026-11-10');
    // insert-ignore (what the job does) is silent and leaves the original untouched
    const r = await db.app.query(
      `INSERT INTO equity_snapshots (account_id, snapshot_date, cash, positions_value, equity, valued_complete)
       VALUES ($1::uuid, '2026-11-09', 1, 0, 1, false) ON CONFLICT DO NOTHING`,
      [acct],
    );
    expect(r.rowCount).toBe(0);
    const row = await db.app.query(
      `SELECT cash FROM equity_snapshots WHERE account_id = $1::uuid AND snapshot_date = '2026-11-09'`,
      [acct],
    );
    expect(Number(row.rows[0]?.cash)).toBe(10000);
  });

  it('equity must equal cash + positions_value and positions_value must not be negative; an account must exist (controls: consistent rows work)', async () => {
    await expect(insert(acct, '2026-11-11', '10000', '100', '10000')).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert(acct, '2026-11-11', '10100', '-100', '10000')).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      insert('0198d0d0-1111-7000-8000-000000000001', '2026-11-11'),
    ).rejects.toMatchObject({ code: '23503' });
    await insert(acct, '2026-11-11', '9000', '1000', '10000', false); // consistent and incomplete: accepted
  });
});

describe('lot_closures index for the executions read path', () => {
  it('lot_closures has an index on close_execution_id', async () => {
    const r = await db.migrator.query(
      `SELECT 1 FROM pg_indexes WHERE tablename = 'lot_closures' AND indexdef ILIKE '%(close_execution_id)%'`,
    );
    expect(r.rowCount).toBe(1);
  });
});
