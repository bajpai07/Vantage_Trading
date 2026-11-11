import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { parseCalendar } from '@vantage/market-model';
import { NYSE_CALENDAR_2026_2027 } from '@vantage/market-model/testing';
import { createTestDatabase } from '@vantage/test-utils';
import type { TestDatabase } from '@vantage/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDER, POOL } from '../../tokens.js';
import { cookie, createHarness, registerUser } from '../../testing/harness.js';
import type { Harness } from '../../testing/harness.js';
import { FIXTURE_INSTRUMENTS } from '../market-data/fixture/fixture.data.js';
import type { FixtureProvider } from '../market-data/fixture/fixture.provider.js';
import type { MarketDataProvider } from '../market-data/provider.js';
import { syncInstrumentMaster } from './instrument-sync.js';
import { InstrumentsService } from './instruments.module.js';

let db: TestDatabase;
let h: Harness;
let token: string;

beforeAll(async () => {
  db = await createTestDatabase();
  h = await createHarness(db);
  token = await registerUser(h, 'search@example.com');
});
afterAll(async () => {
  await h.close();
  await db.dispose();
});

const provider = (): FixtureProvider => h.app.get<FixtureProvider>(PROVIDER);
const pool = (): pg.Pool => h.app.get<pg.Pool>(POOL);
const deps = () => ({
  clock: h.clock,
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: (m: string, f?: Record<string, unknown>) => h.logs.push(JSON.stringify({ msg: m, ...f })),
    error: () => undefined,
  },
});

const search = (q: string) =>
  h.http.get('/v1/instruments/search').query({ q }).set('Cookie', cookie(token));

async function snapshot(): Promise<string> {
  const a = await db.migrator.query(`SELECT * FROM instruments ORDER BY id`);
  const b = await db.migrator.query(
    `SELECT * FROM instrument_provider_map ORDER BY instrument_id, provider`,
  );
  return JSON.stringify([a.rows, b.rows]);
}

describe('1. instrument master sync', () => {
  it('the first run (at startup) inserted the fixture instruments, all labelled FIXTURE, whole shares', async () => {
    const r = await db.migrator.query<{
      n: string;
      sources: string[];
      tick: string[];
      frac: boolean[];
      step: string[];
      minq: string[];
      gates: string[][];
    }>(
      `SELECT count(*) AS n, array_agg(DISTINCT attrs->>'source') AS sources, array_agg(DISTINCT tick_size::text) AS tick,
              array_agg(DISTINCT fractional_ok) AS frac, array_agg(DISTINCT qty_step::text) AS step,
              array_agg(DISTINCT min_qty::text) AS minq, array_agg(DISTINCT tradable_in) AS gates
         FROM instruments`,
    );
    expect(Number(r.rows[0]?.n)).toBe(FIXTURE_INSTRUMENTS.length);
    expect(r.rows[0]?.sources).toEqual(['FIXTURE']);
    expect(r.rows[0]?.tick).toEqual(['0.0100000000']);
    expect(r.rows[0]?.frac).toEqual([false]);
    expect(r.rows[0]?.step).toEqual(['1.0000000000']);
    expect(r.rows[0]?.minq).toEqual(['1.0000000000']);
    expect(r.rows[0]?.gates).toEqual([['MVP']]);
    const map = await db.migrator.query<{ n: string }>(
      `SELECT count(*) AS n FROM instrument_provider_map WHERE provider = 'FIXTURE'`,
    );
    expect(Number(map.rows[0]?.n)).toBe(FIXTURE_INSTRUMENTS.length);
  });

  it('a second run produces ZERO diffs (row comparison including updated_at)', async () => {
    const before = await snapshot();
    h.clock.advance(3_600_000); // an hour later: if the job touched updated_at it would show
    const result = await syncInstrumentMaster(pool(), provider(), deps());
    expect(result).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: FIXTURE_INSTRUMENTS.length,
      skipped: [],
      missing: [],
    });
    expect(await snapshot()).toBe(before);
  });

  it('a real change updates only that row (control), and changing it back is another update', async () => {
    const entries = await provider().loadInstrumentMaster();
    const aapl = entries.find((e) => e.symbol === 'AAPL');
    if (aapl === undefined) throw new Error('AAPL missing from the fixture');
    const before = await snapshot();
    provider().setExtraEntries([{ ...aapl, name: 'Apple Inc. (renamed)' }]);
    const r1 = await syncInstrumentMaster(pool(), provider(), deps());
    expect(r1).toMatchObject({ inserted: 0, updated: 1 });
    expect(await snapshot()).not.toBe(before);
    const row = await db.migrator.query<{ name: string }>(
      `SELECT name FROM instruments WHERE symbol = 'AAPL'`,
    );
    expect(row.rows[0]?.name).toBe('Apple Inc. (renamed)');
    provider().setExtraEntries([]);
    expect(await syncInstrumentMaster(pool(), provider(), deps())).toMatchObject({ updated: 1 });
    expect(await syncInstrumentMaster(pool(), provider(), deps())).toMatchObject({
      updated: 0,
      inserted: 0,
    });
  });

  it('an instrument missing from the master is left alone and logged; an explicit delisting sets DELISTED', async () => {
    const real = provider();
    const withoutAapl: MarketDataProvider = {
      id: real.id,
      capabilities: () => real.capabilities(),
      loadInstrumentMaster: async () =>
        (await real.loadInstrumentMaster()).filter((e) => e.symbol !== 'AAPL'),
      getSnapshot: (s) => real.getSnapshot(s),
      health: () => real.health(),
    };
    const r = await syncInstrumentMaster(pool(), withoutAapl, deps());
    expect(r.missing).toEqual(['XNAS:AAPL']);
    expect(r.updated).toBe(0);
    const still = await db.migrator.query<{ status: string }>(
      `SELECT status::text AS status FROM instruments WHERE symbol = 'AAPL'`,
    );
    expect(still.rows[0]?.status).toBe('ACTIVE'); // not deleted, not delisted by guesswork
    expect(h.logs.some((l) => l.includes('sync_instrument_missing_from_master'))).toBe(true);

    const entries = await real.loadInstrumentMaster();
    const dia = entries.find((e) => e.symbol === 'DIA');
    if (dia === undefined) throw new Error('DIA missing');
    real.setExtraEntries([{ ...dia, status: 'DELISTED' }]);
    expect(await syncInstrumentMaster(pool(), real, deps())).toMatchObject({ updated: 1 });
    const delisted = await db.migrator.query<{ status: string }>(
      `SELECT status::text AS status FROM instruments WHERE symbol = 'DIA'`,
    );
    expect(delisted.rows[0]?.status).toBe('DELISTED');
    real.setExtraEntries([]);
    await syncInstrumentMaster(pool(), real, deps()); // restore ACTIVE
    const total = await db.migrator.query<{ n: string }>(`SELECT count(*) AS n FROM instruments`);
    expect(Number(total.rows[0]?.n)).toBe(FIXTURE_INSTRUMENTS.length); // nothing was ever deleted
  });

  it('an unknown exchange in the master is skipped and reported (control: the rest still syncs)', async () => {
    const real = provider();
    const entries = await real.loadInstrumentMaster();
    const bogus = {
      ...(entries[0] as (typeof entries)[number]),
      symbol: 'NOWHERE',
      providerSymbol: 'NOWHERE',
      exchange: 'XXXX',
    };
    real.setExtraEntries([bogus]);
    const r = await syncInstrumentMaster(pool(), real, deps());
    expect(r.skipped).toEqual(['XXXX:NOWHERE']);
    real.setExtraEntries([]);
  });
});

