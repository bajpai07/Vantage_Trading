// (3) The portfolio equals the ledger and the lots after random order sequences (the independent M4a BigInt reference
// model, shared via testing/reference-model.ts) and (4) every read is internally consistent while orders are being
// placed concurrently (one REPEATABLE READ snapshot, D-63). Real Postgres, real HTTP, orders through the M4b API.
import fc from 'fast-check';
import pg from 'pg';
import { parse } from '@vantage/money';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from '../../testing/harness.js';
import {
  BUY_AAPL,
  createOrdersHarness,
  getAs,
  newKey,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import { Model, UNIT, fmt, opArb, priceStr } from '../../testing/reference-model.js';
import type { Op } from '../../testing/reference-model.js';
import { createInstrument } from '../../testing/trading-kit.js';
import { reconcileAccount } from '../ledger/reconcile.js';

let db: TestDatabase;
let h: Harness;
const SYMBOLS = ['AAA', 'BBB', 'CCC'] as const;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createOrdersHarness(db);
  for (const s of SYMBOLS) await createInstrument(db, s);
  await setQuote(h, 'AAPL', '99.98', '100.00');
  // fee schedule v2: 10 bps commission, effective before the test clock, so every fill pays a real fee
  await db.migrator.query(
    `INSERT INTO fee_schedules (id, asset_class, exchange_id, version, effective_from, commission_bps,
                                commission_min_local, slippage_base_bps, slippage_size_coef, model_version)
     VALUES (gen_random_uuid(), 'EQUITY', NULL, 2, '2026-01-02T00:00:00Z', 10, 0, 2, 0, 'QBX-1/r8he')`,
  );
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const canon = (units: bigint): string => parse(fmt(units)).toCanonicalString();
const dec = (s: unknown): string => parse(String(s)).toString();

/** cash + costBasis + fees - realisedPnl, from the exact (unrounded) fields of one portfolio response. */
function identity(p: {
  exact: { cash: string; costBasis: string; fees: string; realisedPnl: string };
}): string {
  return parse(p.exact.cash)
    .add(parse(p.exact.costBasis))
    .add(parse(p.exact.fees))
    .sub(parse(p.exact.realisedPnl))
    .toString();
}

describe('3. portfolio numbers equal the ledger, the lots and the reference model after random sequences', () => {
  it('15 random sequences of up to 12 orders (10 bps commission): cash, fees, cost basis, realised P&L, positions and equity match', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops: Op[]) => {
        const u = await newUser(h, db, 'rand');
        const model = new Model();
        const lastBid: bigint[] = [100n, 100n, 100n];
        let n = 0;
        for (const op of ops) {
          n += 1;
          const op10 = { ...op, bps: 10 as const }; // the live schedule is 10 bps
          const bidC = BigInt(op10.bidC);
          const askC = bidC + BigInt(op10.spreadC);
          const refC =
            op10.side === 'BUY'
              ? op10.refMode === 'exact'
                ? askC
                : (askC * 100n) / 103n
              : op10.refMode === 'exact'
                ? bidC
                : (bidC * 103n) / 100n + 1n;
          const symbol = SYMBOLS[op10.inst] as string;
          await setQuote(h, symbol, priceStr(bidC), priceStr(askC));
          lastBid[op10.inst] = bidC;
          const expected = model.apply(op10);
          const res = await placeOrder(h, u, `rand-${String(n)}-${newKey()}`, {
            symbol,
            side: op10.side,
            type: 'MARKET',
            qty: String(op10.qty),
            referencePrice: priceStr(refC),
          });
          expect(res.status, JSON.stringify(op10)).toBe(201);
          expect(
            res.body.status === 'FILLED' ? 'FILLED' : res.body.rejectCode,
            JSON.stringify(op10),
          ).toBe(expected);
        }
        // marks: every instrument is quoted at its last bid (fresh, delayed)
        for (const [i, s] of SYMBOLS.entries()) {
          await setQuote(
            h,
            s,
            priceStr(lastBid[i] as bigint),
            priceStr((lastBid[i] as bigint) + 1n),
          );
        }
        const p = (await getAs(h, u, '/v1/portfolio')).body;

        // the model
        let value = 0n;
        for (const [i] of SYMBOLS.entries())
          value += model.shares(i) * (lastBid[i] as bigint) * 1_000_000n;
        expect(p.exact.cash).toBe(canon(model.cash));
        expect(p.exact.fees).toBe(canon(model.fees));
        expect(p.exact.costBasis).toBe(canon(model.positionCost()));
        expect(p.exact.realisedPnl).toBe(canon(model.realised));
        expect(p.exact.positionsValue).toBe(canon(value));
        expect(p.exact.equity).toBe(canon(model.cash + value));
        expect(p.incomplete).toBe(false);
        expect(p.totalReturn).not.toBeNull();
        expect(p.exact.totalReturn).toBe(canon(model.cash + value - 10_000n * UNIT));
        // positions: quantity per instrument and per-position cost basis
        for (const [i, s] of SYMBOLS.entries()) {
          const row = p.positions.find((x: { symbol: string }) => x.symbol === s);
          if (model.shares(i) === 0n) expect(row, s).toBeUndefined();
          else {
            expect(row.qty).toBe(model.shares(i).toString());
            const cost = (model.lots[i] ?? []).reduce(
              (a, l) => a + l.qty * l.costC * 1_000_000n,
              0n,
            );
            expect(row.exact.costBasis).toBe(canon(cost));
          }
        }

        // the ledger and the lots (independent of the portfolio code): same numbers
        const led = Object.fromEntries(
          (
            await db.migrator.query(
              `SELECT type::text AS t, balance FROM ledger_accounts WHERE account_id = $1::uuid AND currency = 'USD'`,
              [u.accountId],
            )
          ).rows.map((r) => [r.t, r.balance]),
        );
        expect(dec(led.CASH)).toBe(dec(p.exact.cash));
        expect(dec(led.FEES)).toBe(dec(p.exact.fees));
        expect(dec(led.POSITION_COST)).toBe(dec(p.exact.costBasis));
        expect(parse(String(led.REALIZED_PNL)).negate().toString()).toBe(dec(p.exact.realisedPnl));
        const closures = await db.migrator.query(
          `SELECT COALESCE(sum(c.trading_pnl_usd), 0) AS pnl
             FROM lot_closures c JOIN position_lots l ON l.id = c.lot_id WHERE l.account_id = $1::uuid`,
          [u.accountId],
        );
        expect(dec(closures.rows[0]?.pnl)).toBe(dec(p.exact.realisedPnl));
        const lots = await db.migrator.query(
          `SELECT COALESCE(sum(qty_open * cost_local_per_unit), 0) AS cost FROM position_lots WHERE account_id = $1::uuid`,
          [u.accountId],
        );
        expect(dec(lots.rows[0]?.cost)).toBe(dec(p.exact.costBasis));
        expect(identity(p)).toBe('10000');
        expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);

        // the executions endpoint: the sum of the SELL realised P&L equals the portfolio's realised P&L
        const ex = (await getAs(h, u, '/v1/executions?limit=100')).body.executions as Array<{
          exact: { realisedPnl: string | null };
        }>;
        const sum = ex.reduce(
          (a, e) => (e.exact.realisedPnl === null ? a : a.add(parse(e.exact.realisedPnl))),
          parse('0'),
        );
        expect(sum.toString()).toBe(dec(p.exact.realisedPnl));
      }),
      { numRuns: 15 },
    );
  }, 600_000);

  it('the cross-check can fail (control): a tampered figure is detected by the same identity', async () => {
    const u = await newUser(h, db, 'ctrl');
    await placeOrder(h, u, newKey(), BUY_AAPL);
    const p = (await getAs(h, u, '/v1/portfolio')).body;
    expect(identity(p)).toBe('10000');
    const tampered = {
      exact: { ...p.exact, cash: parse(p.exact.cash).add(parse('0.01')).toString() },
    };
    expect(identity(tampered)).not.toBe('10000');
  });
});

