// M8b-1 T4/T7: the matcher and the concurrency of limit orders on real Postgres (app role). runMatcherOnce is called directly with
// an injected quote source and clock. Expectations that depend on counting (N accepts) are computed independently with BigInt.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FreshnessState, InstrumentStatus, Quote } from '@vantage/market-model';
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { newId } from '../../ids.js';
import {
  NOW,
  accept,
  accountState,
  cancel,
  createFundedAccount,
  createInstrument,
  cryptoCommand,
  fillResting,
  freshQuote,
  limitCommand,
  run,
  seededCrypto,
} from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';
import type { Logger } from '../../log.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import { MATCHER_LOCK_KEY, runMatcherOnce } from './matcher.js';
import type { MatcherDeps, QuoteSource } from './matcher.js';

let db: TestDatabase;
let big: pg.Pool;
let btc: TestInstrument;
let stock: TestInstrument;

class FakeQuotes implements QuoteSource {
  readonly #by = new Map<string, { freshness: FreshnessState; quote: Quote | null }>();
  set(
    symbol: string,
    bid: string,
    ask: string,
    freshness: FreshnessState = 'REAL_TIME',
    at: Date = NOW,
  ): void {
    this.#by.set(symbol, {
      freshness,
      quote: {
        symbol,
        bid,
        ask,
        providerTs: new Date(at.getTime() - 1000),
        receivedAt: at,
        source: 'SIM',
        entitlement: 'REAL_TIME',
        delaySeconds: 0,
      },
    });
  }
  unavailable(symbol: string): void {
    this.#by.set(symbol, { freshness: 'UNAVAILABLE', quote: null });
  }
  snapshotFor(i: {
    symbol: string;
    exchange: string;
    status: InstrumentStatus;
    assetClass: string;
  }) {
    return Promise.resolve(
      this.#by.get(i.symbol) ?? { freshness: 'UNAVAILABLE' as const, quote: null },
    );
  }
}

function logs(): {
  logger: Logger;
  lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
} {
  const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const mk = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, ...(fields === undefined ? {} : { fields }) });
  };
  return {
    logger: { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') },
    lines,
  };
}

beforeEach(async () => {
  const open = await db.migrator.query<{ id: string; account_id: string }>(
    `SELECT id, account_id FROM orders WHERE status = 'ACCEPTED'`,
  );
  for (const o of open.rows) await cancel(big, o.id, o.account_id);
});

beforeAll(async () => {
  db = await createTestDatabase();
  big = new pg.Pool({ connectionString: db.appUrl, max: 30 });
  btc = await seededCrypto(db, 'BTC-USD');
  stock = await createInstrument(db, 'MTCH1');
}, 120_000);
afterAll(async () => {
  await big?.end().catch(() => undefined);
  await db?.dispose();
});

const dec = (s: unknown): string => parse(String(s)).toString();
async function balances(accountId: string): Promise<Record<string, string>> {
  const r = await db.migrator.query<{ type: string; balance: string }>(
    `SELECT type::text AS type, balance FROM ledger_accounts WHERE account_id = $1::uuid AND currency = 'USD'`,
    [accountId],
  );
  return Object.fromEntries(r.rows.map((x) => [x.type, dec(x.balance)]));
}
async function status(orderId: string): Promise<string> {
  return (
    (
      await db.migrator.query<{ status: string }>(
        `SELECT status::text FROM orders WHERE id = $1::uuid`,
        [orderId],
      )
    ).rows[0]?.status ?? ''
  );
}
const clean = async (accountId: string): Promise<void> => {
  expect(await reconcileAccount(db.migrator, accountId)).toEqual([]);
};
const deps = (
  quotes: FakeQuotes,
  over: Partial<MatcherDeps> = {},
): { d: MatcherDeps; lines: ReturnType<typeof logs>['lines'] } => {
  const l = logs();
  return { d: { pool: big, quotes, logger: l.logger, ...over }, lines: l.lines };
};
const STOCK_SCHEDULE = {
  commissionBps: '0',
  commissionMinLocal: '0',
  slippageBaseBps: '2',
  slippageSizeCoef: '0',
  modelVersion: 'QBX-1/r8he',
};
const stockLimit = (a: string, side: 'BUY' | 'SELL', qty: string, limitPrice: string) =>
  limitCommand(a, stock, {
    side,
    qty,
    limitPrice,
    bid: '189.95',
    ask: '190.00',
    feeSchedule: STOCK_SCHEDULE,
    instrument: { tickSize: '0.01', minQty: '1', qtyStep: '1', assetClass: 'EQUITY' },
  });

