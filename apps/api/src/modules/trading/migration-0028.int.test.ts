// M8b-1 T1: migration 0028 (guarded order updates, order_events contiguity, RESERVED backfill, expiry index) on a database
// that already holds M8 data. The database is built at migration 0027 (a temporary copy of db/migrations without 0028), real
// fractional crypto and stock orders are filled through the executor, then 0028 is applied: every account still reconciles
// with zero tolerance, a second run is a no-op, and the lifecycle rules of D-91 hold.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { parse } from '@vantage/money';
import {
  command,
  createFundedAccount,
  createInstrument,
  cryptoCommand,
  run,
  seededCrypto,
} from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const migrationsDir = resolve(repoRoot, 'db', 'migrations');

function migrateUp(migratorUrl: string): Promise<string> {
  return new Promise((done, fail) => {
    let out = '';
    const child = spawn(process.execPath, [resolve(repoRoot, 'tools/migrate.mjs'), 'up'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_MIGRATOR_URL: migratorUrl },
    });
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', fail);
    child.on('exit', (code) =>
      code === 0
        ? done(out)
        : fail(new Error(`migrate exited ${String(code)}:\n${out.slice(-1500)}`)),
    );
  });
}

describe('migration 0028 on a database that already holds M8 data', () => {
  let db: TestDatabase;
  let oldDir: string;
  let btc: TestInstrument;
  let stock: TestInstrument;
  let accounts: string[] = [];
  let orderId = '';

  beforeAll(async () => {
    oldDir = mkdtempSync(join(tmpdir(), 'vantage-mig28-'));
    for (const f of readdirSync(migrationsDir)) {
      if (f.endsWith('.sql') && f < '0028') copyFileSync(join(migrationsDir, f), join(oldDir, f));
    }
    process.env.VANTAGE_MIGRATIONS_DIR = oldDir;
    try {
      db = await createTestDatabase();
    } finally {
      delete process.env.VANTAGE_MIGRATIONS_DIR;
    }
    btc = await seededCrypto(db, 'BTC-USD');
    stock = await createInstrument(db, 'MIG28');
    // M8 data: a fractional crypto account with a partial sale, and a stock account
    const a = await createFundedAccount(db.app, '10000');
    const b = await createFundedAccount(db.app, '10000');
    accounts = [a, b];
    await run(db.app, cryptoCommand(a, btc, { side: 'BUY', qty: '0.0025' }));
    const sold = await run(db.app, cryptoCommand(a, btc, { side: 'SELL', qty: '0.001' }));
    orderId = sold.order.id;
    await run(db.app, command(b, stock, { side: 'BUY', qty: '7' }));
    await run(db.app, command(b, stock, { side: 'SELL', qty: '3', bid: '195.00', ask: '195.05' }));
  }, 120_000);

  afterAll(async () => {
    await db?.dispose();
    if (oldDir !== undefined) rmSync(oldDir, { recursive: true, force: true });
  });

  it('before 0028 orders are immutable (the M4a trigger) and the app has no UPDATE on them', async () => {
    await expect(db.migrator.query(`UPDATE orders SET version = version + 1`)).rejects.toThrow(
      /append-only/,
    );
    await expect(db.app.query(`UPDATE orders SET version = version + 1`)).rejects.toMatchObject({
      code: '42501',
    });
    for (const a of accounts) expect(await reconcileAccount(db.migrator, a)).toEqual([]);
  });

  it('0028 applies, every account still reconciles with zero tolerance, and a second run is a no-op', async () => {
    const out = await migrateUp(db.migratorUrl);
    expect(out).toContain('0028_limit_orders_lifecycle');
    for (const a of accounts) expect(await reconcileAccount(db.migrator, a)).toEqual([]);
    const again = await migrateUp(db.migratorUrl);
    expect(again).toContain('No migrations to run');
    expect(again).not.toContain('0028_limit_orders_lifecycle');
  });

  it('every account has its RESERVED USD ledger account (the backfill is idempotent: no duplicates)', async () => {
    const r = await db.migrator.query<{ n: string; accounts: string }>(
      `SELECT count(*) FILTER (WHERE type = 'RESERVED' AND currency = 'USD')::text AS n,
              count(DISTINCT account_id)::text AS accounts FROM ledger_accounts`,
    );
    expect(r.rows[0]?.n).toBe(r.rows[0]?.accounts);
    const missing = await db.migrator.query(
      `SELECT 1 FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts la
         WHERE la.account_id = a.id AND la.type = 'RESERVED' AND la.currency = 'USD')`,
    );
    expect(missing.rowCount).toBe(0);
  });

  it('the existing FILLED orders are terminal: no update of any column succeeds, for the owner or the app (control: the rows exist)', async () => {
    const n = await db.migrator.query(`SELECT 1 FROM orders WHERE status = 'FILLED'`);
    expect(n.rowCount).toBeGreaterThanOrEqual(4);
    await expect(
      db.migrator.query(`UPDATE orders SET version = version + 1 WHERE id = $1::uuid`, [orderId]),
    ).rejects.toThrow(/terminal state/);
    await expect(
      db.app.query(`UPDATE orders SET version = version + 1 WHERE id = $1::uuid`, [orderId]),
    ).rejects.toThrow(/terminal state/);
    // deleting is still refused
    await expect(db.migrator.query(`DELETE FROM orders`)).rejects.toThrow(/append-only/);
    await expect(db.app.query(`DELETE FROM orders`)).rejects.toMatchObject({ code: '42501' });
    // the app role may update only the six lifecycle columns
    for (const col of [
      'qty = 1',
      'limit_price = 1',
      "tif = 'GTC'",
      'account_id = account_id',
      'expires_at = now()',
      "client_order_id = 'x'",
    ]) {
      await expect(
        db.app.query(`UPDATE orders SET ${col} WHERE id = $1::uuid`, [orderId]),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('the expiry index and the open-orders index exist; the existing events are contiguous', async () => {
    const idx = await db.migrator.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'orders' ORDER BY indexname`,
    );
    const names = idx.rows.map((x) => x.indexname);
    expect(names).toContain('orders_open_by_instrument');
    expect(names).toContain('orders_open_by_expiry');
    const ev = await db.migrator.query<{ order_id: string; n: string; hi: string }>(
      `SELECT order_id, count(*)::text AS n, max(seq)::text AS hi FROM order_events GROUP BY order_id`,
    );
    for (const r of ev.rows) expect(parse(r.n).toString()).toBe(parse(r.hi).toString());
  });
});