describe('4. consistency: reads while orders are placed concurrently (D-63)', () => {
  it('the whole portfolio is read inside ONE REPEATABLE READ, read-only transaction (control: the statements are observed)', async () => {
    const u = await newUser(h, db, 'tx');
    const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
    const original = proto.query;
    const seen: string[] = [];
    proto.query = function (this: unknown, ...args: unknown[]): unknown {
      const a = args[0];
      seen.push(
        (typeof a === 'string' ? a : String((a as { text?: unknown }).text))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60),
      );
      return original.apply(this, args);
    };
    try {
      expect((await getAs(h, u, '/v1/portfolio')).status).toBe(200);
    } finally {
      proto.query = original;
    }
    const begin = seen.findIndex((s) =>
      s.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
    );
    const commit = seen.findIndex((s) => s === 'COMMIT');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    const inside = seen.slice(begin + 1, commit);
    expect(inside.length).toBeGreaterThanOrEqual(2); // the balances and the positions
    expect(inside.every((s) => s.startsWith('SELECT'))).toBe(true);
  });

  it('100 portfolio reads while 60 orders are placed in parallel: every response satisfies cash + costBasis + fees - realisedPnl = 10,000 and adds up internally', async () => {
    await setQuote(h, 'AAPL', '99.98', '100.00');
    const u = await newUser(h, db, 'conc');
    // seed a position so sells are possible, then a mixed parallel load of buys and sells
    for (let i = 0; i < 3; i += 1)
      await placeOrder(h, u, newKey(), { ...BUY_AAPL, qty: '5', referencePrice: '100.00' });
    const orders = Array.from({ length: 60 }, (_, i) =>
      placeOrder(
        h,
        u,
        newKey(),
        i % 3 === 2
          ? { ...BUY_AAPL, side: 'SELL', qty: '2', referencePrice: '99.98' }
          : { ...BUY_AAPL, qty: '3', referencePrice: '100.00' },
      ),
    );
    const distinctCash = new Set<string>();
    let consistent = 0;
    const reader = (async () => {
      for (let i = 0; i < 100; i += 1) {
        const res = await getAs(h, u, '/v1/portfolio');
        expect(res.status).toBe(200);
        const p = res.body;
        expect(identity(p), `read ${String(i)}`).toBe('10000');
        // internal consistency of the same response
        const sumCost = p.positions.reduce(
          (a: ReturnType<typeof parse>, x: { exact: { costBasis: string } }) =>
            a.add(parse(x.exact.costBasis)),
          parse('0'),
        );
        expect(sumCost.toString()).toBe(dec(p.exact.costBasis));
        const sumValue = p.positions.reduce(
          (a: ReturnType<typeof parse>, x: { exact: { marketValue: string | null } }) =>
            a.add(parse(x.exact.marketValue ?? '0')),
          parse('0'),
        );
        expect(sumValue.toString()).toBe(dec(p.exact.positionsValue));
        expect(parse(p.exact.cash).add(parse(p.exact.positionsValue)).toString()).toBe(
          dec(p.exact.equity),
        );
        expect(p.incomplete).toBe(false);
        distinctCash.add(String(p.exact.cash));
        consistent += 1;
      }
    })();
    const [results] = await Promise.all([Promise.all(orders), reader]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(consistent).toBe(100); // 100 of 100
    expect(distinctCash.size).toBeGreaterThanOrEqual(5); // the reads really overlapped the orders
    expect(await reconcileAccount(db.app, u.accountId)).toEqual([]);
    expect(identity((await getAs(h, u, '/v1/portfolio')).body)).toBe('10000');
  }, 300_000);
});
