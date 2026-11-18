// M8 T1: migration 0027 on a database that already holds M4-style trading data. The database is built at migration 0026
// (a temporary copy of db/migrations without 0027), real orders, executions, lots, closures and positions are written
// with the OLD schema, then 0027 is applied. The backfill must be exact and the account must reconcile with zero tolerance.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyFillLegs, sellFillLegs } from '@vantage/engine';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { newId } from '../../ids.js';
import { createFundedAccount, createInstrument } from '../../testing/trading-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import { postTransaction } from '../ledger/repository.js';

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

describe('migration 0027 (cost_remaining, crypto fee schedule v2, crypto tradability)', () => {
  let db: TestDatabase;
  let accountId: string;
  let aId: string;
  let bId: string;
  let oldDir: string;

  beforeAll(async () => {
    // a copy of the migrations up to 0026: the database starts at the schema of M7b
    oldDir = mkdtempSync(join(tmpdir(), 'vantage-mig-'));
    mkdirSync(oldDir, { recursive: true });
    for (const f of readdirSync(migrationsDir)) {
      if (f.endsWith('.sql') && f < '0027') copyFileSync(join(migrationsDir, f), join(oldDir, f));
    }
    process.env.VANTAGE_MIGRATIONS_DIR = oldDir;
    try {
      db = await createTestDatabase();
    } finally {
      delete process.env.VANTAGE_MIGRATIONS_DIR;
    }

    // ---- M4-style data written with the OLD schema (no cost_remaining column yet) ----
    accountId = await createFundedAccount(db.app, '10000');
    const a = await createInstrument(db, 'AAA');
    const b = await createInstrument(db, 'BBB');
    aId = a.id;
    bId = b.id;
    const c = await db.migrator.connect();
    try {
      await c.query('BEGIN');
      let seq = 0;
      const fill = async (
        inst: string,
        side: 'BUY' | 'SELL',
        qty: string,
        price: string,
        basis: string | null,
        lotId: string | null,
        gross: string,
        pnl: string,
      ): Promise<void> => {
        seq += 1;
        const orderId = newId();
        const execId = newId();
        const legs =
          side === 'BUY'
            ? buyFillLegs({ qty, price, fee: '0' })
            : sellFillLegs({ qty, price, fee: '0', basis: basis ?? '0' });
        const tx = await postTransaction(c, {
          accountId,
          kind: 'FILL',
          idempotencyKey: `seed:${String(seq)}`,
          description: `${side} ${qty}`,
          orderId,
          executionId: execId,
          legs,
        });
        await c.query(
          `INSERT INTO orders (id, account_id, instrument_id, client_order_id, side, type, qty, filled_qty, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::order_side, 'MARKET', $6::numeric, $6::numeric, 'FILLED')`,
          [orderId, accountId, inst, `seed-${String(seq)}`, side, qty],
        );
        await c.query(
          `INSERT INTO executions (id, order_id, account_id, instrument_id, seq, side, qty, price, currency, fee_local,
                                   gross_usd, fee_usd, slippage_bps, quote_ts, quote_source, quote_entitlement,
                                   model_version, ledger_tx_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::order_side, $6::numeric, $7::numeric, 'USD', 0,
                   $8::numeric, 0, 2, now(), 'FIXTURE', 'DELAYED', 'QBX-1/r8he', $9::uuid)`,
          [execId, orderId, accountId, inst, side, qty, price, gross, tx.transactionId],
        );
        if (side === 'BUY') {
          await c.query(
            `INSERT INTO position_lots (id, account_id, instrument_id, open_execution_id, qty_initial, qty_open,
                                        cost_local_per_unit, cost_usd_per_unit, opened_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $5::numeric, $6::numeric, $6::numeric, now())`,
            [newId(), accountId, inst, execId, qty, price],
          );
        } else {
          await c.query(
            `INSERT INTO lot_closures (lot_id, close_execution_id, qty, proceeds_local, cost_local, proceeds_usd,
                                       cost_usd, trading_pnl_usd, fx_pnl_usd)
             VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::numeric, $4::numeric, $5::numeric,
                     $6::numeric, 0)`,
            [lotId, execId, qty, gross, basis, pnl],
          );
        }
      };
      // AAA: buy 10 at 190.04 (cost 1900.40), sell 4 (basis 760.16, proceeds 780.00): 6 shares stay in the lot
      await fill(aId, 'BUY', '10', '190.04', null, null, '1900.40', '0');
      const lotA =
        (
          await c.query<{ id: string }>(
            `SELECT id FROM position_lots WHERE instrument_id = $1::uuid`,
            [aId],
          )
        ).rows[0]?.id ?? null;
      await fill(aId, 'SELL', '4', '195.00', '760.16', lotA, '780.00', '19.84');
      await c.query(`UPDATE position_lots SET qty_open = 6 WHERE id = $1::uuid`, [lotA]);
      await c.query(
        `INSERT INTO positions (account_id, instrument_id, qty, avg_cost_local, realized_trading_pnl_usd)
         VALUES ($1::uuid, $2::uuid, 6, 190.04, 19.84)`,
        [accountId, aId],
      );
      // BBB: buy 5 at 100.00 (500.00), sell all 5 at 101.00 (basis 500.00): the lot is closed
      await fill(bId, 'BUY', '5', '100.00', null, null, '500.00', '0');
      const lotB =
        (
          await c.query<{ id: string }>(
            `SELECT id FROM position_lots WHERE instrument_id = $1::uuid`,
            [bId],
          )
        ).rows[0]?.id ?? null;
      await fill(bId, 'SELL', '5', '101.00', '500.00', lotB, '505.00', '5.00');
      await c.query(
        `UPDATE position_lots SET qty_open = 0, closed_at = now() WHERE id = $1::uuid`,
        [lotB],
      );
      await c.query(
        `INSERT INTO positions (account_id, instrument_id, qty, avg_cost_local, realized_trading_pnl_usd)
         VALUES ($1::uuid, $2::uuid, 0, 0, 5.00)`,
        [accountId, bId],
      );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }, 120_000);

  afterAll(async () => {
    await db?.dispose();
    if (oldDir !== undefined) rmSync(oldDir, { recursive: true, force: true });
  });

  it('before 0027 there is no cost_remaining column and the ledger POSITION_COST equals the old lot sum (qty_open x cost per unit)', async () => {
    const col = await db.migrator.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'position_lots' AND column_name = 'cost_remaining'`,
    );
    expect(col.rowCount).toBe(0);
    const eq = await db.migrator.query<{ equal: boolean }>(
      `SELECT (SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'POSITION_COST')
              = (SELECT SUM(qty_open * cost_local_per_unit) FROM position_lots WHERE account_id = $1::uuid) AS equal`,
      [accountId],
    );
    expect(eq.rows[0]?.equal).toBe(true);
  });

  it('0027 applies, backfills cost_remaining exactly (6 x 190.04 = 1140.24; a closed lot is 0) and the account still reconciles', async () => {
    const out = await migrateUp(db.migratorUrl);
    expect(out).toContain('0027_fractional_crypto_trading');
    const lots = await db.migrator.query<{
      instrument_id: string;
      qty_open: string;
      cost_remaining: string;
    }>(
      `SELECT instrument_id, qty_open, cost_remaining FROM position_lots WHERE account_id = $1::uuid`,
      [accountId],
    );
    const by = new Map(lots.rows.map((r) => [r.instrument_id, r]));
    expect(by.get(aId)?.cost_remaining).toBe('1140.24000000');
    expect(by.get(bId)?.cost_remaining).toBe('0.00000000');
    // the ledger POSITION_COST (1900.40 + 500.00 - 760.16 - 500.00 = 1140.24) equals the sum of cost_remaining
    const ledger = await db.migrator.query<{ balance: string }>(
      `SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'POSITION_COST'`,
      [accountId],
    );
    expect(ledger.rows[0]?.balance).toBe('1140.2400000000'); // ledger balances have 10 decimals
    expect(await reconcileAccount(db.migrator, accountId)).toEqual([]);
  });

  it('a second run is a no-op (control: the first run applied it)', async () => {
    const out = await migrateUp(db.migratorUrl);
    expect(out).toContain('No migrations to run');
    expect(out).not.toContain('0027_fractional_crypto_trading');
  });

  it('crypto fee schedule v2 exists (10 bps, 5 bps, no minimum) next to the immutable v1; stock schedules are untouched', async () => {
    const r = await db.migrator.query<{
      asset_class: string;
      version: number;
      commission_bps: string;
      commission_min_local: string;
      slippage_base_bps: string;
      slippage_size_coef: string;
      model_version: string;
    }>(
      `SELECT asset_class::text, version, commission_bps, commission_min_local, slippage_base_bps, slippage_size_coef, model_version
         FROM fee_schedules ORDER BY asset_class::text, version`,
    );
    const crypto = r.rows.filter((x) => x.asset_class === 'CRYPTO');
    expect(crypto.map((x) => x.version)).toEqual([1, 2]);
    expect(crypto[0]?.commission_bps).toBe('0.0000'); // v1 is the old placeholder, never edited
    expect(crypto[1]).toMatchObject({
      commission_bps: '10.0000',
      commission_min_local: '0.0000000000',
      slippage_base_bps: '5.0000',
      slippage_size_coef: '0.0000',
      model_version: 'QBX-1/r8he',
    });
    expect(r.rows.filter((x) => x.asset_class !== 'CRYPTO').every((x) => x.version === 1)).toBe(
      true,
    );
  });

  it('the six seeded crypto instruments carry the MVP gate; stocks are unchanged (control)', async () => {
    const r = await db.migrator.query<{
      symbol: string;
      asset_class: string;
      tradable_in: string[];
    }>(
      `SELECT symbol, asset_class::text, tradable_in::text[] AS tradable_in FROM instruments ORDER BY symbol`,
    );
    const crypto = r.rows.filter((x) => x.asset_class === 'CRYPTO');
    expect(crypto.map((x) => x.symbol)).toEqual([
      'BNB-USD',
      'BTC-USD',
      'DOGE-USD',
      'ETH-USD',
      'SOL-USD',
      'XRP-USD',
    ]);
    expect(crypto.every((x) => x.tradable_in.length === 1 && x.tradable_in[0] === 'MVP')).toBe(
      true,
    );
    expect(r.rows.find((x) => x.symbol === 'AAA')?.tradable_in).toEqual(['MVP']);
  });
});
