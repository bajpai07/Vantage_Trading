// Test-only launcher for the web app's end-to-end tests (apps/web/e2e). NOT part of the build and never run in
// production: it starts the real Nest API on a throwaway real Postgres database as `vantage_app`, with an injected
// clock (a fixed Tuesday 10:00 New York, market open) and the SIM feed in demo mode (stocks and crypto, M7a), and a
// tiny control server on a second port
// so a test can set quotes and the clock. "Test mode as the API allows": this is the same harness the integration
// tests use, listening on a port.
//
//   E2E_API_PORT (default 4100)  the API
//   E2E_CONTROL_PORT (default 4101)  POST /quote {symbol,bid,ask,ageSeconds?,last?} | {symbol,clear:true}
//                                    POST /sim-refresh {} (re-publish the simulated feed)
//                                    POST /instrument {symbol,status?,tradableIn?}   POST /reconcile {email?}   POST /counts {email}   POST /clock {iso}   POST /shutdown   GET /health
//   E2E_WEB_ORIGIN (default http://localhost:3100)  the one origin the API accepts (CSRF and CORS)
import 'reflect-metadata';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createTestDatabase } from '@vantage/test-utils';
import { QUOTE_STORE } from '../tokens.js';
import type { InMemoryQuoteStore } from '../modules/market-data/quote.store.js';
import { reconcileAccount } from '../modules/ledger/index.js';
import { MarketRefresher } from '../modules/market-data/market.startup.js';
import { SIM_UNIVERSE } from '@vantage/market-model';
import { createOrdersHarness, setQuote } from './orders-kit.js';

const apiPort = Number(process.env.E2E_API_PORT ?? 4100);
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? 4101);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3100';

const db = await createTestDatabase();
// the web server (this machine, loopback) is the one trusted proxy: tests can then send X-Forwarded-For through it (D-69)
const h = await createOrdersHarness(db, {
  env: {
    WEB_ORIGIN: webOrigin,
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    // M7a: the demo configuration: simulated stocks and crypto, labelled SIM, in demo mode (D-74 to D-77)
    MARKET_DATA_SOURCE: 'SIM',
    CRYPTO_FEED: 'sim',
    DEMO_MODE: 'true',
    // M7b: a second e2e profile runs the simulated 24/7 stock session (D-76); the default is the NYSE calendar
    SIM_SESSION: process.env.E2E_SIM_SESSION === 'ALWAYS_OPEN' ? 'ALWAYS_OPEN' : 'NYSE',
    // M8b-1: the limit-order matcher runs in the e2e API (the quotes it evaluates are the ones the control server pins)
    MATCHER: 'on',
    MATCHER_INTERVAL_MS: '300',
  },
});
await h.app.listen(apiPort, '127.0.0.1');

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  control.close();
  await h.close().catch(() => undefined);
  await db.dispose().catch(() => undefined);
  process.exit(0);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const control = createServer((req, res) => {
  void (async () => {
    try {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      const body = await readJson(req);
      if (req.url === '/quote') {
        const symbol = String(body.symbol);
        if (body.clear === true) {
          await h.app
            .get<InMemoryQuoteStore>(QUOTE_STORE)
            .set(symbol, { lastAccepted: null, pending: null });
        } else {
          await setQuote(h, symbol, String(body.bid), String(body.ask), {
            ...(typeof body.ageSeconds === 'number' ? { ageSeconds: body.ageSeconds } : {}),
            ...(typeof body.last === 'string' ? { last: body.last } : {}),
          });
        }
        return send(res, 200, { ok: true });
      }
      if (req.url === '/instrument') {
        // test-only: change an instrument's status or the tradable_in gate (the e2e tests restore it afterwards)
        const symbol = String(body.symbol);
        if (typeof body.status === 'string') {
          await db.migrator.query(
            'UPDATE instruments SET status = $2::instrument_status WHERE symbol = $1',
            [symbol, body.status],
          );
        }
        if (Array.isArray(body.tradableIn)) {
          await db.migrator.query(
            'UPDATE instruments SET tradable_in = $2::text[] WHERE symbol = $1',
            [symbol, body.tradableIn.map(String)],
          );
        }
        return send(res, 200, { ok: true });
      }
      if (req.url === '/sim-refresh') {
        // test-only: forget every quote of the simulated universe and publish the simulated feed again at the current
        // (injected) clock. Tests that script quotes with /quote use this to get the real SIM quotes back.
        const store = h.app.get<InMemoryQuoteStore>(QUOTE_STORE);
        for (const i of SIM_UNIVERSE)
          await store.set(i.symbol, { lastAccepted: null, pending: null });
        const r = await h.app.get(MarketRefresher).refresh();
        return send(res, 200, r);
      }
      if (req.url === '/reconcile') {
        // test-only: the full reconciliation (ledger + trading, zero tolerance) of every account, or of one user's
        const email = typeof body.email === 'string' ? body.email : null;
        const accounts = await db.migrator.query<{ id: string }>(
          'SELECT a.id FROM accounts a JOIN users u ON u.id = a.user_id WHERE $1::text IS NULL OR u.email = $1::citext',
          [email],
        );
        const violations = [];
        for (const a of accounts.rows)
          violations.push(...(await reconcileAccount(db.migrator, a.id)));
        return send(res, 200, { accounts: accounts.rows.length, violations });
      }
      if (req.url === '/counts') {
        // test-only: how many orders and executions this user has (proves "exactly one order")
        const r = await db.migrator.query<{ orders: string; executions: string }>(
          `SELECT (SELECT count(*) FROM orders o JOIN accounts a ON a.id = o.account_id JOIN users u ON u.id = a.user_id WHERE u.email = $1::citext)::text AS orders,
                  (SELECT count(*) FROM executions e JOIN accounts a ON a.id = e.account_id JOIN users u ON u.id = a.user_id WHERE u.email = $1::citext)::text AS executions`,
          [String(body.email)],
        );
        return send(res, 200, r.rows[0]);
      }
      if (req.url === '/clock') {
        h.clock.set(String(body.iso));
        return send(res, 200, { ok: true, now: h.clock.now().toISOString() });
      }
      if (req.url === '/shutdown') {
        send(res, 200, { ok: true });
        void shutdown();
        return;
      }
      return send(res, 404, { error: 'not found' });
    } catch {
      return send(res, 500, { error: 'control error' });
    }
  })();
});
control.listen(controlPort, '127.0.0.1');

// the default AAPL quote of the golden vectors (bid 189.95, ask 190.00)
await setQuote(h, 'AAPL', '189.95', '190.00', { last: '189.97' });

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.stdout.write(
  `e2e-server ready api=${String(apiPort)} control=${String(controlPort)} origin=${webOrigin}\n`,
);
