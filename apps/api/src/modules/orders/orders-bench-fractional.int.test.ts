// M8 benchmark (NOT a gate: it only runs when VANTAGE_BENCH=1): 1,000 sequential fractional crypto orders over real HTTP on
// one account. Prints p50/p95/p99, throughput and the database round trips per order (every pg.Client.query is one).
//   VANTAGE_BENCH=1 npx vitest run --project integration apps/api/src/modules/orders/orders-bench-fractional.int.test.ts
import pg from 'pg';
import { createTestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from '../../testing/harness.js';
import {
  createOrdersHarness,
  newKey,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';

const enabled = process.env.VANTAGE_BENCH === '1';

type QueryFn = (...args: unknown[]) => unknown;
const proto = pg.Client.prototype as unknown as { query: QueryFn };
const originalQuery = proto.query;
let counting = false;
const statements = new Map<string, number>();
let total = 0;

const sqlOf = (arg: unknown): string => {
  const text =
    typeof arg === 'string'
      ? arg
      : typeof arg === 'object' && arg !== null && 'text' in arg
        ? String((arg as { text: unknown }).text)
        : '?';
  return text.replace(/\s+/g, ' ').trim().slice(0, 70);
};

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const f = (x: number): string => x.toFixed(1);
const ms = (t0: bigint): number => Number(process.hrtime.bigint() - t0) / 1e6;

describe.runIf(enabled)('fractional crypto order benchmark (HTTP, one account, sequential)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let h: Harness;
  beforeAll(async () => {
    db = await createTestDatabase();
    h = await createOrdersHarness(db);
    await setQuote(h, 'BTC-USD', '89990.00', '90010.00');
    proto.query = function (this: unknown, ...args: unknown[]): unknown {
      if (counting) {
        total += 1;
        const k = sqlOf(args[0]);
        statements.set(k, (statements.get(k) ?? 0) + 1);
      }
      return originalQuery.apply(this, args);
    };
  });
  afterAll(async () => {
    proto.query = originalQuery;
    await h.close();
    await db.dispose();
  });

  it('1,000 sequential fractional BUY/SELL market orders on BTC-USD', async () => {
    const u = await newUser(h, db, 'bench');
    const N = 1000;
    const times: number[] = [];
    counting = true;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i += 1) {
      const buy = i % 2 === 0;
      // varying fractional sizes: 0.00100001 .. 0.00109999 (a BUY is followed by a SELL of the same size)
      const size = `0.001${String(1 + ((i >> 1) % 99)).padStart(5, '0')}`;
      const body = {
        symbol: 'BTC-USD',
        side: buy ? 'BUY' : 'SELL',
        type: 'MARKET',
        qty: size,
        referencePrice: buy ? '90010.00' : '89990.00',
      };
      const s = process.hrtime.bigint();
      const res = await placeOrder(h, u, newKey(), body);
      times.push(ms(s));
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('FILLED');
    }
    const seconds = ms(t0) / 1000;
    counting = false;
    const sorted = [...times].sort((a, b) => a - b);
    process.stdout.write(
      [
        `bench:fractional orders=${String(N)} (sequential, one account, real HTTP and Postgres)`,
        `  p50=${f(pct(sorted, 50))} ms  p95=${f(pct(sorted, 95))} ms  p99=${f(pct(sorted, 99))} ms  max=${f(sorted[sorted.length - 1] ?? 0)} ms`,
        `  throughput=${f(N / seconds)} orders/s  DB round trips per order=${(total / N).toFixed(1)}`,
        '  statements per order:',
        ...[...statements.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `    ${(n / N).toFixed(2).padStart(6)}  ${k}`),
        '',
      ].join('\n'),
    );
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
  }, 600_000);
});
