// Order throughput benchmark over real HTTP (NOT a CI gate: it only runs when VANTAGE_BENCH=1, via `pnpm bench:orders:http`).
// (a) sequential orders on one account, (b) 20 accounts in parallel. Prints p50/p95, orders/s and the number of
// database round trips per order (every call to pg.Client.query is one round trip), with a per-statement breakdown.
import pg from 'pg';
import { createTestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Harness } from '../../testing/harness.js';
import {
  BUY_AAPL,
  createOrdersHarness,
  newKey,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import type { TestUser } from '../../testing/orders-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';

const enabled = process.env.VANTAGE_BENCH === '1';

type QueryFn = (...args: unknown[]) => unknown;
const proto = pg.Client.prototype as unknown as { query: QueryFn };
const originalQuery = proto.query;
let counting = false;
const statements = new Map<string, number>();
let total = 0;

function sqlOf(arg: unknown): string {
  const text =
    typeof arg === 'string'
      ? arg
      : typeof arg === 'object' && arg !== null && 'text' in arg
        ? String((arg as { text: unknown }).text)
        : '?';
  return text.replace(/\s+/g, ' ').trim().slice(0, 70);
}

function startCounting(): void {
  statements.clear();
  total = 0;
  proto.query = function (this: unknown, ...args: unknown[]): unknown {
    if (counting) {
      total += 1;
      const k = sqlOf(args[0]);
      statements.set(k, (statements.get(k) ?? 0) + 1);
    }
    return originalQuery.apply(this, args);
  };
}

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const f = (x: number): string => x.toFixed(1);
const ms = (t0: bigint): number => Number(process.hrtime.bigint() - t0) / 1e6;

describe.runIf(enabled)('order API benchmark (HTTP)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let h: Harness;
  beforeAll(async () => {
    db = await createTestDatabase();
    h = await createOrdersHarness(db);
    await setQuote(h, 'AAPL', '99.98', '100.00');
    startCounting();
  });
  afterAll(async () => {
    proto.query = originalQuery;
    await h.close();
    await db.dispose();
  });

  async function oneOrder(u: TestUser, i: number): Promise<number> {
    const buy = i % 2 === 0;
    const body = buy
      ? { ...BUY_AAPL, qty: '1', referencePrice: '100.00' }
      : { ...BUY_AAPL, side: 'SELL', qty: '1', referencePrice: '99.98' };
    const t0 = process.hrtime.bigint();
    const res = await placeOrder(h, u, newKey(), body);
    const elapsed = ms(t0);
    if (res.status !== 201 || res.body.status !== 'FILLED') {
      throw new Error(`unexpected ${String(res.status)} ${JSON.stringify(res.body)}`);
    }
    return elapsed;
  }

  function report(title: string, times: number[], seconds: number, orders: number): void {
    const sorted = [...times].sort((a, b) => a - b);
    const lines = [
      `bench:orders:http ${title}  orders=${String(orders)}`,
      `  p50=${f(pct(sorted, 50))} ms  p95=${f(pct(sorted, 95))} ms  p99=${f(pct(sorted, 99))} ms  max=${f(sorted[sorted.length - 1] ?? 0)} ms`,
      `  throughput=${f(orders / seconds)} orders/s  DB round trips per order (all queries, incl. session and audit)=${(total / orders).toFixed(1)}`,
      '  statements per order:',
      ...[...statements.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `    ${(n / orders).toFixed(2).padStart(6)}  ${k}`),
    ];
    process.stdout.write(lines.join('\n') + '\n');
  }

  it('(a) 300 sequential orders on one account', async () => {
    const u = await newUser(h, db, 'seq');
    counting = true;
    statements.clear();
    total = 0;
    const times: number[] = [];
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 300; i += 1) times.push(await oneOrder(u, i));
    const seconds = ms(t0) / 1000;
    counting = false;
    report('(a) sequential, one account', times, seconds, 300);
    const v = await reconcileAccount(db.app, u.accountId);
    process.stdout.write(`  reconcile violations=${String(v.length)}\n`);
  }, 300_000);

  it('(b) 20 accounts in parallel, 25 sequential orders each (500 orders)', async () => {
    const users = await Promise.all(Array.from({ length: 20 }, () => newUser(h, db, 'par')));
    counting = true;
    statements.clear();
    total = 0;
    const times: number[] = [];
    const t0 = process.hrtime.bigint();
    await Promise.all(
      users.map(async (u) => {
        for (let i = 0; i < 25; i += 1) times.push(await oneOrder(u, i));
      }),
    );
    const seconds = ms(t0) / 1000;
    counting = false;
    report('(b) 20 accounts in parallel', times, seconds, 500);
    let violations = 0;
    for (const u of users) violations += (await reconcileAccount(db.app, u.accountId)).length;
    process.stdout.write(`  reconcile violations=${String(violations)}\n`);
  }, 300_000);
});