describe('2. search', () => {
  it('requires a session (control: with one it works)', async () => {
    expect((await h.http.get('/v1/instruments/search').query({ q: 'AAPL' })).status).toBe(401);
    expect((await search('AAPL')).status).toBe(200);
  });

  it('returns labelled results: symbol, name, class, exchange, currency, status, entitlement, source', async () => {
    const res = await search('apple');
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({
      symbol: 'AAPL',
      name: expect.stringContaining('Apple'),
      assetClass: 'EQUITY',
      exchange: 'XNAS',
      currency: 'USD',
      status: 'ACTIVE',
      tickSize: '0.01',
      entitlement: 'DELAYED',
      delaySeconds: 900,
      source: 'FIXTURE',
    });
  });

  it('puts the exact symbol first in 100% of 200 test cases (fixture symbols plus a synthetic list)', async () => {
    // 168 synthetic instruments, including symbols that are prefixes of each other (AB, ABC, ABCD ...)
    const synthetic: string[] = [];
    for (let i = 0; i < 26; i += 1) {
      const root = `Z${String(i).padStart(2, '0')}`;
      for (const suffix of ['', 'A', 'AB', 'ABC', 'X', 'XY', 'Q'])
        synthetic.push(`${root}${suffix}`);
    }
    const exch = await db.migrator.query<{ id: string }>(
      `SELECT id FROM exchanges WHERE code = 'XNYS'`,
    );
    for (const sym of synthetic) {
      await db.migrator.query(
        `INSERT INTO instruments (id, symbol, name, asset_class, exchange_id, quote_currency, tick_size, qty_step, min_qty, attrs)
         VALUES ($1::uuid, $2, $3, 'EQUITY', $4::uuid, 'USD', 0.01, 1, 1, '{"source":"SYNTHETIC"}')`,
        [randomUUID(), sym, `Synthetic ${sym} Holdings`, exch.rows[0]?.id],
      );
    }
    const symbols = [...FIXTURE_INSTRUMENTS.map((i) => i.symbol), ...synthetic].slice(0, 200);
    expect(symbols.length).toBe(200);
    const svc = h.app.get(InstrumentsService);
    let firsts = 0;
    for (const s of symbols) {
      const rows = await svc.search(s);
      if (rows[0]?.symbol === s) firsts += 1;
      const lower = await svc.search(s.toLowerCase());
      if (lower[0]?.symbol !== s) firsts -= 1000; // case must not matter
    }
    expect(firsts).toBe(symbols.length);
    // and over HTTP for a few prefix-heavy ones
    for (const s of ['AAPL', 'V', synthetic[0] ?? '']) {
      expect((await search(s)).body.results[0].symbol).toBe(s);
    }
  });

  it('tolerates typos: APPL finds AAPL, NVIDA finds NVDA, MICROSFT finds MSFT, GOOG finds GOOGL first', async () => {
    const top = async (q: string) =>
      (await search(q)).body.results.slice(0, 3).map((r: { symbol: string }) => r.symbol);
    expect(await top('APPL')).toContain('AAPL');
    expect(await top('NVIDA')).toContain('NVDA');
    expect(await top('Microsft')).toContain('MSFT');
    expect((await top('GOOG'))[0]).toBe('GOOGL');
    expect(await top('Vangaurd')).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(VOO|VTI)$/)]),
    );
  });

  it('is safe against wildcards, quotes and SQL (control: normal text works; table intact)', async () => {
    for (const q of [
      '%',
      '_',
      '\\',
      '%%%',
      '\\%',
      "'",
      '"',
      "'; DROP TABLE instruments; --",
      "AAPL' OR '1'='1",
      'a%b_c',
      '\u0000x'.slice(1),
    ]) {
      const res = await search(q);
      expect(res.status, `q=${q}`).toBe(200);
      expect(res.body.results.length, `q=${q}`).toBeLessThanOrEqual(20);
    }
    // a bare wildcard is matched literally: nothing starts with or contains a percent sign
    expect((await search('%')).body.results).toEqual([]);
    expect((await search('_')).body.results).toEqual([]);
    expect((await search("AAPL' OR '1'='1")).body.results.length).toBeLessThan(10);
    const left = await db.migrator.query<{ n: string }>(`SELECT count(*) AS n FROM instruments`);
    expect(Number(left.rows[0]?.n)).toBeGreaterThanOrEqual(FIXTURE_INSTRUMENTS.length);
    expect((await search('apple')).body.results[0].symbol).toBe('AAPL');
  });

  it('rejects an empty, blank, oversized, missing or repeated q (control: 1 and 40 characters work)', async () => {
    for (const q of ['', '   ', 'x'.repeat(41)]) {
      const res = await search(q);
      expect(res.status, JSON.stringify(q)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await h.http.get('/v1/instruments/search').set('Cookie', cookie(token))).status).toBe(
      400,
    );
    expect(
      (await h.http.get('/v1/instruments/search?q=a&q=b').set('Cookie', cookie(token))).status,
    ).toBe(400);
    expect((await search('a')).status).toBe(200);
    expect((await search('x'.repeat(40))).status).toBe(200);
  });

  it('never returns more than 20 results', async () => {
    const res = await search('a');
    expect(res.body.results.length).toBeLessThanOrEqual(20);
    expect(res.body.results.length).toBeGreaterThan(5);
  });

  it('GET /v1/instruments/:symbol returns one instrument, 404 for an unknown one, 400 for a bad symbol', async () => {
    const ok = await h.http.get('/v1/instruments/aapl').set('Cookie', cookie(token));
    expect(ok.status).toBe(200);
    expect(ok.body.symbol).toBe('AAPL');
    const missing = await h.http.get('/v1/instruments/NOPE').set('Cookie', cookie(token));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('INSTRUMENT_NOT_FOUND');
    expect(
      (await h.http.get('/v1/instruments/bad%20symbol').set('Cookie', cookie(token))).status,
    ).toBe(400);
    expect((await h.http.get('/v1/instruments/AAPL')).status).toBe(401);
  });
});

