// pnpm compose:smoke (M10, D-111): builds and starts the compose stack under its OWN project name (vantage-smoke), registers a user
// over HTTP through the web app's same-origin proxy, places a market order and a resting limit order, reads the portfolio, checks
// the equity identity from the response strings, runs the ledger reconcile check against the compose database (through a temporary
// loopback port mapping, docker-compose.smoke.yml), and always tears the stack down (down -v). It never touches the developer's dev
// database or the finsight-* containers. Exit 0 = all good, 1 = something failed. No secret is printed.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROJECT = 'vantage-smoke';
const WEB_PORT = process.env.SMOKE_WEB_PORT ?? '3555';
const DB_PORT = process.env.SMOKE_DB_PORT ?? '56555';
const envFile = resolve(root, '.env.compose');
if (!existsSync(envFile)) {
  process.stderr.write('no .env.compose: run pnpm compose:setup first\n');
  process.exit(1);
}
const secrets = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const compose = (args, inherit = true) =>
  spawnSync(
    'docker',
    [
      'compose',
      '-p',
      PROJECT,
      '--env-file',
      envFile,
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.smoke.yml',
      ...args,
    ],
    {
      cwd: root,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WEB_PORT, SMOKE_DB_PORT: DB_PORT },
      encoding: 'utf8',
    },
  );
