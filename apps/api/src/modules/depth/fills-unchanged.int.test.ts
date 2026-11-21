// M8b-2 T2/T4 (acceptance 7, D-98): the depth book is informational, so fills, reservations, ledger postings and the matcher are
// BYTE-IDENTICAL with and without it. One fixed scenario (a market BUY, a resting limit BUY filled by the matcher, a resting limit
// BUY that is cancelled, a resting limit SELL filled by the matcher, a market SELL) is run twice on two fresh databases:
//   OFF: the depth module is replaced by an empty one (its routes do not exist: 404);
//   ON:  the depth module is present and its routes (public book and my-orders) are queried continuously, in parallel with
//        every step of the scenario.
// Everything observable that the scenario writes is read back (ledger entries in order, balances, orders, order events,
// executions, lots, positions) with the random identifiers normalised, and the two snapshots must be the same bytes.
// Control: a scenario that differs by one share quantity gives a different snapshot, so the comparison can fail.
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, describe, expect, it } from 'vitest';
import { cookie } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import {
  createOrdersHarness,
  getAs,
  newUser,
  placeOrder,
  setQuote,
} from '../../testing/orders-kit.js';
import { MatcherService } from '../trading/matcher.service.js';
import { DepthModule } from './depth.module.js';
import { DepthService } from './depth.service.js';

const opened: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of opened.reverse()) await close();
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const scrub = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(UUID, '<id>'));

async function snapshot(db: TestDatabase, accountId: string): Promise<string> {
  const q = async (sql: string): Promise<unknown[]> =>
    (await db.migrator.query(sql, [accountId])).rows;
  const snap = {
    ledger: await q(
      `SELECT t.kind::text AS kind, la.type::text AS account, e.currency, e.amount::text AS amount, e.amount_usd::text AS usd
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
         JOIN ledger_accounts la ON la.id = e.ledger_account_id
        WHERE t.account_id = $1::uuid
        ORDER BY (SELECT min(e2.id) FROM ledger_entries e2 WHERE e2.transaction_id = t.id), la.type::text, e.amount`,
    ),
    balances: await q(
      `SELECT type::text AS type, currency, balance::text AS balance FROM ledger_accounts
        WHERE account_id = $1::uuid ORDER BY type, currency`,
    ),
    orders: await q(
      `SELECT i.symbol, o.side::text AS side, o.type::text AS type, o.tif::text AS tif, o.status::text AS status,
              o.qty::text AS qty, o.filled_qty::text AS filled, o.limit_price::text AS limit_price,
              o.reserved_usd::text AS reserved, o.version, o.reject_code, o.expires_at
         FROM orders o JOIN instruments i ON i.id = o.instrument_id
        WHERE o.account_id = $1::uuid ORDER BY o.created_at, o.id`,
    ),
    events: await q(
      `SELECT ev.seq, ev.type, ev.payload FROM order_events ev JOIN orders o ON o.id = ev.order_id
        WHERE o.account_id = $1::uuid ORDER BY o.created_at, o.id, ev.seq`,
    ),
    executions: await q(
      `SELECT x.seq, x.side::text AS side, x.qty::text AS qty, x.price::text AS price, x.gross_usd::text AS gross,
              x.fee_local::text AS fee, x.slippage_bps::text AS slip, x.quote_bid::text AS bid, x.quote_ask::text AS ask,
              x.quote_ts, x.quote_source, x.model_version, x.executed_at
         FROM executions x JOIN orders o ON o.id = x.order_id
        WHERE x.account_id = $1::uuid ORDER BY o.created_at, o.id, x.seq`,
    ),
    lots: await q(
      `SELECT qty_initial::text AS q0, qty_open::text AS q, cost_remaining::text AS cost, cost_local_per_unit::text AS unit,
              opened_at, closed_at FROM position_lots WHERE account_id = $1::uuid ORDER BY opened_at, id`,
    ),
    positions: await q(
      `SELECT qty::text AS qty, qty_reserved::text AS reserved, avg_cost_local::text AS avg,
              realized_trading_pnl_usd::text AS realised, version FROM positions WHERE account_id = $1::uuid`,
    ),
  };
  return JSON.stringify(scrub(snap));
}

