import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyFillLegs, grantLegs, sellFillLegs } from '@vantage/engine';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import {
  IdempotencyConflictError,
  InsufficientFundsError,
  LedgerUnbalancedError,
  createAccount,
  grantInitialCapital,
  postTransaction,
  reconcileAccount,
} from './index.js';
import type { PostLeg } from './index.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.dispose();
});

// ---- helpers ---------------------------------------------------------------------------------

async function inTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** M2: accounts.user_id now references users, so tests create a real (password-less placeholder) user. */
async function insertUser(c: Pick<PoolClient, 'query'>): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO users (id, email, password_hash, role, status, display_name, country_code, is_adult)
     VALUES ($1::uuid, $2, 'not-a-real-hash', 'USER', 'ACTIVE', 'Test User', 'US', true)`,
    [id, `${id}@test.invalid`],
  );
  return id;
}

async function newGrantedAccount(pool: Pool = db.app, capital = '10000'): Promise<string> {
  const accountId = randomUUID();
  await inTx(pool, async (c) => {
    await createAccount(c, {
      accountId,
      userId: await insertUser(c),
      kind: 'MAIN',
      initialCapital: capital,
    });
    await grantInitialCapital(c, accountId);
  });
  return accountId;
}

async function balances(accountId: string, pool: Pool = db.app): Promise<Record<string, string>> {
  const r = await pool.query<{ type: string; currency: string; balance: string }>(
    `SELECT type::text AS type, currency, balance FROM ledger_accounts WHERE account_id = $1::uuid`,
    [accountId],
  );
  return Object.fromEntries(r.rows.map((x) => [`${x.type}_${x.currency}`, x.balance]));
}

async function entryRows(accountId: string, txId: string): Promise<string[]> {
  const r = await db.app.query<{ type: string; amount: string }>(
    `SELECT la.type::text AS type, e.amount
       FROM ledger_entries e JOIN ledger_accounts la ON la.id = e.ledger_account_id
       JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.account_id = $1::uuid AND t.id = $2::uuid`,
    [accountId, txId],
  );
  return r.rows.map((x) => `${x.type} ${x.amount}`).sort();
}

async function post(
  accountId: string,
  key: string,
  legs: readonly PostLeg[],
  kind: 'FILL' | 'GRANT' = 'FILL',
) {
  return inTx(db.app, (c) =>
    postTransaction(c, { accountId, kind, idempotencyKey: key, description: 'test', legs }),
  );
}

async function expectPgError(p: Promise<unknown>, code: string | undefined, text?: RegExp) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (code !== undefined) expect(err.code).toBe(code);
    if (text !== undefined) expect(err.message).toMatch(text);
    return;
  }
  throw new Error('expected the statement to fail');
}

const PERMISSION_DENIED = '42501';

// ---- 1. grant --------------------------------------------------------------------------------

describe('1. grant', () => {
  it('one grant gives CASH 10000 and CAPITAL -10000, and reconcile is clean', async () => {
    const id = await newGrantedAccount();
    const b = await balances(id);
    expect(b['CASH_USD']).toBe('10000.0000000000');
    expect(b['CAPITAL_USD']).toBe('-10000.0000000000');
    expect(await reconcileAccount(db.app, id)).toEqual([]);
  });

  it('a second grant call returns the same transaction (control) and posts nothing new', async () => {
    const id = await newGrantedAccount();
    const again = await inTx(db.app, (c) => grantInitialCapital(c, id));
    expect(again.created).toBe(false);
    expect((await balances(id))['CASH_USD']).toBe('10000.0000000000');
  });

  it('reconcile flags an account that was never granted (must fail), and is clean once granted (control)', async () => {
    const accountId = randomUUID();
    await inTx(db.app, async (c) =>
      createAccount(c, {
        accountId,
        userId: await insertUser(c),
        kind: 'MAIN',
        initialCapital: '10000',
      }),
    );
    const v = await reconcileAccount(db.app, accountId);
    expect(v.map((x) => x.invariant)).toContain('I10');
    await inTx(db.app, (c) => grantInitialCapital(c, accountId));
    expect(await reconcileAccount(db.app, accountId)).toEqual([]);
  });
});

// ---- 2. golden vectors on Postgres -----------------------------------------------------------

describe('2. golden vectors through the repository', () => {
  it('A, B and the sell without fee: exact entries and final balances', async () => {
    const id = await newGrantedAccount();
    const a = await post(id, 'vec:A', buyFillLegs({ qty: '10', price: '190.04', fee: '0' }));
    expect(await entryRows(id, a.transactionId)).toEqual([
      'CASH -1900.4000000000',
      'POSITION_COST 1900.4000000000',
    ]);
    expect((await balances(id))['CASH_USD']).toBe('8099.6000000000'); // 10000.00 - 1900.40

    const b = await post(
      id,
      'vec:B',
      buyFillLegs({ qty: '0.05', price: '60030.00', fee: '3.0015' }),
    );
    expect(await entryRows(id, b.transactionId)).toEqual([
      'CASH -3004.5015000000',
      'FEES 3.0015000000',
      'POSITION_COST 3001.5000000000',
    ]);

    const s = await post(
      id,
      'vec:S1',
      sellFillLegs({ qty: '10', price: '195.00', fee: '0', basis: '1900.40' }),
    );
    expect(await entryRows(id, s.transactionId)).toEqual([
      'CASH 1950.0000000000',
      'POSITION_COST -1900.4000000000',
      'REALIZED_PNL -49.6000000000',
    ]);

    // 10000 - 1900.40 - 3004.5015 + 1950.00 = 7045.0985 (hand check); the rest sums to the same total
    expect(await balances(id)).toEqual({
      CASH_USD: '7045.0985000000',
      RESERVED_USD: '0.0000000000',
      POSITION_COST_USD: '3001.5000000000',
      FEES_USD: '3.0015000000',
      REALIZED_PNL_USD: '-49.6000000000',
      CAPITAL_USD: '-10000.0000000000',
    });
    expect(await reconcileAccount(db.app, id)).toEqual([]);
  });

  it('the sell with fee 1.95: exact entries and final balances', async () => {
    const id = await newGrantedAccount();
    await post(id, 'vec:A', buyFillLegs({ qty: '10', price: '190.04', fee: '0' }));
    const s = await post(
      id,
      'vec:S2',
      sellFillLegs({ qty: '10', price: '195.00', fee: '1.95', basis: '1900.40' }),
    );
    expect(await entryRows(id, s.transactionId)).toEqual([
      'CASH 1948.0500000000',
      'FEES 1.9500000000',
      'POSITION_COST -1900.4000000000',
      'REALIZED_PNL -49.6000000000',
    ]);
    expect(await balances(id)).toEqual({
      CASH_USD: '10047.6500000000', // 10000 - 1900.40 + 1948.05
      RESERVED_USD: '0.0000000000',
      POSITION_COST_USD: '0.0000000000',
      FEES_USD: '1.9500000000',
      REALIZED_PNL_USD: '-49.6000000000',
      CAPITAL_USD: '-10000.0000000000',
    });
    expect(await reconcileAccount(db.app, id)).toEqual([]);
  });
});

// ---- 3. immutability --------------------------------------------------------------------------

describe('3. immutability', () => {
  const tables = ['ledger_entries', 'ledger_transactions', 'fx_rates'] as const;

  beforeAll(async () => {
    await db.migrator.query(
      `INSERT INTO fx_rates (base, quote, bid, ask, mid, source, as_of)
       VALUES ('USD','INR','83.9','84.1','84.0','test', now())`,
    );
    await newGrantedAccount(); // makes sure ledger_entries and ledger_transactions have rows
  });

  it.each(tables)(
    'vantage_app cannot UPDATE, DELETE or TRUNCATE %s (permission denied)',
    async (t) => {
      const col =
        t === 'ledger_entries' ? 'amount' : t === 'ledger_transactions' ? 'description' : 'source';
      const val = t === 'ledger_entries' ? '5' : "'x'";
      await expectPgError(db.app.query(`UPDATE ${t} SET ${col} = ${val}`), PERMISSION_DENIED);
      await expectPgError(db.app.query(`DELETE FROM ${t}`), PERMISSION_DENIED);
      await expectPgError(db.app.query(`TRUNCATE ${t} CASCADE`), PERMISSION_DENIED);
    },
  );

  it.each(tables)(
    'the migrator is stopped by the append-only triggers on %s (incl. TRUNCATE)',
    async (t) => {
      const col =
        t === 'ledger_entries' ? 'amount' : t === 'ledger_transactions' ? 'description' : 'source';
      const val = t === 'ledger_entries' ? '5' : "'x'";
      await expectPgError(
        db.migrator.query(`UPDATE ${t} SET ${col} = ${val}`),
        'P0001',
        /append-only/,
      );
      await expectPgError(db.migrator.query(`DELETE FROM ${t}`), 'P0001', /append-only/);
      await expectPgError(db.migrator.query(`TRUNCATE ${t} CASCADE`), 'P0001', /append-only/);
    },
  );

  it('control: INSERT works for the app (a new account, grant and entries)', async () => {
    const id = await newGrantedAccount();
    expect((await balances(id))['CASH_USD']).toBe('10000.0000000000');
  });

  it('control: the migrator can INSERT into fx_rates', async () => {
    const r = await db.migrator.query<{ n: string }>('SELECT count(*) AS n FROM fx_rates');
    expect(Number(r.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });
});

// ---- 4. balance protection --------------------------------------------------------------------

describe('4. balance protection', () => {
  async function addInrAccounts(accountId: string): Promise<void> {
    for (const type of ['FX_CLEARING', 'POSITION_COST']) {
      await db.app.query(
        `INSERT INTO ledger_accounts (id, account_id, type, currency)
         VALUES ($1::uuid, $2::uuid, $3::ledger_acct_type, 'INR')`,
        [randomUUID(), accountId, type],
      );
    }
    await db.app.query(
      `INSERT INTO ledger_accounts (id, account_id, type, currency)
       VALUES ($1::uuid, $2::uuid, 'FX_CLEARING', 'USD')`,
      [randomUUID(), accountId],
    );
  }
  const leg = (
    ledgerAccountType: PostLeg['ledgerAccountType'],
    currency: string,
    amount: string,
    amountUsd?: string,
  ): PostLeg => ({
    ledgerAccountType,
    currency,
    amount,
    ...(amountUsd === undefined ? {} : { amountUsd }),
  });

  it('an unbalanced transaction fails with LedgerUnbalancedError and posts nothing', async () => {
    const id = await newGrantedAccount();
    await expect(
      post(id, 'unbal-1', [leg('CASH', 'USD', '-100'), leg('POSITION_COST', 'USD', '99')]),
    ).rejects.toBeInstanceOf(LedgerUnbalancedError);
    expect((await balances(id))['CASH_USD']).toBe('10000.0000000000');
    expect(await reconcileAccount(db.app, id)).toEqual([]);
    // control: the balanced version of the same legs succeeds
    await post(id, 'unbal-2', [leg('CASH', 'USD', '-100'), leg('POSITION_COST', 'USD', '100')]);
    expect((await balances(id))['CASH_USD']).toBe('9900.0000000000');
  });

  it('a balanced multi-currency transaction succeeds (USD legs sum to 0, INR legs sum to 0)', async () => {
    const id = await newGrantedAccount();
    await addInrAccounts(id);
    await post(id, 'multi-1', [
      leg('CASH', 'USD', '-100'),
      leg('FX_CLEARING', 'USD', '100'),
      leg('FX_CLEARING', 'INR', '-8390', '-100'),
      leg('POSITION_COST', 'INR', '8390', '100'),
    ]);
    const b = await balances(id);
    expect(b['CASH_USD']).toBe('9900.0000000000');
    expect(b['FX_CLEARING_USD']).toBe('100.0000000000');
    expect(b['FX_CLEARING_INR']).toBe('-8390.0000000000');
    expect(b['POSITION_COST_INR']).toBe('8390.0000000000');
    expect(await reconcileAccount(db.app, id)).toEqual([]);
  });

  it('a transaction that nets to zero overall but not per currency fails', async () => {
    const id = await newGrantedAccount();
    await addInrAccounts(id);
    // -100 USD + 100 INR = 0 if you ignore the currency, which the rule must not do
    await expect(
      post(id, 'cross-1', [leg('CASH', 'USD', '-100'), leg('POSITION_COST', 'INR', '100', '1.2')]),
    ).rejects.toBeInstanceOf(LedgerUnbalancedError);
    expect((await balances(id))['CASH_USD']).toBe('10000.0000000000');
  });

  it('a deferred (never made immediate) unbalanced transaction also fails at COMMIT', async () => {
    const id = await newGrantedAccount();
    const c = await db.app.connect();
    try {
      await c.query('BEGIN');
      const txId = randomUUID();
      await c.query(
        `INSERT INTO ledger_transactions (id, account_id, kind, idempotency_key)
         VALUES ($1::uuid, $2::uuid, 'ADJUSTMENT', 'raw-unbalanced')`,
        [txId, id],
      );
      const la = await c.query<{ id: string }>(
        `SELECT id FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'CASH'`,
        [id],
      );
      await c.query(
        `INSERT INTO ledger_entries (transaction_id, ledger_account_id, currency, amount, amount_usd)
         VALUES ($1::uuid, $2::uuid, 'USD', 5, 5)`,
        [txId, la.rows[0]?.id],
      );
      await expectPgError(c.query('COMMIT'), undefined, /unbalanced/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('an entry whose currency differs from its ledger account is rejected (guard)', async () => {
    const id = await newGrantedAccount();
    const c = await db.app.connect();
    try {
      await c.query('BEGIN');
      const txId = randomUUID();
      await c.query(
        `INSERT INTO ledger_transactions (id, account_id, kind, idempotency_key)
         VALUES ($1::uuid, $2::uuid, 'ADJUSTMENT', 'raw-currency')`,
        [txId, id],
      );
      const la = await c.query<{ id: string }>(
        `SELECT id FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'CASH'`,
        [id],
      );
      await expectPgError(
        c.query(
          `INSERT INTO ledger_entries (transaction_id, ledger_account_id, currency, amount, amount_usd)
           VALUES ($1::uuid, $2::uuid, 'INR', 5, 5)`,
          [txId, la.rows[0]?.id],
        ),
        undefined,
        /does not match/,
      );
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});

// ---- 5. no direct balance edits ----------------------------------------------------------------

describe('5. no direct balance edits', () => {
  it('vantage_app cannot UPDATE ledger_accounts.balance, yet an entry still updates it', async () => {
    const id = await newGrantedAccount();
    await expectPgError(
      db.app.query(`UPDATE ledger_accounts SET balance = 999999 WHERE account_id = $1::uuid`, [id]),
      PERMISSION_DENIED,
    );
    expect((await balances(id))['CASH_USD']).toBe('10000.0000000000');
    // control: SECURITY DEFINER lets the entry insert move the balance
    await post(id, 'sd-1', buyFillLegs({ qty: '1', price: '100', fee: '0' }));
    expect((await balances(id))['CASH_USD']).toBe('9900.0000000000');
  });

  it('a zero amount entry is rejected (control: a non-zero one is accepted)', async () => {
    const id = await newGrantedAccount();
    const cash = await db.app.query<{ id: string }>(
      `SELECT id FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'CASH'`,
      [id],
    );
    const capital = await db.app.query<{ id: string }>(
      `SELECT id FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'CAPITAL'`,
      [id],
    );
    const txId = randomUUID();
    await inTx(db.app, async (c) => {
      await c.query(
        `INSERT INTO ledger_transactions (id, account_id, kind, idempotency_key)
         VALUES ($1::uuid, $2::uuid, 'ADJUSTMENT', 'zero-1')`,
        [txId, id],
      );
      await c.query('SAVEPOINT s');
      await expectPgError(
        c.query(
          `INSERT INTO ledger_entries (transaction_id, ledger_account_id, currency, amount, amount_usd)
           VALUES ($1::uuid, $2::uuid, 'USD', 0, 0)`,
          [txId, cash.rows[0]?.id],
        ),
        '23514',
      );
      await c.query('ROLLBACK TO SAVEPOINT s');
      // control: a non-zero balanced pair in the same transaction is accepted and commits
      await c.query(
        `INSERT INTO ledger_entries (transaction_id, ledger_account_id, currency, amount, amount_usd)
         VALUES ($1::uuid, $2::uuid, 'USD', 1, 1), ($1::uuid, $3::uuid, 'USD', -1, -1)`,
        [txId, cash.rows[0]?.id, capital.rows[0]?.id],
      );
    });
    expect((await balances(id))['CASH_USD']).toBe('10001.0000000000');
  });

  it('a new ledger account must start at balance 0 (control: 0 is accepted)', async () => {
    const id = await newGrantedAccount();
    await expectPgError(
      db.app.query(
        `INSERT INTO ledger_accounts (id, account_id, type, currency, balance)
         VALUES ($1::uuid, $2::uuid, 'ADJUSTMENT', 'USD', 1000)`,
        [randomUUID(), id],
      ),
      undefined,
      /start with balance 0/,
    );
    await db.app.query(
      `INSERT INTO ledger_accounts (id, account_id, type, currency, balance)
       VALUES ($1::uuid, $2::uuid, 'ADJUSTMENT', 'USD', 0)`,
      [randomUUID(), id],
    );
  });
});

// ---- 6. no overdraft ---------------------------------------------------------------------------

describe('6. no overdraft', () => {
  it('a buy larger than cash fails with InsufficientFundsError, posts nothing, keeps the transaction usable', async () => {
    const id = await newGrantedAccount();
    const before = await db.app.query<{ n: string }>(
      `SELECT count(*) AS n FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.account_id = $1::uuid`,
      [id],
    );
    await inTx(db.app, async (c) => {
      await expect(
        postTransaction(c, {
          accountId: id,
          kind: 'FILL',
          idempotencyKey: 'big-buy',
          legs: buyFillLegs({ qty: '11', price: '1000', fee: '0' }),
        }),
      ).rejects.toBeInstanceOf(InsufficientFundsError);
      // control: the same client/transaction still works, and a smaller buy goes through
      const ok = await postTransaction(c, {
        accountId: id,
        kind: 'FILL',
        idempotencyKey: 'small-buy',
        legs: buyFillLegs({ qty: '1', price: '1000', fee: '0' }),
      });
      expect(ok.created).toBe(true);
    });
    const b = await balances(id);
    expect(b['CASH_USD']).toBe('9000.0000000000');
    const key = await db.app.query(
      `SELECT 1 FROM ledger_transactions WHERE account_id = $1::uuid AND idempotency_key = 'big-buy'`,
      [id],
    );
    expect(key.rowCount).toBe(0); // the failed post left no transaction row behind
    const after = await db.app.query<{ n: string }>(
      `SELECT count(*) AS n FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.account_id = $1::uuid`,
      [id],
    );
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 2);
    expect(await reconcileAccount(db.app, id)).toEqual([]);
  });
});

// ---- 7. concurrency ---------------------------------------------------------------------------

describe('7. concurrency', () => {
  let big: Pool;
  beforeAll(() => {
    big = new pg.Pool({ connectionString: db.appUrl, max: 30 });
    big.on('error', () => undefined);
  });
  afterAll(async () => {
    await big.end();
  });

  it('50 parallel buys of 400 on 10,000 cash: exactly 25 succeed, the rest are InsufficientFunds, cash is 0', async () => {
    const id = await newGrantedAccount(big);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_unused, i) =>
        inTx(big, (c) =>
          postTransaction(c, {
            accountId: id,
            kind: 'FILL',
            idempotencyKey: `race-${String(i)}`,
            legs: buyFillLegs({ qty: '4', price: '100', fee: '0' }),
          }),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(25);
    expect(failed).toHaveLength(25);
    for (const f of failed) expect(f.reason).toBeInstanceOf(InsufficientFundsError); // no deadlocks, no other errors
    const b = await balances(id, big);
    expect(b['CASH_USD']).toBe('0.0000000000');
    expect(b['POSITION_COST_USD']).toBe('10000.0000000000');
    expect(await reconcileAccount(big, id)).toEqual([]);
  });

  it('50 parallel multi-leg sells and buys on one account do not deadlock', async () => {
    const id = await newGrantedAccount(big);
    await post(id, 'seed-buy', buyFillLegs({ qty: '50', price: '100', fee: '0' })); // POSITION_COST 5000
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_unused, i) =>
        inTx(big, (c) =>
          postTransaction(c, {
            accountId: id,
            kind: 'FILL',
            idempotencyKey: `mix-${String(i)}`,
            legs:
              i % 2 === 0
                ? buyFillLegs({ qty: '1', price: '10', fee: '0.01' })
                : sellFillLegs({ qty: '1', price: '12', fee: '0.01', basis: '10' }),
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect(await reconcileAccount(big, id)).toEqual([]);
  });

  it('100 parallel posts of the same key create exactly one transaction, all return its id', async () => {
    const id = await newGrantedAccount(big);
    const legs = buyFillLegs({ qty: '1', price: '100', fee: '0' });
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        inTx(big, (c) =>
          postTransaction(c, { accountId: id, kind: 'FILL', idempotencyKey: 'same-key', legs }),
        ),
      ),
    );
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const n = await big.query<{ n: string }>(
      `SELECT count(*) AS n FROM ledger_transactions WHERE account_id = $1::uuid AND idempotency_key = 'same-key'`,
      [id],
    );
    expect(n.rows[0]?.n).toBe('1');
    expect((await balances(id, big))['CASH_USD']).toBe('9900.0000000000');
    expect(await reconcileAccount(big, id)).toEqual([]);
  });

  it('the same key with the same legs is a no-op, with different legs throws IdempotencyConflictError', async () => {
    const id = await newGrantedAccount();
    const legs = buyFillLegs({ qty: '1', price: '100', fee: '0' });
    const first = await post(id, 'k-1', legs);
    const again = await post(id, 'k-1', legs); // control
    expect(again).toEqual({ transactionId: first.transactionId, created: false });
    await expect(
      post(id, 'k-1', buyFillLegs({ qty: '2', price: '100', fee: '0' })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await balances(id))['CASH_USD']).toBe('9900.0000000000'); // nothing extra was posted
  });
});

// ---- 8. property test on Postgres --------------------------------------------------------------

// Independent model in scaled integers (units of 1e-8): not the code under test.
const UNIT = 100000000n;
function toUnits(s: string): bigint {
  const [i = '0', f = ''] = s.split('.');
  return BigInt(i) * UNIT + BigInt(f.padEnd(8, '0').slice(0, 8));
}
function fmtUnits(u: bigint): string {
  const neg = u < 0n;
  const a = neg ? -u : u;
  return `${neg ? '-' : ''}${(a / UNIT).toString()}.${(a % UNIT).toString().padStart(8, '0')}`;
}
/** (a x b) / 1e8 rounded HALF_EVEN, for a, b in units of 1e-8 (the product is in units of 1e-16). */
function mulRound(a: bigint, b: bigint): bigint {
  const prod = a * b;
  const q = prod / UNIT;
  const r = prod % UNIT;
  const twice = r * 2n;
  if (twice > UNIT) return q + 1n;
  if (twice < UNIT) return q;
  return q % 2n === 0n ? q : q + 1n;
}

type Op =
  | { kind: 'buy'; qty: string; price: string; fee: string }
  | { kind: 'sell'; qty: string; price: string; fee: string; pct: number };

const digitStr = (lo: number, hi: number) =>
  fc.stringMatching(new RegExp(`^[0-9]{${String(lo)},${String(hi)}}$`));
const qtyArb = fc
  .tuple(digitStr(1, 3), digitStr(0, 4))
  .map(([i, f]) => `${i}${f === '' ? '' : `.${f}`}`)
  .filter((s) => toUnits(s) >= toUnits('0.0001'));
const priceArb = fc
  .tuple(digitStr(1, 4), digitStr(0, 4))
  .map(([i, f]) => `${i}${f === '' ? '' : `.${f}`}`)
  .filter((s) => toUnits(s) >= toUnits('0.01'));
const feeArb = fc
  .tuple(digitStr(1, 2), digitStr(0, 6))
  .map(([i, f]) => `${i}${f === '' ? '' : `.${f}`}`);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('buy' as const), qty: qtyArb, price: priceArb, fee: feeArb }),
  fc.record({
    kind: fc.constant('sell' as const),
    qty: qtyArb,
    price: priceArb,
    fee: feeArb,
    pct: fc.integer({ min: 0, max: 100 }),
  }),
);

describe('8. property test on Postgres', () => {
  it('random buys and sells keep every invariant after every step', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 15 }), async (ops) => {
        const id = await newGrantedAccount();
        let cash = toUnits('10000');
        let pos = 0n;
        let fees = 0n;
        let pnl = 0n; // sum of (P - B)
        let n = 0;
        for (const op of ops) {
          n += 1;
          const key = `op-${String(n)}`;
          const price = toUnits(op.price);
          const qty = toUnits(op.qty);
          const fee = toUnits(op.fee);
          const gross = mulRound(qty, price);
          if (op.kind === 'buy') {
            const need = gross + fee;
            const attempt = post(
              id,
              key,
              buyFillLegs({ qty: op.qty, price: op.price, fee: op.fee }),
            );
            if (cash < need) {
              await expect(attempt).rejects.toBeInstanceOf(InsufficientFundsError);
            } else {
              await attempt;
              cash -= need;
              pos += gross;
              fees += fee;
            }
          } else {
            const basis = (pos * BigInt(op.pct)) / 100n;
            const delta = gross - fee;
            const attempt = post(
              id,
              key,
              sellFillLegs({ qty: op.qty, price: op.price, fee: op.fee, basis: fmtUnits(basis) }),
            );
            if (cash + delta < 0n) {
              await expect(attempt).rejects.toBeInstanceOf(InsufficientFundsError);
            } else {
              await attempt;
              cash += delta;
              fees += fee;
              pos -= basis;
              pnl += gross - basis;
            }
          }
          expect(await reconcileAccount(db.app, id)).toEqual([]);
          const b = await balances(id);
          expect(b['CASH_USD']).toBe(`${fmtUnits(cash)}00`);
        }
        const b = await balances(id);
        expect(b['POSITION_COST_USD']).toBe(`${fmtUnits(pos)}00`);
        expect(b['FEES_USD']).toBe(`${fmtUnits(fees)}00`);
        expect(b['REALIZED_PNL_USD']).toBe(`${fmtUnits(-pnl)}00`); // REALIZED_PNL = -sum(P - B)
      }),
      { numRuns: 30 },
    );
  }, 240_000);
});

// ---- 9. numeric fidelity ------------------------------------------------------------------------

describe('9. numeric fidelity', () => {
  it('no numeric parser is registered: a read returns a string such as 0.1000000000', async () => {
    const r = await db.app.query<{ v: unknown }>('SELECT 0.1::numeric(28,10) AS v');
    expect(r.rows[0]?.v).toBe('0.1000000000');
    expect(typeof r.rows[0]?.v).toBe('string');
    expect(typeof pg.types.getTypeParser(1700)('0.1')).toBe('string');
    expect(typeof pg.types.getTypeParser(1700, 'text')('0.1')).toBe('string');
  });

  it('10-decimal values and 18-digit integers round-trip through Postgres unchanged', async () => {
    const id = await newGrantedAccount();
    const big = '899999999999999999.1234567891'; // 18 + 10 digits (the balance stays within 28 digits)
    const tiny = '0.0000000001';
    const t1 = await post(id, 'fid-1', [
      { ledgerAccountType: 'CASH', currency: 'USD', amount: big },
      { ledgerAccountType: 'CAPITAL', currency: 'USD', amount: `-${big}` },
    ]);
    const t2 = await post(id, 'fid-2', [
      { ledgerAccountType: 'CASH', currency: 'USD', amount: tiny },
      { ledgerAccountType: 'CAPITAL', currency: 'USD', amount: `-${tiny}` },
    ]);
    expect(await entryRows(id, t1.transactionId)).toEqual([`CAPITAL -${big}`, `CASH ${big}`]);
    expect(await entryRows(id, t2.transactionId)).toEqual([`CAPITAL -${tiny}`, `CASH ${tiny}`]);
    const b = await balances(id);
    // 10000 + 899999999999999999.1234567891 + 0.0000000001 = 900000000000009999.1234567892 (hand check)
    expect(b['CASH_USD']).toBe('900000000000009999.1234567892');
  });

  it('the grant legs built by the engine keep exact 8-decimal values through the database', async () => {
    const id = await newGrantedAccount(db.app, '12345678.12345678');
    expect((await balances(id))['CASH_USD']).toBe('12345678.1234567800');
    expect(grantLegs({ amount: '12345678.12345678' })[0]?.amount).toBe('12345678.12345678');
  });
});

// ---- 10. M2 schema hardening (migrations 0007 and 0008) ------------------------------------------

describe('10. transactions must have entries; accounts need a real user', () => {
  it('a transaction with zero entries is rejected at commit (must fail)', async () => {
    const id = await newGrantedAccount();
    const c = await db.app.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO ledger_transactions (id, account_id, kind, idempotency_key)
         VALUES ($1::uuid, $2::uuid, 'ADJUSTMENT', 'empty-1')`,
        [randomUUID(), id],
      );
      await expectPgError(c.query('COMMIT'), undefined, /has no entries/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
    const left = await db.app.query(
      `SELECT 1 FROM ledger_transactions WHERE account_id = $1::uuid AND idempotency_key = 'empty-1'`,
      [id],
    );
    expect(left.rowCount).toBe(0);
  });

  it('normal posting is unaffected (control) and an idempotent replay still works', async () => {
    const id = await newGrantedAccount();
    const legs = buyFillLegs({ qty: '1', price: '100', fee: '0' });
    const first = await post(id, 'ok-1', legs);
    const again = await post(id, 'ok-1', legs);
    expect(again).toEqual({ transactionId: first.transactionId, created: false });
    expect((await balances(id))['CASH_USD']).toBe('9900.0000000000');
  });

  it('an account for a user that does not exist is rejected (control: an existing user works)', async () => {
    await expectPgError(
      inTx(db.app, (c) =>
        createAccount(c, {
          accountId: randomUUID(),
          userId: randomUUID(),
          kind: 'MAIN',
          initialCapital: '10000',
        }),
      ),
      '23503',
    );
    await newGrantedAccount();
  });

  it('an email with leading or trailing whitespace is rejected, and uniqueness is case-insensitive', async () => {
    const insert = (email: string) =>
      db.app.query(
        `INSERT INTO users (id, email, password_hash, display_name, is_adult)
         VALUES ($1::uuid, $2, 'x', 'Test User', true)`,
        [randomUUID(), email],
      );
    await expectPgError(insert(' lead@example.com'), '23514');
    await expectPgError(insert('trail@example.com\t'), '23514');
    await insert('Case@Example.com'); // control
    await expectPgError(insert('case@example.COM'), '23505');
  });
});
