// Database protection: the rules hold at the database, not only in code. Everything here runs as vantage_app
// (or as the migrator where the append-only triggers are the point).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { buyFillLegs } from '@vantage/engine';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../ids.js';
import {
  NOW,
  command,
  createFundedAccount,
  createInstrument,
  run,
} from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';
import { postTransaction } from '../ledger/repository.js';

let db: TestDatabase;
let aapl: TestInstrument;
let acct: string;
beforeAll(async () => {
  db = await createTestDatabase();
  aapl = await createInstrument(db, 'AAPL');
  acct = await createFundedAccount(db.app);
  // real data to attack: BUY 2, then SELL 1 (so closures exist)
  await run(db.app, command(acct, aapl, { qty: '2', clientOrderId: 'seed-buy' }));
  await run(
    db.app,
    command(acct, aapl, {
      side: 'SELL',
      qty: '1',
      bid: '195.00',
      ask: '195.05',
      clientOrderId: 'seed-sell',
    }),
  );
});
afterAll(async () => {
  await db.dispose();
});

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}
async function expectMessage(p: Promise<unknown>, re: RegExp): Promise<void> {
  await expect(p).rejects.toThrow(re);
}

describe('7a. append-only tables', () => {
  const tables = ['orders', 'order_events', 'executions', 'lot_closures', 'fee_schedules'] as const;
  const updateSql: Record<(typeof tables)[number], string> = {
    orders: `UPDATE orders SET reject_code = 'X'`,
    order_events: `UPDATE order_events SET type = 'X'`,
    executions: `UPDATE executions SET price = 1`,
    lot_closures: `UPDATE lot_closures SET qty = 1`,
    fee_schedules: `UPDATE fee_schedules SET slippage_base_bps = 0`,
  };

  it.each(tables)(
    'vantage_app cannot UPDATE, DELETE or TRUNCATE %s (permission denied)',
    async (t) => {
      await expectCode(db.app.query(updateSql[t]), '42501');
      await expectCode(db.app.query(`DELETE FROM ${t}`), '42501');
      await expectCode(db.app.query(`TRUNCATE ${t} CASCADE`), '42501');
    },
  );

  it.each(tables)(
    'the migrator is stopped by the append-only triggers on %s (including TRUNCATE)',
    async (t) => {
      await expectMessage(db.migrator.query(updateSql[t]), /append-only/);
      await expectMessage(db.migrator.query(`DELETE FROM ${t}`), /append-only/);
      await expectMessage(db.migrator.query(`TRUNCATE ${t} CASCADE`), /append-only/);
    },
  );

  it('control: vantage_app can read fee_schedules and insert idempotency keys; it cannot update or delete them', async () => {
    expect(
      (await db.app.query(`SELECT 1 FROM fee_schedules WHERE model_version = 'QBX-1/r8he'`))
        .rowCount,
    ).toBe(2);
    await db.app.query(
      `INSERT INTO idempotency_keys (account_id, key, request_hash) VALUES ($1::uuid, 'k1', '\\x00')`,
      [acct],
    );
    await expectCode(db.app.query(`UPDATE idempotency_keys SET response_code = 200`), '42501');
    await expectCode(db.app.query(`DELETE FROM idempotency_keys`), '42501');
  });

  it('positions cannot be deleted; lots cannot be deleted or truncated by anyone', async () => {
    await expectCode(db.app.query(`DELETE FROM positions`), '42501');
    await expectCode(db.app.query(`DELETE FROM position_lots`), '42501');
    await expectCode(db.app.query(`TRUNCATE position_lots CASCADE`), '42501');
    await expectMessage(db.migrator.query(`DELETE FROM position_lots`), /append-only/);
    await expectMessage(db.migrator.query(`TRUNCATE position_lots CASCADE`), /append-only/);
  });
});