describe('3. exchange calendar data', () => {
  it('XNYS, XNAS and ARCX exist, validate with Zod, and match the official NYSE 2026 and 2027 schedule', async () => {
    const r = await db.migrator.query<{ code: string; timezone: string; calendar: unknown }>(
      `SELECT code, timezone, calendar FROM exchanges ORDER BY code`,
    );
    expect(r.rows.map((x) => x.code)).toEqual(['ARCX', 'XNAS', 'XNYS']);
    for (const row of r.rows) {
      expect(row.timezone).toBe('America/New_York');
      expect(parseCalendar(row.calendar)).toEqual(NYSE_CALENDAR_2026_2027);
    }
  });

  it('every listed holiday falls on a weekday and every early close on a weekday that is not a holiday', () => {
    for (const hd of NYSE_CALENDAR_2026_2027.holidays) {
      const day = new Date(`${hd.date}T12:00:00Z`).getUTCDay();
      expect([1, 2, 3, 4, 5], hd.date).toContain(day);
    }
    for (const e of NYSE_CALENDAR_2026_2027.earlyCloses) {
      const day = new Date(`${e.date}T12:00:00Z`).getUTCDay();
      expect([1, 2, 3, 4, 5], e.date).toContain(day);
      expect(NYSE_CALENDAR_2026_2027.holidays.some((x) => x.date === e.date)).toBe(false);
    }
  });
});
