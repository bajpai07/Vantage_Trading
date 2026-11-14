import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POOL } from '../../tokens.js';
import {
  VALID_PASSWORD,
  WEB_ORIGIN,
  cookie,
  createHarness,
  registerUser,
} from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';

let db: TestDatabase;
let h: Harness;
let alice: string;
let bob: string;
const bodies: string[] = [];
const pool = (): pg.Pool => h.app.get<pg.Pool>(POOL);

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createHarness(db);
  alice = await registerUser(h, 'alice-wl@example.com');
  bob = await registerUser(h, 'bob-wl@example.com');
  // 120 synthetic instruments so a list can hold 100 distinct ones
  const exch = await db.migrator.query<{ id: string }>(
    `SELECT id FROM exchanges WHERE code = 'XNYS'`,
  );
  await db.migrator.query(
    `INSERT INTO instruments (id, symbol, name, asset_class, exchange_id, quote_currency, tick_size, qty_step, min_qty, attrs)
     SELECT gen_random_uuid(), 'SYN' || lpad(n::text, 3, '0'), 'Synthetic ' || n, 'EQUITY', $1::uuid, 'USD', 0.01, 1, 1,
            '{"source":"SYNTHETIC"}'::jsonb
       FROM generate_series(1, 120) AS n`,
    [exch.rows[0]?.id],
  );
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
async function call(
  method: Method,
  path: string,
  tok: string | null,
  body?: unknown,
  origin: string | null = WEB_ORIGIN,
) {
  let r = h.http[method](path);
  if (tok !== null) r = r.set('Cookie', cookie(tok));
  if (origin !== null && method !== 'get') r = r.set('Origin', origin);
  const res = await (body === undefined ? r : r.send(body as object));
  bodies.push(JSON.stringify(res.body));
  return res;
}
const userId = async (email: string): Promise<string> =>
  (await db.migrator.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]))
    .rows[0]?.id ?? '';

