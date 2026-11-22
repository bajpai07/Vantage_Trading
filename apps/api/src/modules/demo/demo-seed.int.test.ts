// demo:seed (M10, D-114): runs the real script as a child process against the real API (real Postgres) on a loopback port and checks
// the exact result: five orders (three filled, two resting), the reserved amount equals the server's reservedUsd string, a re-run with
// the same run id places nothing new, the ledger reconciles, and the password is neither accepted from the command line nor printed.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileAccount } from '../ledger/reconcile.js';
import { VALID_PASSWORD, WEB_ORIGIN } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import { counts, createOrdersHarness, getAs, newUser, setQuote } from '../../testing/orders-kit.js';

const script = resolve(
  fileURLToPath(new URL('../../../../../tools/', import.meta.url)),
  'demo-seed.mjs',
);
let db: TestDatabase;
let h: Harness;
let base = '';

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db);
  await h.app.listen(0, '127.0.0.1');
  const addr = h.app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${String(addr.port)}`;
  await setQuote(h, 'AAPL', '200.00', '200.10');
  await setQuote(h, 'BTC-USD', '90000.00', '90010.00');
}, 120_000);
afterAll(async () => {
  await h?.close();
  await db?.dispose();
});

interface Run {
  readonly code: number | null;
  readonly out: string;
}
function seed(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        PATH: process.env.PATH,
        DEMO_SEED_BASE_URL: base,
        DEMO_SEED_ORIGIN: WEB_ORIGIN,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('close', (code) => done({ code, out }));
  });
}

describe('pnpm demo:seed', () => {
  it('refuses to run without the password variable and does not read it from an argument', async () => {
    const u = await newUser(h, db, 'seedA');
    const none = await seed([u.email], {});
    expect(none.code).toBe(64);
    expect(none.out).toContain('DEMO_SEED_PASSWORD');
    const asArg = await seed([u.email, VALID_PASSWORD], {});
    expect(asArg.code).toBe(64);
    expect(asArg.out).not.toContain(VALID_PASSWORD);
    expect(await counts(db, u.accountId)).toMatchObject({ orders: 0 });
  });

  it('a wrong password places nothing and prints no password', async () => {
    const u = await newUser(h, db, 'seedB');
    const r = await seed([u.email, '--run', 'wrongpw1'], {
      DEMO_SEED_PASSWORD: 'not the password',
    });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('not the password');
    expect(await counts(db, u.accountId)).toMatchObject({ orders: 0 });
  });

  it('places exactly five orders through the API, three filled and two resting, and reconciles', async () => {
    const u = await newUser(h, db, 'seedC');
    const run = await seed([u.email, '--run', 'testrun1'], { DEMO_SEED_PASSWORD: VALID_PASSWORD });
    expect(run.code).toBe(0);
    expect(run.out).not.toContain(VALID_PASSWORD);

    const orders = await db.migrator.query<{
      symbol: string;
      side: string;
      type: string;
      status: string;
    }>(
      `SELECT i.symbol, o.side, o.type, o.status FROM orders o JOIN instruments i ON i.id = o.instrument_id
        WHERE o.account_id = $1::uuid ORDER BY o.created_at, o.id`,
      [u.accountId],
    );
    expect(orders.rows).toEqual([
      { symbol: 'AAPL', side: 'BUY', type: 'MARKET', status: 'FILLED' },
      { symbol: 'BTC-USD', side: 'BUY', type: 'MARKET', status: 'FILLED' },
      { symbol: 'AAPL', side: 'SELL', type: 'MARKET', status: 'FILLED' },
      { symbol: 'BTC-USD', side: 'BUY', type: 'LIMIT', status: 'ACCEPTED' },
      { symbol: 'AAPL', side: 'SELL', type: 'LIMIT', status: 'ACCEPTED' },
    ]);
    expect(await counts(db, u.accountId)).toMatchObject({ orders: 5, executions: 3 });

    // the reserved amount is the server's own string: the resting BUY's reservedUsd is exactly the portfolio's reservedUsd
    // (the resting SELL reserves shares, not cash)
    const p = await getAs(h, u, '/v1/portfolio');
    const list = await getAs(h, u, '/v1/orders');
    expect(list.status).toBe(200);
    const resting = (list.body.orders as Array<Record<string, string>>).filter(
      (o) => o.status === 'ACCEPTED',
    );
    expect(resting).toHaveLength(2);
    const buy = resting.find((o) => o.side === 'BUY');
    expect(buy?.reservedUsd).toBe(p.body.exact.reservedUsd);
    expect(Number(buy?.reservedUsd)).toBeGreaterThan(0);

    expect(await reconcileAccount(db.migrator, u.accountId)).toEqual([]);
  });

  it('a re-run with the same run id replays the same orders and places nothing new', async () => {
    const u = await newUser(h, db, 'seedD');
    const env = { DEMO_SEED_PASSWORD: VALID_PASSWORD };
    expect((await seed([u.email, '--run', 'rerun001'], env)).code).toBe(0);
    const before = await counts(db, u.accountId);
    expect((await seed([u.email, '--run', 'rerun001'], env)).code).toBe(0);
    expect(await counts(db, u.accountId)).toEqual(before);
    expect(before.orders).toBe(5);
    expect(await reconcileAccount(db.migrator, u.accountId)).toEqual([]);
  });
});