/** The fixed scenario. `sellQty` is the only knob (the control changes it). */
async function scenario(
  h: Harness,
  db: TestDatabase,
  during: () => Promise<void>,
  sellQty = '0.003',
): Promise<string> {
  const u = await newUser(h, db, 'fills');
  const quote = (bid: string, ask: string) => setQuote(h, 'BTC-USD', bid, ask);
  const matcher = h.app.get(MatcherService);
  const limit = (side: 'BUY' | 'SELL', qty: string, price: string) => ({
    symbol: 'BTC-USD',
    side,
    type: 'LIMIT',
    qty,
    limitPrice: price,
    tif: 'GTC',
  });
  const ok = (r: { status: number }, code: number) => expect(r.status).toBe(code);

  await quote('89990.00', '90010.00');
  await during();
  ok(
    await placeOrder(h, u, 'fixed-key-001', {
      symbol: 'BTC-USD',
      side: 'BUY',
      type: 'MARKET',
      qty: '0.01',
      referencePrice: '90010.00',
    }),
    201,
  );
  const rest = await placeOrder(h, u, 'fixed-key-002', limit('BUY', '0.0025', '89900.00'));
  ok(rest, 201);
  const far = await placeOrder(h, u, 'fixed-key-003', limit('BUY', '0.0025', '89000.00'));
  ok(far, 201);
  await during();
  const cancelled = await h.http
    .post(`/v1/orders/${String(far.body.id)}/cancel`)
    .set('Cookie', cookie(u.token))
    .set('Origin', 'http://localhost:3000')
    .set('Idempotency-Key', 'fixed-key-004')
    .send();
  ok(cancelled, 200);
  await quote('89700.00', '89800.00'); // the resting BUY (limit 89,900) is now marketable
  await during();
  await matcher.runOnce();
  ok(await placeOrder(h, u, 'fixed-key-005', limit('SELL', '0.004', '90500.00')), 201);
  await quote('90600.00', '90620.00'); // the resting SELL is marketable
  await during();
  await matcher.runOnce();
  ok(
    await placeOrder(h, u, 'fixed-key-006', {
      symbol: 'BTC-USD',
      side: 'SELL',
      type: 'MARKET',
      qty: sellQty,
      referencePrice: '90600.00',
    }),
    201,
  );
  await during();
  return snapshot(db, u.accountId);
}

async function fresh(withDepth: boolean): Promise<{ h: Harness; db: TestDatabase }> {
  const db = await createTestDatabase();
  const h = await createOrdersHarness(db, {
    env: { DEPTH_RATE_LIMIT_PER_MINUTE: '100000' },
    ...(withDepth ? {} : { withoutModules: [DepthModule] }),
  });
  opened.push(async () => {
    await h.close();
    await db.dispose();
  });
  return { h, db };
}

describe('M8b-2 acceptance 7: fills, ledger, reservations and the matcher are byte-identical with the book on and off', () => {
  it('the same scenario with the depth module absent and with it queried at every step gives the same bytes', async () => {
    const off = await fresh(false);
    expect((await off.h.http.get('/v1/market/depth?symbol=BTC-USD')).status).toBe(404); // not constructed
    const snapOff = await scenario(off.h, off.db, async () => undefined);

    const on = await fresh(true);
    expect(on.h.app.get(DepthService)).toBeDefined();
    let queries = 0;
    let lastBook = '';
    // a continuous poller runs in parallel with the whole scenario, and again synchronously between steps
    let stop = false;
    const user = await newUser(on.h, on.db, 'poller');
    const poll = (async () => {
      while (!stop) {
        const a = await on.h.http.get('/v1/market/depth?symbol=BTC-USD&levels=25');
        const b = await getAs(on.h, user, '/v1/market/depth/my-orders?symbol=BTC-USD');
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        lastBook = a.text;
        queries += 2;
      }
    })();
    const snapOn = await scenario(on.h, on.db, async () => {
      const r = await on.h.http.get('/v1/market/depth?symbol=BTC-USD&levels=15');
      expect(r.status).toBe(200);
      queries += 1;
    });
    stop = true;
    await poll;
    expect(queries).toBeGreaterThan(10);
    expect(lastBook).toContain('"simulated":true');

    expect(snapOn).toBe(snapOff);
    // the snapshot is real: it has the fills, the reservation release and the cancel
    const s = JSON.parse(snapOff) as {
      executions: unknown[];
      orders: Array<{ status: string }>;
      ledger: unknown[];
    };
    expect(s.executions).toHaveLength(4);
    expect(s.orders.map((o) => o.status)).toEqual([
      'FILLED',
      'FILLED',
      'CANCELLED',
      'FILLED',
      'FILLED',
    ]);
    expect(s.ledger.length).toBeGreaterThan(15);
  }, 300_000);

  it('control: a scenario that differs by one quantity gives a different snapshot (the comparison can fail)', async () => {
    const a = await fresh(false);
    const b = await fresh(false);
    const one = await scenario(a.h, a.db, async () => undefined, '0.003');
    const two = await scenario(b.h, b.db, async () => undefined, '0.0031');
    expect(two).not.toBe(one);
  }, 300_000);
});