describe('6. watchlists: CRUD', () => {
  let listId: string;

  it('creates, lists, renames and orders lists (control: the first one works)', async () => {
    const created = await call('post', '/v1/watchlists', alice, { name: '  Tech  ' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), name: 'Tech', position: 0, items: [] });
    listId = created.body.id as string;
    const second = await call('post', '/v1/watchlists', alice, { name: 'Banks' });
    expect(second.body.position).toBe(1);

    const all = await call('get', '/v1/watchlists', alice, undefined);
    expect(all.body.watchlists.map((l: { name: string }) => l.name)).toEqual(['Tech', 'Banks']);

    const renamed = await call('patch', `/v1/watchlists/${listId}`, alice, {
      name: 'Big Tech',
      position: 5,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Big Tech', position: 5 });
    const order = await call('get', '/v1/watchlists', alice, undefined);
    expect(order.body.watchlists.map((l: { name: string }) => l.name)).toEqual([
      'Banks',
      'Big Tech',
    ]);
  });

  it('rejects bad names and an empty patch (control: a 40-character name works)', async () => {
    for (const name of ['', '   ', 'x'.repeat(41)]) {
      const res = await call('post', '/v1/watchlists', alice, { name });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await call('post', '/v1/watchlists', alice, { name: 'x'.repeat(40) })).status).toBe(
      201,
    );
    expect((await call('patch', `/v1/watchlists/${listId}`, alice, {})).status).toBe(400);
    expect((await call('post', '/v1/watchlists', alice, { name: 'a', extra: 1 })).status).toBe(400);
  });

  it('a duplicate name is 409, also after renaming (control: another name is fine)', async () => {
    const dup = await call('post', '/v1/watchlists', alice, { name: 'Banks' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('WATCHLIST_NAME_TAKEN');
    expect((await call('patch', `/v1/watchlists/${listId}`, alice, { name: 'Banks' })).status).toBe(
      409,
    );
    expect((await call('post', '/v1/watchlists', bob, { name: 'Banks' })).status).toBe(201); // other user: fine
  });

  it('adds instruments (case-insensitive), adding twice is an idempotent 200, unknown symbols are 404', async () => {
    const add1 = await call('post', `/v1/watchlists/${listId}/items`, alice, { symbol: 'aapl' });
    expect(add1.status).toBe(201);
    expect(add1.body.items).toEqual([{ symbol: 'AAPL', position: 0 }]);
    const again = await call('post', `/v1/watchlists/${listId}/items`, alice, { symbol: 'AAPL' });
    expect(again.status).toBe(200); // documented choice: idempotent no-op
    expect(again.body.items).toHaveLength(1);
    await call('post', `/v1/watchlists/${listId}/items`, alice, { symbol: 'MSFT' });
    await call('post', `/v1/watchlists/${listId}/items`, alice, { symbol: 'NVDA' });
    const unknown = await call('post', `/v1/watchlists/${listId}/items`, alice, { symbol: 'NOPE' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('INSTRUMENT_NOT_FOUND');
    expect(
      (await call('post', `/v1/watchlists/${listId}/items`, alice, { symbol: 'bad symbol' }))
        .status,
    ).toBe(400);
    const rows = await db.migrator.query(
      `SELECT 1 FROM watchlist_items WHERE watchlist_id = $1::uuid`,
      [listId],
    );
    expect(rows.rowCount).toBe(3);
  });

  it('reorders items: the new order must list exactly the current symbols', async () => {
    const ok = await call('put', `/v1/watchlists/${listId}/items/order`, alice, {
      symbols: ['nvda', 'AAPL', 'MSFT'],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.items).toEqual([
      { symbol: 'NVDA', position: 1 },
      { symbol: 'AAPL', position: 2 },
      { symbol: 'MSFT', position: 3 },
    ]);
    const missing = await call('put', `/v1/watchlists/${listId}/items/order`, alice, {
      symbols: ['NVDA', 'AAPL'],
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('ORDER_MISMATCH');
    const extra = await call('put', `/v1/watchlists/${listId}/items/order`, alice, {
      symbols: ['NVDA', 'AAPL', 'MSFT', 'TSLA'],
    });
    expect(extra.status).toBe(400);
  });

  it('removes items; removing one that is not there is an idempotent 204 (control: it was there once)', async () => {
    expect((await call('delete', `/v1/watchlists/${listId}/items/msft`, alice)).status).toBe(204);
    const list = (await call('get', '/v1/watchlists', alice)).body.watchlists.find(
      (l: { id: string }) => l.id === listId,
    );
    expect(list.items.map((i: { symbol: string }) => i.symbol)).toEqual(['NVDA', 'AAPL']);
    expect((await call('delete', `/v1/watchlists/${listId}/items/MSFT`, alice)).status).toBe(204);
  });

  it('deleting a list removes its items (cascade) but not the instruments', async () => {
    const before = await db.migrator.query<{ n: string }>(`SELECT count(*) AS n FROM instruments`);
    expect((await call('delete', `/v1/watchlists/${listId}`, alice)).status).toBe(204);
    const items = await db.migrator.query(
      `SELECT 1 FROM watchlist_items WHERE watchlist_id = $1::uuid`,
      [listId],
    );
    expect(items.rowCount).toBe(0);
    const after = await db.migrator.query<{ n: string }>(`SELECT count(*) AS n FROM instruments`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect((await call('delete', `/v1/watchlists/${listId}`, alice)).status).toBe(404); // already gone
  });
});

describe('6. watchlists: limits at the service AND at the database', () => {
  it('the 21st list is refused by the service (409) and by the database trigger (control: the 20th works)', async () => {
    const carol = await registerUser(h, 'carol-wl@example.com');
    for (let i = 1; i <= 20; i += 1) {
      const res = await call('post', '/v1/watchlists', carol, { name: `List ${String(i)}` });
      expect(res.status, `list ${String(i)}`).toBe(201);
    }
    const over = await call('post', '/v1/watchlists', carol, { name: 'List 21' });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('WATCHLIST_LIMIT');

    // directly as vantage_app: the trigger is the backstop for a service bug
    const id = await userId('carol-wl@example.com');
    await expect(
      pool().query(
        `INSERT INTO watchlists (id, user_id, name, position) VALUES ($1::uuid, $2::uuid, 'List 21', 21)`,
        [randomUUID(), id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'watchlists_per_user_limit' });
    const n = await db.migrator.query<{ n: string }>(
      `SELECT count(*) AS n FROM watchlists WHERE user_id = $1::uuid`,
      [id],
    );
    expect(n.rows[0]?.n).toBe('20');
    // control: another user is not affected by carol's 20
    expect((await call('post', '/v1/watchlists', bob, { name: 'Another' })).status).toBe(201);
  });

  it('the name length CHECK holds at the database too', async () => {
    const id = await userId('bob-wl@example.com');
    for (const name of ['', 'x'.repeat(41)]) {
      await expect(
        pool().query(`INSERT INTO watchlists (id, user_id, name) VALUES ($1::uuid, $2::uuid, $3)`, [
          randomUUID(),
          id,
          name,
        ]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'watchlists_name_length_chk' });
    }
  });

  it('the 101st item is refused by the service (409) and by the database trigger (control: the 100th works)', async () => {
    const dave = await registerUser(h, 'dave-wl@example.com');
    const created = await call('post', '/v1/watchlists', dave, { name: 'Big' });
    const listId = created.body.id as string;
    // 99 through the database as vantage_app (fast), the 100th through the API
    await pool().query(
      `INSERT INTO watchlist_items (watchlist_id, instrument_id, position)
       SELECT $1::uuid, id, row_number() OVER (ORDER BY symbol) FROM instruments WHERE symbol LIKE 'SYN%' ORDER BY symbol LIMIT 99`,
      [listId],
    );
    const hundredth = await call('post', `/v1/watchlists/${listId}/items`, dave, {
      symbol: 'AAPL',
    });
    expect(hundredth.status).toBe(201);
    expect(hundredth.body.items).toHaveLength(100);
    const over = await call('post', `/v1/watchlists/${listId}/items`, dave, { symbol: 'MSFT' });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('WATCHLIST_FULL');
    const msft = await db.migrator.query<{ id: string }>(
      `SELECT id FROM instruments WHERE symbol = 'MSFT'`,
    );
    await expect(
      pool().query(
        `INSERT INTO watchlist_items (watchlist_id, instrument_id, position) VALUES ($1::uuid, $2::uuid, 101)`,
        [listId, msft.rows[0]?.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'watchlist_items_per_list_limit' });
    // re-adding an existing one at the limit is still an idempotent no-op, not an error
    expect(
      (await call('post', `/v1/watchlists/${listId}/items`, dave, { symbol: 'AAPL' })).status,
    ).toBe(200);
  });

  it('the limit holds under concurrency: 5 parallel inserts with 98 items present let exactly 2 in', async () => {
    const erin = await registerUser(h, 'erin-wl@example.com');
    const listId = (await call('post', '/v1/watchlists', erin, { name: 'Race' })).body.id as string;
    await pool().query(
      `INSERT INTO watchlist_items (watchlist_id, instrument_id, position)
       SELECT $1::uuid, id, row_number() OVER (ORDER BY symbol) FROM instruments WHERE symbol LIKE 'SYN%' ORDER BY symbol LIMIT 98`,
      [listId],
    );
    const extra = (
      await db.migrator.query<{ id: string }>(
        `SELECT id FROM instruments WHERE symbol LIKE 'SYN%' ORDER BY symbol OFFSET 98 LIMIT 5`,
      )
    ).rows;
    expect(extra).toHaveLength(5);
    const results = await Promise.allSettled(
      extra.map((e) =>
        pool().query(
          `INSERT INTO watchlist_items (watchlist_id, instrument_id, position) VALUES ($1::uuid, $2::uuid, 200)`,
          [listId, e.id],
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
    const n = await db.migrator.query<{ n: string }>(
      `SELECT count(*) AS n FROM watchlist_items WHERE watchlist_id = $1::uuid`,
      [listId],
    );
    expect(n.rows[0]?.n).toBe('100');
  });
});

describe('6. watchlists: isolation and access control', () => {
  let aliceList: string;
  beforeAll(async () => {
    const r = await call('post', '/v1/watchlists', alice, { name: 'Private' });
    aliceList = r.body.id as string;
    await call('post', `/v1/watchlists/${aliceList}/items`, alice, { symbol: 'AAPL' });
  });

  it("another user's list is 404 (not 403) for every operation, and stays untouched (control: the owner can)", async () => {
    const attempts: Array<[Method, string, unknown?]> = [
      ['patch', `/v1/watchlists/${aliceList}`, { name: 'Hacked' }],
      ['delete', `/v1/watchlists/${aliceList}`],
      ['post', `/v1/watchlists/${aliceList}/items`, { symbol: 'MSFT' }],
      ['put', `/v1/watchlists/${aliceList}/items/order`, { symbols: ['AAPL'] }],
      ['delete', `/v1/watchlists/${aliceList}/items/AAPL`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, bob, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error.code).toBe('WATCHLIST_NOT_FOUND');
    }
    const bobs = await call('get', '/v1/watchlists', bob);
    expect(JSON.stringify(bobs.body)).not.toContain(aliceList);
    const mine = (await call('get', '/v1/watchlists', alice)).body.watchlists.find(
      (l: { id: string }) => l.id === aliceList,
    );
    expect(mine).toMatchObject({ name: 'Private', items: [{ symbol: 'AAPL', position: 0 }] });
    expect(
      (await call('patch', `/v1/watchlists/${aliceList}`, alice, { name: 'Private 2' })).status,
    ).toBe(200);
  });

  it('a malformed or random list id is also 404', async () => {
    for (const id of ['not-a-uuid', randomUUID(), '1', '%00']) {
      expect((await call('delete', `/v1/watchlists/${id}`, alice)).status, id).toBe(404);
    }
  });

  it('unauthenticated requests get 401 on every route (control: with a session 200)', async () => {
    const routes: Array<[Method, string, unknown?]> = [
      ['get', '/v1/watchlists'],
      ['post', '/v1/watchlists', { name: 'x' }],
      ['patch', `/v1/watchlists/${aliceList}`, { name: 'x' }],
      ['delete', `/v1/watchlists/${aliceList}`],
      ['post', `/v1/watchlists/${aliceList}/items`, { symbol: 'AAPL' }],
      ['put', `/v1/watchlists/${aliceList}/items/order`, { symbols: ['AAPL'] }],
      ['delete', `/v1/watchlists/${aliceList}/items/AAPL`],
    ];
    for (const [method, path, body] of routes) {
      expect((await call(method, path, null, body)).status, `${method} ${path}`).toBe(401);
    }
    expect((await call('get', '/v1/watchlists', alice)).status).toBe(200);
  });

  it('state-changing watchlist routes need the right Origin (CSRF); GET does not', async () => {
    for (const origin of [null, 'http://evil.example']) {
      expect((await call('post', '/v1/watchlists', alice, { name: 'csrf' }, origin)).status).toBe(
        403,
      );
      expect(
        (await call('patch', `/v1/watchlists/${aliceList}`, alice, { name: 'csrf' }, origin))
          .status,
      ).toBe(403);
      expect(
        (await call('delete', `/v1/watchlists/${aliceList}`, alice, undefined, origin)).status,
      ).toBe(403);
      expect(
        (
          await call(
            'put',
            `/v1/watchlists/${aliceList}/items/order`,
            alice,
            { symbols: ['AAPL'] },
            origin,
          )
        ).status,
      ).toBe(403);
    }
    expect((await call('get', '/v1/watchlists', alice)).status).toBe(200);
  });
});

describe('6. privileges of vantage_app on instruments and exchanges', () => {
  it('cannot DELETE or TRUNCATE instruments (permission denied)', async () => {
    await expect(
      pool().query(`DELETE FROM instruments WHERE symbol = 'SYN001'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(pool().query(`DELETE FROM instruments`)).rejects.toMatchObject({ code: '42501' });
    await expect(pool().query(`TRUNCATE instruments CASCADE`)).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('can INSERT and UPDATE instruments and the provider map (control)', async () => {
    const exch = await db.migrator.query<{ id: string }>(
      `SELECT id FROM exchanges WHERE code = 'XNAS'`,
    );
    const id = randomUUID();
    await pool().query(
      `INSERT INTO instruments (id, symbol, name, asset_class, exchange_id, quote_currency, tick_size, qty_step, min_qty, attrs)
       VALUES ($1::uuid, 'PRIV1', 'Privilege Test', 'EQUITY', $2::uuid, 'USD', 0.01, 1, 1, '{"source":"SYNTHETIC"}')`,
      [id, exch.rows[0]?.id],
    );
    expect(
      (
        await pool().query(`UPDATE instruments SET name = 'Privilege Test 2' WHERE id = $1::uuid`, [
          id,
        ])
      ).rowCount,
    ).toBe(1);
    await pool().query(
      `INSERT INTO instrument_provider_map (instrument_id, provider, provider_symbol) VALUES ($1::uuid, 'TESTVENDOR', 'PRIV1')`,
      [id],
    );
    expect(
      (
        await pool().query(
          `UPDATE instrument_provider_map SET provider_symbol = 'PRIV2' WHERE instrument_id = $1::uuid`,
          [id],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      pool().query(`DELETE FROM instrument_provider_map WHERE instrument_id = $1::uuid`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('exchanges (the calendars) are read-only: SELECT works, INSERT, UPDATE and DELETE are denied', async () => {
    expect((await pool().query(`SELECT code FROM exchanges`)).rowCount).toBe(4); // XNYS, XNAS, ARCX and (M7a) CRYPTO
    await expect(pool().query(`UPDATE exchanges SET calendar = '{}'::jsonb`)).rejects.toMatchObject(
      { code: '42501' },
    );
    await expect(pool().query(`DELETE FROM exchanges`)).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool().query(
        `INSERT INTO exchanges (id, code, name, timezone, calendar) VALUES ($1::uuid, 'XXXX', 'x', 'UTC', '{}'::jsonb)`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('can delete its own watchlists and items (control: DELETE is granted there)', async () => {
    const id = await userId('bob-wl@example.com');
    const r = await pool().query(
      `DELETE FROM watchlists WHERE user_id = $1::uuid AND name = 'Another'`,
      [id],
    );
    expect(r.rowCount).toBe(1);
  });
});

describe('7. safety', () => {
  it('no response, log line or error contains a session cookie value or a password', () => {
    const logs = h.logs.join('\n');
    const all = bodies.join('\n');
    for (const secret of [VALID_PASSWORD, alice, bob]) {
      expect(logs).not.toContain(secret);
      expect(all).not.toContain(secret);
    }
    for (const text of [logs, all]) {
      expect(text).not.toMatch(/\n\s+at \S+/);
      expect(text).not.toContain('"stack"');
      expect(text).not.toMatch(/INSERT INTO|SELECT .* FROM/);
    }
    expect(bodies.length).toBeGreaterThan(50);
  });
});
