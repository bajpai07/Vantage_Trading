// Helpers for the order API integration tests (real Postgres, real HTTP through the Nest test app).
import { randomUUID } from 'node:crypto';
import type { Quote } from '@vantage/market-model';
import type { TestDatabase } from '@vantage/test-utils';
import { QUOTE_STORE, REGISTER_LIMITER } from '../tokens.js';
import { RateLimiter } from '../modules/auth/rate-limiter.js';
import type { InMemoryQuoteStore } from '../modules/market-data/quote.store.js';
import { WEB_ORIGIN, cookie, createHarness, registerUser } from './harness.js';
import type { Harness, HarnessOptions } from './harness.js';

/** Tuesday 10:00 America/New_York: the NYSE and Nasdaq are open. */
export const OPEN_TIME = '2026-11-10T15:00:00.000Z';

export const BUY_AAPL = {
  symbol: 'AAPL',
  side: 'BUY',
  type: 'MARKET',
  qty: '10',
  referencePrice: '190.00',
} as const;

/** A harness with a permissive register limiter (many users from one IP) and a high order limit. */
export function createOrdersHarness(db: TestDatabase, opts: HarnessOptions = {}): Promise<Harness> {
  return createHarness(db, {
    now: OPEN_TIME,
    ...opts,
    env: {
      ORDER_RATE_LIMIT_PER_MINUTE: '100000',
      SESSION_IDLE_MINUTES: '10080',
      SESSION_ABSOLUTE_DAYS: '90',
      ...opts.env,
    },
    overrides: [
      [
        REGISTER_LIMITER,
        new RateLimiter({ limit: 1_000_000, windowMs: 60_000, now: () => Date.now() }),
      ],
      ...(opts.overrides ?? []),
    ],
  });
}

/** Puts an accepted quote straight into the store. The provider timestamp is `ageSeconds` before the clock. */
export async function setQuote(
  h: Harness,
  symbol: string,
  bid: string,
  ask: string,
  opts: { ageSeconds?: number; last?: string } = {},
): Promise<void> {
  const now = h.clock.now();
  const quote: Quote = {
    symbol,
    bid,
    ask,
    ...(opts.last === undefined ? {} : { last: opts.last }),
    providerTs: new Date(now.getTime() - (opts.ageSeconds ?? 900) * 1000),
    receivedAt: now,
    source: 'FIXTURE',
    entitlement: 'DELAYED',
    delaySeconds: 900,
  };
  await h.app
    .get<InMemoryQuoteStore>(QUOTE_STORE)
    .set(symbol, { lastAccepted: quote, pending: null });
}

export interface TestUser {
  readonly email: string;
  readonly token: string;
  readonly accountId: string;
}

let counter = 0;
export async function newUser(h: Harness, db: TestDatabase, label = 'u'): Promise<TestUser> {
  counter += 1;
  const email = `${label}${String(counter)}-${randomUUID().slice(0, 8)}@example.com`;
  const token = await registerUser(h, email);
  const r = await db.migrator.query<{ id: string }>(
    `SELECT a.id FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = $1`,
    [email],
  );
  return { email, token, accountId: r.rows[0]?.id ?? '' };
}

export const placeOrder = (
  h: Harness,
  user: Pick<TestUser, 'token'>,
  key: string | undefined,
  body: unknown = BUY_AAPL,
  origin: string | null = WEB_ORIGIN,
) => {
  let req = h.http.post('/v1/orders').set('Cookie', cookie(user.token));
  if (origin !== null) req = req.set('Origin', origin);
  if (key !== undefined) req = req.set('Idempotency-Key', key);
  return req.send(body as object);
};

export const getAs = (h: Harness, user: Pick<TestUser, 'token'>, path: string) =>
  h.http.get(path).set('Cookie', cookie(user.token));

export const newKey = (): string => `key-${randomUUID()}`;

export async function cash(db: TestDatabase, accountId: string): Promise<string> {
  const r = await db.migrator.query<{ balance: string }>(
    `SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'CASH' AND currency = 'USD'`,
    [accountId],
  );
  return r.rows[0]?.balance ?? '';
}

export async function counts(
  db: TestDatabase,
  accountId: string,
): Promise<{ orders: number; executions: number; idempotency: number; ledgerTx: number }> {
  const n = async (sql: string): Promise<number> =>
    Number((await db.migrator.query(sql, [accountId])).rows[0]?.n);
  return {
    orders: await n(`SELECT count(*) AS n FROM orders WHERE account_id = $1::uuid`),
    executions: await n(`SELECT count(*) AS n FROM executions WHERE account_id = $1::uuid`),
    idempotency: await n(`SELECT count(*) AS n FROM idempotency_keys WHERE account_id = $1::uuid`),
    ledgerTx: await n(`SELECT count(*) AS n FROM ledger_transactions WHERE account_id = $1::uuid`),
  };
}
