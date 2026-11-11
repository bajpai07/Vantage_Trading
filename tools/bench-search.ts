// Search benchmark (NOT a CI gate). Loads 20,000 SYNTHETIC instruments into a throwaway test database
// (attrs.source = 'SYNTHETIC'), runs a mix of searches and prints p50/p95/p99 latency.
// Usage: pnpm bench:search   (needs .env.infra and a running database)
import { createTestDatabase } from '../packages/test-utils/src/index.ts';
import { searchInstruments } from '../apps/api/src/modules/instruments/search.ts';

const TOTAL = 20_000;
const QUERIES = 600;

const db = await createTestDatabase();
try {
  const exch = await db.migrator.query<{ id: string }>(`SELECT id FROM exchanges ORDER BY code`);
  const ids = exch.rows.map((r) => r.id);
  if (ids.length === 0) throw new Error('no exchanges seeded');

  // Synthetic tickers: 3 to 5 letters derived from a hash, unique per (exchange, symbol); names are tagged.
  let loaded = 0;
  let n = 0;
  while (loaded < TOTAL) {
    const batch = TOTAL - loaded;
    const r = await db.migrator.query(
      `INSERT INTO instruments (id, symbol, name, asset_class, exchange_id, quote_currency, tick_size, qty_step, min_qty, attrs)
       SELECT gen_random_uuid(), s.symbol, 'Synthetic ' || initcap(substr(md5((s.n + 7)::text), 1, 6)) || ' ' ||
              (ARRAY['Holdings','Systems','Energy','Bancorp','Therapeutics','Industries'])[1 + (s.n % 6)],
              'EQUITY', ($1::uuid[])[1 + (s.n % $2::int)], 'USD', 0.01, 1, 1, '{"source":"SYNTHETIC"}'::jsonb
         FROM (SELECT n, upper(translate(substr(md5(n::text), 1, 3 + (n % 3)), '0123456789', 'GHJKLMNPQR')) AS symbol
                 FROM generate_series($3::int + 1, $3::int + $4::int) AS n) s
       ON CONFLICT DO NOTHING`,
      [ids, ids.length, n, batch],
    );
    loaded += r.rowCount ?? 0;
    n += batch;
    if (n > TOTAL * 20) throw new Error('could not generate enough unique synthetic symbols');
  }
  await db.migrator.query('ANALYZE instruments');

  const sample = await db.migrator.query<{ symbol: string; name: string }>(
    `SELECT symbol, name FROM instruments ORDER BY md5(id::text) LIMIT $1::int`,
    [QUERIES],
  );
  const queries: string[] = [];
  sample.rows.forEach((row, i) => {
    switch (i % 4) {
      case 0:
        queries.push(row.symbol); // exact symbol
        break;
      case 1:
        queries.push(row.symbol.slice(0, 2)); // short prefix
        break;
      case 2:
        queries.push(`${row.symbol.slice(1, 2)}${row.symbol.slice(0, 1)}${row.symbol.slice(2)}`); // typo (swap)
        break;
      default:
        queries.push(row.name.split(' ')[1] ?? row.name); // a word of the name
    }
  });

  const run = async (q: string): Promise<number> => {
    const t0 = process.hrtime.bigint();
    await searchInstruments(db.app, q, 20);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  for (const q of queries.slice(0, 40)) await run(q); // warm-up, not measured

  const times: number[] = [];
  for (const q of queries) times.push(await run(q));
  times.sort((a, b) => a - b);
  const pct = (p: number): number =>
    times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] ?? 0;
  const f = (x: number): string => x.toFixed(1);

  const count = await db.migrator.query<{ n: string }>(
    `SELECT count(*) AS n FROM instruments WHERE attrs->>'source' = 'SYNTHETIC'`,
  );
  process.stdout.write(
    [
      `bench:search  rows=${count.rows[0]?.n ?? '?'} (all attrs.source=SYNTHETIC)  queries=${String(times.length)}`,
      `  p50=${f(pct(50))} ms   p95=${f(pct(95))} ms   p99=${f(pct(99))} ms   max=${f(times[times.length - 1] ?? 0)} ms`,
      `  target (PRD 5.2): p95 < 150 ms on 20k rows -> ${pct(95) < 150 ? 'MET' : 'NOT MET'} on this machine`,
    ].join('\n') + '\n',
  );
} finally {
  await db.dispose();
}
