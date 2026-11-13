// Test-only launcher for the web app's end-to-end tests (apps/web/e2e). NOT part of the build and never run in
// production: it starts the real Nest API on a throwaway real Postgres database as `vantage_app`, with an injected
// clock (a fixed Tuesday 10:00 New York, market open) and FIXTURE data, and a tiny control server on a second port
// so a test can set quotes and the clock. "Test mode as the API allows": this is the same harness the integration
// tests use, listening on a port.
//
//   E2E_API_PORT (default 4100)  the API
//   E2E_CONTROL_PORT (default 4101)  POST /quote {symbol,bid,ask,ageSeconds?,last?} | {symbol,clear:true}
//                                    POST /clock {iso}   POST /shutdown   GET /health
//   E2E_WEB_ORIGIN (default http://localhost:3100)  the one origin the API accepts (CSRF and CORS)
import 'reflect-metadata';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createTestDatabase } from '@vantage/test-utils';
import { QUOTE_STORE } from '../tokens.js';
import type { InMemoryQuoteStore } from '../modules/market-data/quote.store.js';
import { createOrdersHarness, setQuote } from './orders-kit.js';

const apiPort = Number(process.env.E2E_API_PORT ?? 4100);
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? 4101);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3100';

const db = await createTestDatabase();
// the web server (this machine, loopback) is the one trusted proxy: tests can then send X-Forwarded-For through it (D-69)
const h = await createOrdersHarness(db, {
  env: { WEB_ORIGIN: webOrigin, TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128' },
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