describe('7b. position_lots: only qty_open and closed_at may change', () => {
  it('changing cost_local_per_unit (or any other column) fails: permission denied for the app, a trigger for the migrator', async () => {
    for (const col of [
      'cost_local_per_unit = 1',
      'cost_usd_per_unit = 1',
      'qty_initial = 99',
      'opened_at = now()',
      'account_id = account_id',
    ]) {
      await expectCode(db.app.query(`UPDATE position_lots SET ${col}`), '42501');
    }
    await expectMessage(
      db.migrator.query(`UPDATE position_lots SET cost_local_per_unit = 1`),
      /only qty_open and closed_at may change/,
    );
    await expectMessage(
      db.migrator.query(`UPDATE position_lots SET qty_initial = qty_initial + 1`),
      /only qty_open and closed_at may change/,
    );
  });

  it('control: UPDATE position_lots SET qty_open succeeds when the position is updated consistently', async () => {
    const c = await db.app.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(
        `UPDATE position_lots SET qty_open = qty_open - 1 WHERE account_id = $1::uuid AND qty_open = 1`,
        [acct],
      );
      expect(r.rowCount).toBe(1); // the column-limited UPDATE itself is allowed
      await c.query(
        `UPDATE position_lots SET closed_at = $2 WHERE account_id = $1::uuid AND qty_open = 0 AND closed_at IS NULL`,
        [acct, NOW],
      );
      await c.query(`UPDATE positions SET qty = 0 WHERE account_id = $1::uuid`, [acct]);
      await c.query('COMMIT'); // consistent: lots sum 0 = positions.qty 0, closed_at set
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  });
});

/** Writes one complete, consistent BUY (ledger, order, execution, lot, position) by hand as vantage_app. */
async function handBuilt(
  c: pg.PoolClient,
  account: string,
  inst: TestInstrument,
  opts: {
    qty?: string;
    orderQty?: string;
    positionQty?: string | null;
    skipExecution?: boolean;
    skipLot?: boolean;
    execAccount?: string;
    execLedgerAccount?: string;
    reuseLedgerTx?: string;
  } = {},
): Promise<{ orderId: string; executionId: string; ledgerTxId: string }> {
  const qty = opts.qty ?? '1';
  const orderId = newId();
  const executionId = newId();
  const posted = await postTransaction(c, {
    accountId: opts.execLedgerAccount ?? account,
    kind: 'FILL',
    idempotencyKey: `hand:${orderId}`,
    legs: buyFillLegs({ qty, price: '100', fee: '0' }),
    orderId,
    executionId,
  });
  const ledgerTxId = opts.reuseLedgerTx ?? posted.transactionId;
  await c.query(
    `INSERT INTO orders (id, account_id, instrument_id, client_order_id, side, type, qty, filled_qty, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'BUY', 'MARKET', $5::numeric, $6::numeric, 'FILLED')`,
    [orderId, account, inst.id, randomUUID(), opts.orderQty ?? qty, opts.orderQty ?? qty],
  );
  if (opts.skipExecution !== true) {
    await c.query(
      `INSERT INTO executions (id, order_id, account_id, instrument_id, seq, side, qty, price, currency, gross_usd, slippage_bps,
                               quote_ts, quote_source, quote_entitlement, model_version, ledger_tx_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'BUY', $5::numeric, 100, 'USD', $6::numeric, 2, $7, 'FIXTURE', 'DELAYED', 'QBX-1/r8he', $8::uuid)`,
      [
        executionId,
        orderId,
        opts.execAccount ?? account,
        inst.id,
        qty,
        String(Number(qty) * 100),
        NOW,
        ledgerTxId,
      ],
    );
    if (opts.skipLot !== true) {
      await c.query(
        `INSERT INTO position_lots (id, account_id, instrument_id, open_execution_id, qty_initial, qty_open, cost_local_per_unit, cost_usd_per_unit, opened_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $5::numeric, 100, 100, $6)`,
        [newId(), opts.execAccount ?? account, inst.id, executionId, qty, NOW],
      );
    }
  }
  if (opts.positionQty !== null) {
    await c.query(
      `INSERT INTO positions (account_id, instrument_id, qty, avg_cost_local) VALUES ($1::uuid, $2::uuid, $3::numeric, 100)`,
      [account, inst.id, opts.positionQty ?? qty],
    );
  }
  return { orderId, executionId, ledgerTxId };
}

/** BEGIN, run the hand-written body, COMMIT; returns the commit error if any. Always leaves the connection clean. */
async function tryTransaction(body: (c: pg.PoolClient) => Promise<void>): Promise<unknown> {
  const c = await db.app.connect();
  try {
    await c.query('BEGIN');
    await body(c);
    await c.query('COMMIT');
    return undefined;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    return e;
  } finally {
    c.release();
  }
}

