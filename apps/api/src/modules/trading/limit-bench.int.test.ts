// M8b-1 T7 benchmarks (reported, not gates; only a very generous bound is asserted): the latency of accepting a resting limit
// order (p50/p95 over 1,000 accepts), a matcher tick that evaluates 1,000 open orders without a fill, and a tick that fills
// all 1,000 (one transaction per fill, D-95).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Quote } from '@vantage/market-model';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import {
  NOW,
  accept,
  createFundedAccount,
  limitCommand,
  seededCrypto,
} from '../../testing/trading-kit.js';
import type { TestInstrument } from '../../testing/trading-kit.js';
import type { Logger } from '../../log.js';
import { reconcileAccount } from '../ledger/reconcile.js';
import { runMatcherOnce } from './matcher.js';
import type { QuoteSource } from './matcher.js';

let db: TestDatabase;
let pool: pg.Pool;
let btc: TestInstrument;
beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 10 });
  btc = await seededCrypto(db, 'BTC-USD');
}, 120_000);
afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await db?.dispose();
});

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const quotes = (bid: string, ask: string): QuoteSource => ({
  snapshotFor: (i: { symbol: string }) =>
    Promise.resolve({
      freshness: 'REAL_TIME' as const,
      quote: {
        symbol: i.symbol,
        bid,
        ask,
        providerTs: new Date(NOW.getTime() - 1000),
        receivedAt: NOW,
        source: 'SIM',
        entitlement: 'REAL_TIME',
        delaySeconds: 0,
      } satisfies Quote,
    }),
});
const pct = (xs: number[], p: number): number =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;

describe('M8b-1 benchmarks', () => {
  it('limit accept p50/p95 over 1,000 resting orders; a tick over 1,000 open orders; a tick that fills 1,000', async () => {
    const accounts: string[] = [];
    for (let i = 0; i < 40; i++) accounts.push(await createFundedAccount(pool, '10000'));
    const ms: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const a = accounts[i % accounts.length] as string;
      const cmd = limitCommand(a, btc, { side: 'BUY', qty: '0.001', limitPrice: '80000.00' });
      const t0 = performance.now();
      const r = await accept(pool, cmd);
      ms.push(performance.now() - t0);
      expect(r.outcome).toBe('ACCEPTED');
    }
    const acceptP50 = pct(ms, 0.5);
    const acceptP95 = pct(ms, 0.95);

    let t = performance.now();
    const none = await runMatcherOnce(
      { pool, quotes: quotes('89990.00', '90010.00'), logger: quiet },
      NOW,
    );
    const tickNoFill = performance.now() - t;
    expect(none.filled).toBe(0);

    t = performance.now();
    const all = await runMatcherOnce(
      { pool, quotes: quotes('79900.00', '79950.00'), logger: quiet },
      NOW,
    );
    const tickFill = performance.now() - t;
    expect(all.filled).toBe(1000);

    process.stdout.write(
      `M8B1_BENCH ${JSON.stringify({
        acceptP50Ms: +acceptP50.toFixed(1),
        acceptP95Ms: +acceptP95.toFixed(1),
        tick1000NoFillMs: +tickNoFill.toFixed(1),
        tick1000AllFillMs: +tickFill.toFixed(1),
        perFillMs: +(tickFill / 1000).toFixed(2),
      })}\n`,
    );
    expect(acceptP95).toBeLessThan(2000);
    expect(tickNoFill).toBeLessThan(10_000);
    for (const a of accounts) expect(await reconcileAccount(db.migrator, a)).toEqual([]);
  }, 600_000);
});
