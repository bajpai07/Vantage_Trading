// M8b-2 benchmark (not a gate): buildDepth for 25 levels cold and warm, and GET /v1/market/depth p50/p95 with the cache cold
// (a new quote each request) and warm (the same quote). Prints one M8B2_BENCH line; asserts only generous bounds.
import { buildDepth } from '@vantage/engine';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from '../../testing/harness.js';
import { createOrdersHarness, setQuote } from '../../testing/orders-kit.js';

let db: TestDatabase;
let h: Harness;
beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db, { env: { DEPTH_RATE_LIMIT_PER_MINUTE: '100000' } });
}, 120_000);
afterAll(async () => {
  await h?.close();
  await db?.dispose();
});

const ms = (t0: bigint): number => Number(process.hrtime.bigint() - t0) / 1e6;
const pct = (xs: number[], p: number): number =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))
  ] as number;

describe('M8b-2 benchmark', () => {
  it('buildDepth(25) and the depth route, cold and warm', async () => {
    const inst = {
      symbol: 'BTC-USD',
      assetClass: 'CRYPTO' as const,
      tickSize: '0.01',
      qtyStep: '0.00000001',
      minQty: '0.00000001',
    };
    const t0 = process.hrtime.bigint();
    buildDepth({ bid: '89990.00', ask: '90010.00' }, inst, 'seed', 25, 1);
    const cold = ms(t0);
    const warm: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      const t = process.hrtime.bigint();
      buildDepth({ bid: '89990.00', ask: '90010.00' }, inst, 'seed', 25, 2 + i);
      warm.push(ms(t));
    }
    const coldHttp: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      await setQuote(h, 'BTC-USD', `${String(80000 + i)}.00`, `${String(80010 + i)}.00`);
      const t = process.hrtime.bigint();
      const r = await h.http.get('/v1/market/depth?symbol=BTC-USD&levels=25');
      coldHttp.push(ms(t));
      expect(r.status).toBe(200);
    }
    await setQuote(h, 'BTC-USD', '89990.00', '90010.00');
    await h.http.get('/v1/market/depth?symbol=BTC-USD&levels=25');
    const warmHttp: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t = process.hrtime.bigint();
      const r = await h.http.get('/v1/market/depth?symbol=BTC-USD&levels=25');
      warmHttp.push(ms(t));
      expect(r.status).toBe(200);
    }
    const f = (x: number): string => x.toFixed(3);
    process.stdout.write(
      `M8B2_BENCH buildDepth25 cold ${f(cold)} ms, warm p50 ${f(pct(warm, 50))} p95 ${f(pct(warm, 95))} ms; ` +
        `GET depth cache-cold p50 ${f(pct(coldHttp, 50))} p95 ${f(pct(coldHttp, 95))} ms, ` +
        `cache-warm p50 ${f(pct(warmHttp, 50))} p95 ${f(pct(warmHttp, 95))} ms\n`,
    );
    expect(pct(warm, 95)).toBeLessThan(50);
    expect(pct(coldHttp, 95)).toBeLessThan(1000);
  }, 120_000);
});
