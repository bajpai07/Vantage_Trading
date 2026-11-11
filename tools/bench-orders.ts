// Order execution benchmark (NOT a CI gate): 1,000 sequential market orders (BUY 1, SELL 1, ...), each in its own
// transaction, against a throwaway test database. Prints p50/p95/p99 latency and orders per second.
// Usage: pnpm bench:orders   (needs .env.infra and a running database)
import { createTestDatabase } from '../packages/test-utils/src/index.ts';
import {
  command,
  createFundedAccount,
  createInstrument,
  run,
} from '../apps/api/src/testing/trading-kit.ts';
import { reconcileAccount } from '../apps/api/src/modules/ledger/reconcile.ts';

const ORDERS = 1000;

const db = await createTestDatabase();
try {
  const inst = await createInstrument(db, 'BENCH');
  const acct = await createFundedAccount(db.app, '1000000');
  const times: number[] = [];
  let fills = 0;
  const started = process.hrtime.bigint();
  for (let i = 0; i < ORDERS; i += 1) {
    const buy = i % 2 === 0;
    const cmd = command(acct, inst, {
      clientOrderId: `bench-${String(i)}`,
      side: buy ? 'BUY' : 'SELL',
      qty: '1',
      bid: buy ? '99.98' : '99.00',
      ask: buy ? '100.00' : '99.05',
      now: new Date(Date.UTC(2026, 10, 10, 15, 0, 0) + i * 1000),
    });
    const t0 = process.hrtime.bigint();
    const r = await run(db.app, cmd);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (r.outcome === 'FILLED') fills += 1;
  }
  const totalSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  times.sort((a, b) => a - b);
  const pct = (p: number): number =>
    times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] ?? 0;
  const f = (x: number): string => x.toFixed(1);
  const violations = await reconcileAccount(db.app, acct, { trading: true });
  process.stdout.write(
    [
      `bench:orders  orders=${String(ORDERS)} fills=${String(fills)} (sequential, one transaction each)`,
      `  p50=${f(pct(50))} ms   p95=${f(pct(95))} ms   p99=${f(pct(99))} ms   max=${f(times[times.length - 1] ?? 0)} ms`,
      `  throughput=${f(ORDERS / totalSeconds)} orders/s   reconcile violations=${String(violations.length)}`,
      `  targets (TRADING_ENGINE 13): accept p95 < 150 ms -> ${pct(95) < 150 ? 'MET' : 'NOT MET'}; sustained >= 200 fills/s -> ${ORDERS / totalSeconds >= 200 ? 'MET' : 'NOT MET'} (single connection, sequential, Windows + Docker Desktop)`,
    ].join('\n') + '\n',
  );
} finally {
  await db.dispose();
}