describe('7c. the commit-time triggers (I4 and I5) fire on inconsistent data and pass consistent data', () => {
  it('control: a consistent hand-written fill commits', async () => {
    const a = await createFundedAccount(db.app);
    const inst = await createInstrument(db, 'CTRL1');
    expect(
      await tryTransaction((c) => handBuilt(c, a, inst).then(() => undefined)),
    ).toBeUndefined();
  });

  it('I4: positions.qty different from the lot sum fails AT COMMIT (the statements themselves succeed)', async () => {
    const a = await createFundedAccount(db.app);
    const inst = await createInstrument(db, 'I4A');
    let statementsOk = false;
    const err = await tryTransaction(async (c) => {
      await handBuilt(c, a, inst, { qty: '1', positionQty: '2' });
      statementsOk = true; // every INSERT was accepted; only the deferred trigger objects
    });
    expect(statementsOk).toBe(true);
    expect(String(err)).toMatch(/I4: positions.qty 2\.0+ differs from the sum of open lots 1/);
  });

  it('I4: open lots with no positions row fail at commit', async () => {
    const a = await createFundedAccount(db.app);
    const inst = await createInstrument(db, 'I4B');
    const err = await tryTransaction((c) =>
      handBuilt(c, a, inst, { positionQty: null }).then(() => undefined),
    );
    expect(String(err)).toMatch(/I4: open lots hold 1\.0+ but there is no positions row/);
  });

  it('I4: closed_at must be set if and only if qty_open = 0', async () => {
    const a = await createFundedAccount(db.app);
    const inst = await createInstrument(db, 'I4C');
    expect(
      await tryTransaction((c) => handBuilt(c, a, inst).then(() => undefined)),
    ).toBeUndefined();
    const err = await tryTransaction(async (c) => {
      await c.query(`UPDATE position_lots SET qty_open = 0 WHERE account_id = $1::uuid`, [a]); // closed_at left NULL
      await c.query(`UPDATE positions SET qty = 0 WHERE account_id = $1::uuid`, [a]);
    });
    expect(String(err)).toMatch(/I4: closed_at must be set if and only if qty_open = 0/);
  });

  it('I5: a FILLED order with no execution fails at commit', async () => {
    const a = await createFundedAccount(db.app);
    const inst = await createInstrument(db, 'I5A');
    const err = await tryTransaction((c) =>
      handBuilt(c, a, inst, { skipExecution: true, positionQty: null }).then(() => undefined),
    );
    expect(String(err)).toMatch(/I5: order .* has filled_qty 1\.0+ but its executions sum to 0/);
  });

  it('I5: an execution whose quantity does not match the order fails at commit', async () => {
    const a = await createFundedAccount(db.app);
    const inst = await createInstrument(db, 'I5B');
    const err = await tryTransaction((c) =>
      handBuilt(c, a, inst, { qty: '1', orderQty: '2' }).then(() => undefined),
    );
    expect(String(err)).toMatch(/I5: order .* has filled_qty 2\.0+ but its executions sum to 1/);
  });

  it('I5: an execution whose order belongs to another account fails at commit', async () => {
    const a = await createFundedAccount(db.app);
    const b = await createFundedAccount(db.app);
    const inst = await createInstrument(db, 'I5C');
    const err = await tryTransaction((c) =>
      handBuilt(c, a, inst, {
        execAccount: b,
        execLedgerAccount: b,
        positionQty: null,
        skipLot: true,
      }).then(() => undefined),
    );
    expect(String(err)).toMatch(
      /I5: an execution of order .* does not match its order or its ledger transaction account/,
    );
  });

  it('I5: an execution whose ledger transaction belongs to another account fails at commit', async () => {
    const a = await createFundedAccount(db.app);
    const b = await createFundedAccount(db.app);
    const inst = await createInstrument(db, 'I5D');
    const err = await tryTransaction((c) =>
      handBuilt(c, a, inst, { execLedgerAccount: b }).then(() => undefined),
    );
    expect(String(err)).toMatch(
      /I5: an execution of order .* does not match its order or its ledger transaction account/,
    );
  });

  it('a second execution for the same ledger transaction fails (unique)', async () => {
    const a = await createFundedAccount(db.app);
    const inst = await createInstrument(db, 'UNQ1');
    const first = await db.app.connect();
    let shared = '';
    try {
      await first.query('BEGIN');
      shared = (await handBuilt(first, a, inst)).ledgerTxId;
      await first.query('COMMIT');
    } finally {
      first.release();
    }
    const err = await tryTransaction(async (c) => {
      await handBuilt(c, a, inst, { reuseLedgerTx: shared, positionQty: null, skipLot: true });
    });
    expect(err).toMatchObject({ code: '23505', constraint: 'executions_ledger_tx_id_key' });
  });
});