describe('matcher semantics', () => {
  it('a STALE, CLOSED or UNAVAILABLE quote is not evaluated; a fresh quote then fills at THAT quote (no back-fill), once', async () => {
    const a = await createFundedAccount(db.app, '10000');
    const cmd = limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    await accept(db.app, cmd);
    const q = new FakeQuotes();
    const { d } = deps(q);
    for (const fr of ['STALE', 'CLOSED'] as const) {
      q.set('BTC-USD', '89830.00', '89850.00', fr); // satisfies the limit, but is not evaluable
      const r = await runMatcherOnce(d, NOW);
      expect(r).toMatchObject({ notEvaluable: 1, filled: 0, errors: 0 });
    }
    q.unavailable('BTC-USD');
    expect(await runMatcherOnce(d, NOW)).toMatchObject({ notEvaluable: 1, filled: 0 });
    expect(await status(cmd.orderId)).toBe('ACCEPTED');
    expect(await balances(a)).toMatchObject({ CASH: '9775.02525', RESERVED: '224.97475' });

    q.set('BTC-USD', '89700.00', '89710.00'); // a fresh, different quote
    const r = await runMatcherOnce(d, NOW);
    expect(r).toMatchObject({ evaluated: 1, filled: 1, errors: 0 });
    const ex = await db.migrator.query<{ price: string }>(
      `SELECT price FROM executions WHERE order_id = $1::uuid`,
      [cmd.orderId],
    );
    expect(dec(ex.rows[0]?.price)).toBe('89754.86'); // the NEW quote (89,710.00 x 1.0005 = 89,754.855 up to the tick), never the stale one
    // one fill per order per quote: the same quote again evaluates nothing (the order is FILLED)
    expect(await runMatcherOnce(d, NOW)).toMatchObject({ instruments: 0, filled: 0 });
    await clean(a);
  });

  it('a stock whose market is CLOSED is not evaluated either (the freshness comes from the shared function)', async () => {
    const a = await createFundedAccount(db.app, '10000');
    const cmd = stockLimit(a, 'BUY', '5', '189.00');
    await accept(db.app, cmd);
    const q = new FakeQuotes();
    const { d } = deps(q);
    q.set('MTCH1', '188.00', '188.50', 'CLOSED');
    expect(await runMatcherOnce(d, NOW)).toMatchObject({ notEvaluable: 1, filled: 0 });
    expect(await status(cmd.orderId)).toBe('ACCEPTED');
    q.set('MTCH1', '188.00', '188.50', 'REAL_TIME'); // market open and live: ask 188.50 <= 189.00
    expect(await runMatcherOnce(d, NOW)).toMatchObject({ filled: 1 });
    // 188.50 x 1.0002 = 188.5377 -> up to the tick 188.54 < the limit 189.00
    const ex = await db.migrator.query<{ price: string }>(
      `SELECT price FROM executions WHERE order_id = $1::uuid`,
      [cmd.orderId],
    );
    expect(dec(ex.rows[0]?.price)).toBe('188.54');
    await clean(a);
  });

  it('evaluation order is created_at then id: the older order fills first; with equal timestamps the smaller id first', async () => {
    const a = await createFundedAccount(db.app, '100000');
    const t1 = new Date(NOW.getTime() + 1000);
    const t2 = new Date(NOW.getTime() + 2000);
    const newer = limitCommand(a, btc, {
      side: 'BUY',
      qty: '0.001',
      limitPrice: '89900.00',
      now: t2,
    });
    const older = limitCommand(a, btc, {
      side: 'BUY',
      qty: '0.001',
      limitPrice: '89900.00',
      now: t1,
    });
    await accept(db.app, newer); // accepted FIRST in wall-clock order but created later (created_at = t2)
    await accept(db.app, older);
    const sameA = limitCommand(a, btc, {
      side: 'BUY',
      qty: '0.001',
      limitPrice: '89900.00',
      now: t2,
    });
    const sameB = limitCommand(a, btc, {
      side: 'BUY',
      qty: '0.001',
      limitPrice: '89900.00',
      now: t2,
    });
    await accept(db.app, sameA);
    await accept(db.app, sameB);
    const q = new FakeQuotes();
    q.set('BTC-USD', '89830.00', '89850.00', 'REAL_TIME', t2);
    const seen: string[] = [];
    const { d } = deps(q, { beforeOrder: (id) => void seen.push(id) });
    const r = await runMatcherOnce(d, t2);
    expect(r.filled).toBe(4);
    const tied = [newer.orderId, sameA.orderId, sameB.orderId].sort();
    expect(seen).toEqual([older.orderId, ...tied]); // older (t1) first, then the t2 orders by id
    await clean(a);
  });

  it('when cash allows only one, the older order gets it: the second is rejected at accept, never half-funded', async () => {
    const a = await createFundedAccount(db.app, '300');
    const first = limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    const second = limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    expect((await accept(db.app, first)).outcome).toBe('ACCEPTED');
    const r2 = await accept(db.app, second);
    expect(r2.outcome === 'REJECTED' && r2.rejectCode).toBe('INSUFFICIENT_BUYING_POWER');
    const q = new FakeQuotes();
    q.set('BTC-USD', '89830.00', '89850.00');
    const { d } = deps(q);
    expect(await runMatcherOnce(d, NOW)).toMatchObject({ filled: 1 });
    expect(await status(first.orderId)).toBe('FILLED');
    expect(await status(second.orderId)).toBe('REJECTED');
    await clean(a);
  });

  it('the expiry job expires orders past their expiry (releasing the reserve) and leaves the others (control)', async () => {
    const a = await createFundedAccount(db.app, '10000');
    const soon = limitCommand(a, btc, {
      side: 'BUY',
      qty: '0.0025',
      limitPrice: '89900.00',
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const later = limitCommand(a, btc, { side: 'BUY', qty: '0.001', limitPrice: '89900.00' });
    await accept(db.app, soon);
    await accept(db.app, later);
    const q = new FakeQuotes();
    q.set('BTC-USD', '90100.00', '90110.00'); // not crossing
    const { d } = deps(q);
    const at = new Date(NOW.getTime() + 120_000);
    const r = await runMatcherOnce(d, at);
    expect(r.expired).toBe(1);
    expect(await status(soon.orderId)).toBe('EXPIRED');
    expect(await status(later.orderId)).toBe('ACCEPTED');
    expect((await balances(a)).RESERVED).toBe('89.9899'); // only the later order's reserve remains
    await clean(a);
  });

  it('a held advisory lock makes the tick a no-op; released, the tick runs (control); the lock is released after a tick', async () => {
    const a = await createFundedAccount(db.app, '10000');
    const cmd = limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    await accept(db.app, cmd);
    const q = new FakeQuotes();
    q.set('BTC-USD', '89830.00', '89850.00');
    const { d } = deps(q);
    const holder = await big.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock($1::bigint)`, [MATCHER_LOCK_KEY]);
      expect(await runMatcherOnce(d, NOW)).toMatchObject({ skippedByLock: true, filled: 0 });
      expect(await status(cmd.orderId)).toBe('ACCEPTED');
      await holder.query(`SELECT pg_advisory_unlock($1::bigint)`, [MATCHER_LOCK_KEY]);
    } finally {
      holder.release();
    }
    expect(await runMatcherOnce(d, NOW)).toMatchObject({ skippedByLock: false, filled: 1 });
    // the lock is free again: another tick can take it
    expect((await runMatcherOnce(d, NOW)).skippedByLock).toBe(false);
    await clean(a);
  });
});

describe('failure isolation: one order failing does not stop the others and never leaves money half-moved', () => {
  it('a failure in one fill (a thrown error, and an injected failure after the ledger post) is logged; the others fill; the failed order is intact', async () => {
    const a = await createFundedAccount(db.app, '100000');
    const orders: ReturnType<typeof limitCommand>[] = [];
    for (let i = 0; i < 4; i += 1) {
      const c = limitCommand(a, btc, {
        side: 'BUY',
        qty: '0.001',
        limitPrice: '89900.00',
        now: new Date(NOW.getTime() + i * 1000),
      });
      await accept(db.app, c);
      orders.push(c);
    }
    const q = new FakeQuotes();
    q.set('BTC-USD', '89830.00', '89850.00', 'REAL_TIME', new Date(NOW.getTime() + 10_000));
    const at = new Date(NOW.getTime() + 10_000);
    // the first order throws before its step; the second fails AFTER its ledger post (a hook) on its first call only
    let postCalls = 0;
    const { d, lines } = deps(q, {
      beforeOrder: (id) => {
        if (id === orders[0]?.orderId) throw new Error('boom: first order');
      },
      hooks: {
        afterLedgerPost: () => {
          postCalls += 1;
          if (postCalls === 1) throw new Error('boom: after the ledger post');
        },
      },
    });
    const before = await accountState(db, a);
    const r = await runMatcherOnce(d, at);
    expect(r.errors).toBe(2);
    expect(r.filled).toBe(2);
    expect(lines.filter((l) => l.msg === 'matcher_fill_failed')).toHaveLength(2);
    expect(await status(orders[0]?.orderId ?? '')).toBe('ACCEPTED'); // thrown before its step
    expect(await status(orders[1]?.orderId ?? '')).toBe('ACCEPTED'); // rolled back after the ledger post
    expect(await status(orders[2]?.orderId ?? '')).toBe('FILLED');
    expect(await status(orders[3]?.orderId ?? '')).toBe('FILLED');
    await clean(a); // RESERVED still holds exactly the two open orders
    const mid = await accountState(db, a);
    expect(mid.counts.executions).toBe((before.counts.executions ?? 0) + 2);
    // the next tick fills the two that failed (control: nothing was lost)
    const r2 = await runMatcherOnce(deps(q).d, at);
    expect(r2).toMatchObject({ filled: 2, errors: 0 });
    await clean(a);
  });
});

describe('concurrency on real Postgres', () => {
  it('(a) 50 parallel limit BUYs exceeding the cash: exactly N accepted (N computed with BigInt), cash never negative, RESERVED exact', async () => {
    const a = await createFundedAccount(big, '2000');
    const reserveUnits = 22_497_475_000n; // R = 224.97475 (0.0025 x 89,900.00 = 224.75 plus 0.22475)
    const n = Number(200_000_000_000n / reserveUnits); // 2,000.00 / 224.97475 = 8.89 -> 8
    expect(n).toBe(8);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        accept(big, limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' })),
      ),
    );
    expect(results.filter((r) => r.outcome === 'ACCEPTED')).toHaveLength(n);
    const rejected = results.filter((r) => r.outcome === 'REJECTED');
    expect(rejected).toHaveLength(50 - n);
    for (const r of rejected)
      expect(r.outcome === 'REJECTED' && r.rejectCode).toBe('INSUFFICIENT_BUYING_POWER');
    // 8 x 224.97475 = 1,799.798; cash 2,000 - 1,799.798 = 200.202
    expect(await balances(a)).toMatchObject({ RESERVED: '1799.798', CASH: '200.202' });
    await clean(a);
  }, 120_000);

  it('(b) cancel vs fill race, 1,000 iterations: each has exactly one outcome (FILLED xor CANCELLED), money exact, reserve back to 0', async () => {
    const ITER = 1000;
    const a = await createFundedAccount(big, '1000000000');
    const accounts = [a];
    let filled = 0;
    let cancelled = 0;
    for (let i = 0; i < ITER; i += 1) {
      const cmd = limitCommand(a, btc, {
        side: 'BUY',
        qty: '0.0025',
        limitPrice: '89900.00',
        now: new Date(NOW.getTime() + i),
      });
      expect((await accept(big, cmd)).outcome).toBe('ACCEPTED');
      const at = new Date(NOW.getTime() + i);
      // the fill path reads the order's account (one round trip) before it takes the account lock, so with equal starts the
      // cancel nearly always wins: start the cancel after a varying offset of 0 to 14 ms so both interleavings happen
      const doCancel = () =>
        new Promise((r) => setTimeout(r, i % 15)).then(() => cancel(big, cmd.orderId, a, at));
      const doFill = () =>
        fillResting(big, cmd.orderId, btc, freshQuote('89830.00', '89850.00', at), { now: at });
      // alternate which of the two is started first, so both interleavings are exercised
      let cp: ReturnType<typeof doCancel>;
      let fp: ReturnType<typeof doFill>;
      if (i % 2 === 0) {
        cp = doCancel();
        fp = doFill();
      } else {
        fp = doFill();
        cp = doCancel();
      }
      const [c, f] = await Promise.all([cp, fp]);
      const cancelWon = c?.outcome === 'CANCELLED';
      const fillWon = f?.outcome === 'FILLED';
      expect(cancelWon !== fillWon, `iteration ${String(i)}: exactly one winner`).toBe(true); // never both, never neither
      if (cancelWon) {
        expect(f?.outcome).toBe('SKIPPED');
        cancelled += 1;
        expect(await status(cmd.orderId)).toBe('CANCELLED');
      } else {
        expect(c?.outcome).toBe('NOT_OPEN');
        filled += 1;
        expect(await status(cmd.orderId)).toBe('FILLED');
      }
      if (i % 100 === 99) {
        expect((await balances(a)).RESERVED).toBe('0'); // nothing is left reserved after any iteration
        await clean(a);
      }
    }
    expect(filled + cancelled).toBe(ITER);
    const ex = await db.migrator.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM executions WHERE account_id = $1::uuid`,
      [a],
    );
    expect(Number(ex.rows[0]?.n)).toBe(filled); // one execution per filled order, none for a cancelled one
    process.stdout.write(
      `M8B1_RACE iterations=${String(ITER)} filled=${String(filled)} cancelled=${String(cancelled)}\n`,
    );
    for (const x of accounts) await clean(x);
  }, 900_000);

  it('(c) 100 parallel cancels of one order: exactly one CANCELLED, the rest NOT_OPEN, the reserve released once', async () => {
    const a = await createFundedAccount(big, '10000');
    const cmd = limitCommand(a, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    await accept(big, cmd);
    const results = await Promise.all(
      Array.from({ length: 100 }, () => cancel(big, cmd.orderId, a)),
    );
    expect(results.filter((r) => r.outcome === 'CANCELLED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'NOT_OPEN')).toHaveLength(99);
    expect(await balances(a)).toMatchObject({ CASH: '10000', RESERVED: '0' });
    const rel = await db.migrator.query(
      `SELECT 1 FROM ledger_transactions WHERE account_id = $1::uuid AND kind = 'ORDER_RELEASE'`,
      [a],
    );
    expect(rel.rowCount).toBe(1);
    await clean(a);
  }, 120_000);

  it('(d) 100 parallel accepts with one client order id: one order and one reserve (the rest are replays)', async () => {
    const a = await createFundedAccount(big, '10000');
    const clientOrderId = `dup-${newId()}`;
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        accept(
          big,
          limitCommand(a, btc, {
            side: 'BUY',
            qty: '0.0025',
            limitPrice: '89900.00',
            clientOrderId,
            orderId: newId(),
          }),
        ),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.outcome === 'ACCEPTED')).toBe(true);
    const st = await accountState(db, a);
    expect(st.counts.orders).toBe(1);
    const res = await db.migrator.query(
      `SELECT 1 FROM ledger_transactions WHERE account_id = $1::uuid AND kind = 'ORDER_RESERVE'`,
      [a],
    );
    expect(res.rowCount).toBe(1);
    expect(await balances(a)).toMatchObject({ CASH: '9775.02525', RESERVED: '224.97475' });
    await clean(a);
  }, 120_000);

  it('(e) the matcher (twice at once, with and without the advisory lock) races cancels, expiries and market orders: no double fill, no deadlock, reconcile clean', async () => {
    const a = await createFundedAccount(big, '1000000');
    await run(big, cryptoCommand(a, btc, { qty: '0.5' })); // a position for the SELLs
    const mk = (side: 'BUY' | 'SELL', i: number, expiresAt?: Date) =>
      limitCommand(a, btc, {
        side,
        qty: '0.001',
        limitPrice: side === 'BUY' ? '89900.00' : '90100.00',
        now: new Date(NOW.getTime() + i),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
    const buys = Array.from({ length: 30 }, (_, i) => mk('BUY', i));
    const sells = Array.from({ length: 30 }, (_, i) => mk('SELL', 100 + i));
    const expiring = Array.from({ length: 10 }, (_, i) =>
      mk('BUY', 200 + i, new Date(NOW.getTime() + 5_000)),
    );
    for (const c of [...buys, ...sells, ...expiring])
      expect((await accept(big, c)).outcome).toBe('ACCEPTED');
    const crossBuy = new FakeQuotes();
    crossBuy.set('BTC-USD', '90150.00', '89850.00'); // bid above the SELL limits and ask below the BUY limits: everything crosses
    const at = new Date(NOW.getTime() + 10_000); // the expiring orders are past their expiry
    const lockedDeps = deps(crossBuy).d;
    const unlockedDeps = deps(crossBuy, { useAdvisoryLock: false }).d;
    const jobs: Array<Promise<unknown>> = [
      runMatcherOnce(lockedDeps, at),
      runMatcherOnce(lockedDeps, at),
      runMatcherOnce(unlockedDeps, at),
      runMatcherOnce(unlockedDeps, at),
      ...buys.slice(0, 10).map((c) => cancel(big, c.orderId, a, at)),
      ...sells.slice(0, 10).map((c) => cancel(big, c.orderId, a, at)),
      ...Array.from({ length: 10 }, () =>
        run(big, cryptoCommand(a, btc, { side: 'BUY', qty: '0.002', now: at })),
      ),
      ...Array.from({ length: 10 }, () =>
        run(big, cryptoCommand(a, btc, { side: 'SELL', qty: '0.003', now: at })),
      ),
    ];
    await Promise.all(jobs);
    // after one more serial tick everything that can fill has filled and every order is terminal
    await runMatcherOnce(lockedDeps, at);
    const open = await db.migrator.query(
      `SELECT 1 FROM orders WHERE account_id = $1::uuid AND status = 'ACCEPTED'`,
      [a],
    );
    expect(open.rowCount).toBe(0);
    // no double fill: at most one execution per order, and an execution only for a FILLED order
    const dupes = await db.migrator.query(
      `SELECT order_id FROM executions WHERE account_id = $1::uuid GROUP BY order_id HAVING count(*) > 1`,
      [a],
    );
    expect(dupes.rowCount).toBe(0);
    const bad = await db.migrator.query(
      `SELECT 1 FROM orders o WHERE o.account_id = $1::uuid AND ((o.status = 'FILLED') <> EXISTS (SELECT 1 FROM executions e WHERE e.order_id = o.id))`,
      [a],
    );
    expect(bad.rowCount).toBe(0);
    expect((await balances(a)).RESERVED).toBe('0');
    await clean(a);
  }, 300_000);

  it('(f) two accounts in parallel do not block each other: the matcher fills B while A is locked; a second order on A waits (control)', async () => {
    const accA = await createFundedAccount(big, '10000');
    const accB = await createFundedAccount(big, '10000');
    const ob = limitCommand(accB, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' });
    await accept(big, ob);
    const holder = await big.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT lock_account_for_order($1::uuid)', [accA]);
      let aDone = false;
      const orderA = accept(
        big,
        limitCommand(accA, btc, { side: 'BUY', qty: '0.0025', limitPrice: '89900.00' }),
      ).then((r) => {
        aDone = true;
        return r;
      });
      const q = new FakeQuotes();
      q.set('BTC-USD', '89830.00', '89850.00');
      const filled = await Promise.race([
        runMatcherOnce(deps(q).d, NOW),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000)),
      ]);
      expect(filled).not.toBe('timeout');
      expect(await status(ob.orderId)).toBe('FILLED');
      expect(aDone).toBe(false); // A is still waiting for its lock (the control)
      await holder.query('COMMIT');
      expect((await orderA).outcome).toBe('ACCEPTED');
    } finally {
      holder.release();
    }
    await clean(accA);
    await clean(accB);
  }, 60_000);
});
