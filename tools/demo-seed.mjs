// pnpm demo:seed <email> [--run <id>] (M10, D-114): signs in to an EXISTING account over HTTP and places a small, believable set of
// orders through the real API only: a market BUY of a stock, a fractional BTC BUY, a partial exit by a market SELL, one resting limit
// BUY below the market and one resting limit SELL above cost. Nothing is written to the database directly and nothing is backdated.
//
//   DEMO_SEED_PASSWORD   required: the account's password. It is read ONLY from the environment (never an argument) and never printed.
//   DEMO_SEED_BASE_URL   default http://127.0.0.1:3000/api  (the web app's same-origin proxy; the API itself works too)
//   DEMO_SEED_ORIGIN     default http://localhost:3000      (the one origin the API accepts for state-changing requests)
//   --run <id>           the run id the idempotency keys derive from; the same id replays the same orders (a safe re-run)
//
// Exit codes: 0 done, 1 failure, 64 usage. Prices come from the live quote at run time; the stock and crypto symbols are AAPL and BTC-USD.
import { randomBytes } from 'node:crypto';

const usage = () => {
  process.stderr.write('usage: DEMO_SEED_PASSWORD=... pnpm demo:seed <email> [--run <id>]\n');
  process.exit(64);
};
const args = process.argv.slice(2);
let runId = null;
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--run') {
    runId = args[i + 1] ?? null;
    i += 1;
    if (runId === null || !/^[A-Za-z0-9_-]{4,40}$/.test(runId)) usage();
  } else if (args[i].startsWith('-')) usage();
  else positional.push(args[i]);
}
if (positional.length !== 1 || !positional[0].includes('@')) usage();
const email = positional[0];
const password = process.env.DEMO_SEED_PASSWORD;
if (password === undefined || password === '') {
  process.stderr.write(
    'DEMO_SEED_PASSWORD is not set: the password is read from the environment only.\n',
  );
  process.exit(64);
}
runId ??= randomBytes(5).toString('hex');
const base = (process.env.DEMO_SEED_BASE_URL ?? 'http://127.0.0.1:3000/api').replace(/\/+$/, '');
const origin = process.env.DEMO_SEED_ORIGIN ?? 'http://localhost:3000';
const log = (m) => process.stdout.write(`[seed] ${m}\n`);

// exact decimal strings <-> integers of 1e-8 (no floats)
const units = (s) => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(s));
  if (m === null) throw new Error(`not a plain decimal: ${s}`);
  return BigInt(m[1]) * 100000000n + BigInt((m[2] ?? '').padEnd(8, '0').slice(0, 8));
};
const price2 = (u) =>
  `${(u / 100000000n).toString()}.${((u % 100000000n) / 1000000n).toString().padStart(2, '0')}`;
const roundDownTick = (u) => (u / 1000000n) * 1000000n; // the 0.01 tick grid

async function main() {
  const login = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password }),
  });
  if (login.status !== 200) throw new Error(`sign-in answered ${String(login.status)}`);
  const cookie = /(vantage_session=[^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
  if (cookie === undefined) throw new Error('no session cookie');
  const call = (method, path, body, extra = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        cookie,
        origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const quote = async (symbol) => {
    for (let i = 0; i < 30; i += 1) {
      const r = await (await call('GET', `/v1/quotes?symbols=${symbol}`)).json();
      const q = r.quotes?.[0];
      if (q?.known && (q.freshness === 'REAL_TIME' || q.freshness === 'DELAYED')) return q;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error(`no fresh quote for ${symbol}`);
  };
  const place = async (label, order) => {
    const r = await call('POST', '/v1/orders', order, {
      'idempotency-key': `seed-${runId}-${label}`,
    });
    const b = await r.json();
    if (r.status !== 201 && r.status !== 200)
      throw new Error(`${label}: HTTP ${String(r.status)} ${String(b.code ?? '')}`);
    log(
      `${label}: ${order.side} ${order.qty} ${order.symbol} ${order.type} -> ${b.status}` +
        (b.execution ? `, fill ${b.execution.price}` : '') +
        (b.reservedUsd && units(b.reservedUsd) > 0n ? `, reserved ${b.reservedUsd}` : ''),
    );
    return b;
  };

  const aapl = await quote('AAPL');
  const btc = await quote('BTC-USD');
  await place('1-stock-buy', {
    symbol: 'AAPL',
    side: 'BUY',
    type: 'MARKET',
    qty: '10',
    referencePrice: aapl.ask,
  });
  await place('2-btc-buy', {
    symbol: 'BTC-USD',
    side: 'BUY',
    type: 'MARKET',
    qty: '0.02',
    referencePrice: btc.ask,
  });
  const aapl2 = await quote('AAPL');
  await place('3-stock-partial-exit', {
    symbol: 'AAPL',
    side: 'SELL',
    type: 'MARKET',
    qty: '4',
    referencePrice: aapl2.bid,
  });
  const btc2 = await quote('BTC-USD');
  // a resting BUY about 10 % below the bid, and a resting SELL about 10 % above the ask (above cost)
  await place('4-btc-limit-buy', {
    symbol: 'BTC-USD',
    side: 'BUY',
    type: 'LIMIT',
    qty: '0.01',
    limitPrice: price2(roundDownTick((units(btc2.bid) * 9n) / 10n)),
    tif: 'GTC',
  });
  await place('5-stock-limit-sell', {
    symbol: 'AAPL',
    side: 'SELL',
    type: 'LIMIT',
    qty: '3',
    limitPrice: price2(roundDownTick((units(aapl2.ask) * 11n) / 10n)),
    tif: 'GTC',
  });
  log(`done (run ${runId})`);
}

try {
  await main();
} catch (e) {
  process.stderr.write(`[seed] FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