const log = (m) => process.stdout.write(`[smoke] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failure = null;

// exact decimal strings -> integers of 1e-8 (no floats)
const units = (s) => {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(s));
  if (m === null) throw new Error(`not a plain decimal: ${s}`);
  const frac = (m[3] ?? '').padEnd(8, '0').slice(0, 8);
  const v = BigInt(m[2]) * 100000000n + BigInt(frac);
  return m[1] === '-' ? -v : v;
};

async function main() {
  log(
    `building and starting the stack (project ${PROJECT}, web port ${WEB_PORT}; db port ${DB_PORT} on 127.0.0.1 for this run only)`,
  );
  const up = compose(['up', '-d', '--build']);
  if (up.status !== 0) throw new Error('docker compose up failed');
  const base = `http://127.0.0.1:${WEB_PORT}`;
  const origin = `http://localhost:${WEB_PORT}`;
  // wait until the web app answers and the API behind it is healthy
  let ok = false;
  for (let i = 0; i < 90 && !ok; i += 1) {
    try {
      const r = await fetch(`${base}/api/v1/market/feed`);
      ok = r.status === 200;
    } catch {
      /* not up yet */
    }
    if (!ok) await sleep(2000);
  }
  if (!ok) throw new Error('the stack did not become healthy in 3 minutes');
  const psNow = () =>
    compose(['ps', '-a', '--format', 'json'], false)
      .stdout.trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  // the container health checks run every 10 s: give them a minute to report healthy
  let ps = psNow();
  for (
    let i = 0;
    i < 30 && ps.some((c) => c.Service !== 'migrate' && c.Health !== 'healthy');
    i += 1
  ) {
    await sleep(2000);
    ps = psNow();
  }
  const unhealthy = ps.filter((c) => c.Service !== 'migrate' && c.Health !== 'healthy');
  if (unhealthy.length > 0)
    throw new Error(
      `not healthy: ${unhealthy.map((c) => `${c.Service}=${c.Health || c.State}`).join(', ')}`,
    );
  const migrate = ps.find((c) => c.Service === 'migrate');
  log(
    `healthy: ${ps
      .filter((c) => c.Health === 'healthy')
      .map((c) => c.Service)
      .join(', ')}; migrate exited ${String(migrate?.ExitCode)}`,
  );
  if (migrate === undefined || migrate.ExitCode !== 0)
    throw new Error('the migrate service did not exit 0');
  const apiPublished = (ps.find((c) => c.Service === 'api')?.Publishers ?? []).some(
    (p) => p.PublishedPort > 0,
  );
  if (apiPublished) throw new Error('the API publishes a host port');

  const feed = await (await fetch(`${base}/api/v1/market/feed`)).json();
  log(`feed: source ${feed.source}`);
  if (feed.source !== 'SIM') throw new Error('the compose stack must serve the SIM feed');

  // register through the normal endpoint (the password is random and never printed)
  const email = `smoke-${randomBytes(5).toString('hex')}@demo.invalid`;
  const password = `${randomBytes(18).toString('base64url')}aA1`;
  const reg = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      email,
      password,
      displayName: 'Smoke Test',
      countryCode: 'IN',
      confirmAdult: true,
      acceptTerms: true,
    }),
  });
  if (reg.status !== 201) throw new Error(`register answered ${String(reg.status)}`);
  const cookie = /(vantage_session=[^;]+)/.exec(reg.headers.get('set-cookie') ?? '')?.[1];
  if (cookie === undefined) throw new Error('no session cookie');
  const call = (method, path, body, extra = {}) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: {
        cookie,
        origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  // a fresh BTC-USD quote (the simulated feed publishes every second)
  let q = null;
  for (let i = 0; i < 30 && q === null; i += 1) {
    const r = await (await call('GET', '/v1/quotes?symbols=BTC-USD')).json();
    const item = r.quotes?.[0];
    if (
      item !== undefined &&
      item.known &&
      (item.freshness === 'REAL_TIME' || item.freshness === 'DELAYED')
    )
      q = item;
    else await sleep(1000);
  }
  if (q === null) throw new Error('no fresh BTC-USD quote');
  log(`quote BTC-USD bid ${q.bid} ask ${q.ask} (${q.freshness}, source ${q.source})`);

  const market = await call(
    'POST',
    '/v1/orders',
    { symbol: 'BTC-USD', side: 'BUY', type: 'MARKET', qty: '0.001', referencePrice: q.ask },
    { 'idempotency-key': `smoke-${randomUUID()}` },
  );
  const mb = await market.json();
  log(
    `market BUY: HTTP ${String(market.status)}, status ${mb.status}, fill price ${mb.execution?.price}`,
  );
  if (market.status !== 201 || mb.status !== 'FILLED')
    throw new Error(`the market order was not filled: ${JSON.stringify(mb).slice(0, 200)}`);

  // a resting limit BUY about 10 % below the bid, on the 0.01 tick grid
  const limitUnits = ((units(q.bid) * 9n) / 10n / 1000000n) * 1000000n;
  const limitPrice = `${(limitUnits / 100000000n).toString()}.${((limitUnits % 100000000n) / 1000000n).toString().padStart(2, '0')}`;
  const limit = await call(
    'POST',
    '/v1/orders',
    { symbol: 'BTC-USD', side: 'BUY', type: 'LIMIT', qty: '0.001', limitPrice, tif: 'GTC' },
    { 'idempotency-key': `smoke-${randomUUID()}` },
  );
  const lb = await limit.json();
  log(
    `limit BUY @ ${limitPrice}: HTTP ${String(limit.status)}, status ${lb.status}, reserved ${lb.reservedUsd}`,
  );
  if (limit.status !== 201 || lb.status !== 'ACCEPTED' || units(lb.reservedUsd) <= 0n)
    throw new Error('the limit order did not rest with a reservation');

  const p = await (await call('GET', '/v1/portfolio')).json();
  const e = p.exact;
  const identity =
    units(e.cash) +
    units(e.reservedUsd) +
    units(e.costBasis) +
    units(e.fees) -
    units(e.realisedPnl);
  log(
    `portfolio: cash ${e.cash}, reserved ${e.reservedUsd}, costBasis ${e.costBasis}, fees ${e.fees}, realised ${e.realisedPnl}, equity ${e.equity}`,
  );
  if (identity !== units(p.initialCapital))
    throw new Error(
      `the equity identity failed: ${String(identity)} vs ${String(units(p.initialCapital))}`,
    );
  if (units(e.reservedUsd) !== units(lb.reservedUsd))
    throw new Error('reservedUsd differs from the order reserve');
  log('equity identity: cash + reserved + costBasis + fees - realised = initial capital (exact)');

  // the ledger reconcile check (invariants I1-I10) against the compose database, through the temporary loopback mapping
  const { default: pg } = await import('pg');
  const { reconcileAccount } = await import(
    pathToFileURL(resolve(root, 'apps/api/dist/modules/ledger/reconcile.js')).href
  );
  const pool = new pg.Pool({
    connectionString: `postgres://vantage_migrator:${encodeURIComponent(secrets.VANTAGE_MIGRATOR_PASSWORD)}@127.0.0.1:${DB_PORT}/vantage_dev`,
    max: 2,
  });
  try {
    const acct = await pool.query(
      `SELECT a.id FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = $1 AND a.kind = 'MAIN'`,
      [email],
    );
    const violations = await reconcileAccount(pool, acct.rows[0].id);
    log(`reconcile (I1-I10, zero tolerance): ${String(violations.length)} violations`);
    if (violations.length > 0)
      throw new Error(`reconcile found violations: ${JSON.stringify(violations).slice(0, 300)}`);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[smoke] FAILED: ${failure}\n`);
}
log('tearing the stack down (down -v)');
const down = compose(['down', '-v', '--remove-orphans', '--timeout', '15']);
if (down.status !== 0 && failure === null) failure = 'docker compose down failed';
if (failure === null) log('PASS');
process.exit(failure === null ? 0 : 1);
