// Read-side performance (NOT a CI gate: runs only when VANTAGE_BENCH=1, via `pnpm bench:portfolio`).
// One account with 200 open positions and 5,000 executions; p50/p95 of GET /v1/portfolio, /v1/executions and
// /v1/ledger/activity over real HTTP, and the number of database round trips per request (to show there is no N+1).
import pg from 'pg';
import { createTestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Harness } from '../../testing/harness.js';
import { createOrdersHarness, getAs, newUser, setQuote } from '../../testing/orders-kit.js';
import type { TestUser } from '../../testing/orders-kit.js';
import { command, createInstrument, run } from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';

const enabled = process.env.VANTAGE_BENCH === '1';
const POSITIONS = 200;
const EXECUTIONS = 5000;

type QueryFn = (...args: unknown[]) => unknown;
const proto = pg.Client.prototype as unknown as { query: QueryFn };
const originalQuery = proto.query;
let counting = false;
let queries = 0;
function startCounting(): void {
  proto.query = function (this: unknown, ...args: unknown[]): unknown {
    if (counting) queries += 1;
    return originalQuery.apply(this, args);
  };
}

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const f = (x: number): string => x.toFixed(1);

describe.runIf(enabled)('portfolio read benchmark', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let h: Harness;
  let u: TestUser;
  const symbols: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    h = await createOrdersHarness(db);
    startCounting();
    u = await newUser(h, db, 'bench');
    const insts: TestInstrument[] = [];
    for (let i = 0; i < POSITIONS; i += 1) {
      const s = `B${String(i).padStart(3, '0')}`;
      symbols.push(s);
      insts.push(await createInstrument(db, s));
    }
    // seed through the real execution core: 200 BUYs of 5 shares, then buy/sell pairs of 1 share until 5,000 fills
    let n = 0;
    let fills = 0;
    const place = async (i: number, side: 'BUY' | 'SELL', qty: string): Promise<void> => {
      n += 1;
      const r = await run(
        db.app,
        command(u.accountId, insts[i] as TestInstrument, {
          clientOrderId: `seed-${String(n)}`,
          side,
          qty,
          bid: '1.00',
          ask: '1.01',
          referencePrice: side === 'BUY' ? '1.01' : '1.00',
          now: new Date(Date.UTC(2026, 10, 10, 15, 0, 0) + n * 1000),
        }),
      );
      if (r.outcome !== 'FILLED') throw new Error(`seed order ${String(n)} was ${r.outcome}`);
      fills += 1;
    };
    for (let i = 0; i < POSITIONS; i += 1) await place(i, 'BUY', '5');
    // then whole rounds over all 200 instruments, alternating SELL 1 and BUY 1: every position stays open (4 or 5 shares)
    for (let round = 0; fills < EXECUTIONS; round += 1) {
      for (let i = 0; i < POSITIONS && fills < EXECUTIONS; i += 1) {
        await place(i, round % 2 === 0 ? 'SELL' : 'BUY', '1');
      }
    }
    for (const s of symbols) await setQuote(h, s, '1.00', '1.01');
  }, 1_800_000);

  afterAll(async () => {
    proto.query = originalQuery;
    await h.close();
    await db.dispose();
  });

  async function measure(title: string, path: string, runs: number): Promise<void> {
    const times: number[] = [];
    counting = true;
    queries = 0;
    for (let i = 0; i < runs; i += 1) {
      const t0 = process.hrtime.bigint();
      const res = await getAs(h, u, path);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (res.status !== 200) throw new Error(`${title}: ${String(res.status)}`);
    }
    counting = false;
    times.sort((a, b) => a - b);
    process.stdout.write(
      `bench:portfolio ${title}  runs=${String(runs)}  p50=${f(pct(times, 50))} ms  p95=${f(pct(times, 95))} ms  max=${f(times[times.length - 1] ?? 0)} ms  DB round trips per request=${(queries / runs).toFixed(1)}\n`,
    );
  }

  it('seeded: 200 positions, 5,000 executions; measures the read endpoints', async () => {
    const counts = await db.migrator.query(
      `SELECT (SELECT count(*) FROM executions WHERE account_id = $1::uuid)::int AS ex,
              (SELECT count(*) FROM positions WHERE account_id = $1::uuid AND qty > 0)::int AS pos`,
      [u.accountId],
    );
    process.stdout.write(
      `bench:portfolio seeded executions=${String(counts.rows[0]?.ex)} open positions=${String(counts.rows[0]?.pos)}\n`,
    );
    await measure('GET /v1/portfolio (200 positions)', '/v1/portfolio', 30);
    await measure('GET /v1/executions?limit=100 (first page)', '/v1/executions?limit=100', 30);
    await measure(
      'GET /v1/ledger/activity?limit=100 (first page)',
      '/v1/ledger/activity?limit=100',
      30,
    );

    // deep pagination: walk all executions 100 at a time
    counting = true;
    queries = 0;
    let cursor: string | null = null;
    let pages = 0;
    const times: number[] = [];
    do {
      const q: string = cursor === null ? '?limit=100' : `?limit=100&cursor=${cursor}`;
      const t0 = process.hrtime.bigint();
      const res = await getAs(h, u, `/v1/executions${q}`);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      cursor = res.body.nextCursor as string | null;
      pages += 1;
    } while (cursor !== null);
    counting = false;
    times.sort((a, b) => a - b);
    process.stdout.write(
      `bench:portfolio walk all executions: pages=${String(pages)}  p50=${f(pct(times, 50))} ms  p95=${f(pct(times, 95))} ms  max=${f(times[times.length - 1] ?? 0)} ms  DB round trips per page=${(queries / pages).toFixed(1)}\n`,
    );
  }, 900_000);
});
