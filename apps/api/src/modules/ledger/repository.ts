// Ledger repository. Every function takes a pg client that ALREADY has an open transaction, so order
// and ledger work can share one transaction later. Money crosses this boundary only as strings and
// goes to Postgres as `$n::numeric`; no pg type parser is registered, so numeric comes back as text.
import { randomUUID } from 'node:crypto';
import type { ClientBase } from 'pg';
import { grantLegs } from '@vantage/engine';
import type { Leg, LedgerAccountType } from '@vantage/engine';
import { isZero, parse } from '@vantage/money';
import {
  IdempotencyConflictError,
  InsufficientFundsError,
  LedgerAccountNotFoundError,
  LedgerInputError,
  LedgerUnbalancedError,
} from './errors.js';

export type Queryable = Pick<ClientBase, 'query'>;
export type AccountKind = 'MAIN' | 'COMPETITION';
export type LedgerTxKind =
  | 'GRANT'
  | 'ORDER_RESERVE'
  | 'ORDER_RELEASE'
  | 'FILL'
  | 'FEE'
  | 'CORPORATE_ACTION'
  | 'ADJUSTMENT'
  | 'COMPETITION_GRANT';

/** The USD ledger accounts every account gets. */
export const STANDARD_USD_LEDGER_ACCOUNTS: readonly LedgerAccountType[] = [
  'CASH',
  'RESERVED',
  'POSITION_COST',
  'FEES',
  'REALIZED_PNL',
  'CAPITAL',
];

export interface CreateAccountInput {
  readonly accountId: string;
  readonly userId: string;
  readonly kind: AccountKind;
  /** Plain decimal string. */
  readonly initialCapital: string;
}

export interface CreatedAccount {
  readonly accountId: string;
  readonly ledgerAccountIds: Readonly<Record<string, string>>;
}

export async function createAccount(
  client: Queryable,
  input: CreateAccountInput,
): Promise<CreatedAccount> {
  assertPlain('initialCapital', input.initialCapital);
  await client.query(
    `INSERT INTO accounts (id, user_id, kind, initial_capital)
     VALUES ($1::uuid, $2::uuid, $3::account_kind, $4::numeric)`,
    [input.accountId, input.userId, input.kind, input.initialCapital],
  );
  const ids: Record<string, string> = {};
  for (const type of STANDARD_USD_LEDGER_ACCOUNTS) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO ledger_accounts (id, account_id, type, currency)
       VALUES ($1::uuid, $2::uuid, $3::ledger_acct_type, 'USD')`,
      [id, input.accountId, type],
    );
    ids[type] = id;
  }
  return { accountId: input.accountId, ledgerAccountIds: ids };
}

/** An engine leg, plus the reporting-only USD value (defaults to the amount for USD legs). */
export interface PostLeg extends Leg {
  readonly amountUsd?: string;
}

export interface PostTransactionInput {
  readonly accountId: string;
  readonly kind: LedgerTxKind;
  readonly idempotencyKey: string;
  readonly description?: string;
  /** Optional links recorded on the transaction (no foreign keys: ledger rows are immutable). */
  readonly orderId?: string;
  readonly executionId?: string;
  readonly legs: readonly PostLeg[];
}

export interface PostedTransaction {
  readonly transactionId: string;
  /** false when the idempotency key already existed with identical legs. */
  readonly created: boolean;
}

function assertPlain(name: string, value: string): void {
  try {
    parse(value);
  } catch {
    throw new LedgerInputError(`${name} must be a plain decimal string`);
  }
}

interface LegKey {
  readonly type: string;
  readonly currency: string;
  readonly amount: string;
}

/** Order-independent, scale-independent (1.5 equals 1.50000000) view of a set of legs. */
function canonical(legs: readonly LegKey[]): string[] {
  return legs.map((l) => `${l.type}|${l.currency}|${parse(l.amount).toString()}`).sort();
}

function mapDbError(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string; message?: string } | null;
  if (err?.code === '23514' && err.constraint === 'ledger_accounts_nonneg_chk') {
    return new InsufficientFundsError('insufficient funds: a balance would go below zero', {
      cause: e,
    });
  }
  if (
    typeof err?.message === 'string' &&
    /^ledger transaction .* unbalanced in /.test(err.message)
  ) {
    return new LedgerUnbalancedError('ledger transaction is unbalanced', { cause: e });
  }
  return e;
}

/**
 * Posts one ledger transaction. A failure rolls back to a savepoint, so nothing is posted and the
 * caller's transaction stays usable (the caller still decides whether to commit or roll back).
 */
export async function postTransaction(
  client: Queryable,
  input: PostTransactionInput,
): Promise<PostedTransaction> {
  if (input.legs.length === 0) throw new LedgerInputError('a transaction needs at least one leg');
  for (const l of input.legs) {
    assertPlain('leg amount', l.amount);
    if (isZero(parse(l.amount))) throw new LedgerInputError('a leg amount must not be zero');
    if (l.amountUsd !== undefined) assertPlain('leg amountUsd', l.amountUsd);
    if (l.amountUsd === undefined && l.currency !== 'USD') {
      throw new LedgerInputError('amountUsd is required for a non-USD leg');
    }
  }

  await client.query('SAVEPOINT ledger_post');
  try {
    const transactionId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (id, account_id, kind, idempotency_key, description, order_id, execution_id)
       VALUES ($1::uuid, $2::uuid, $3::ledger_tx_kind, $4, $5, $6::uuid, $7::uuid)
       ON CONFLICT (account_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        transactionId,
        input.accountId,
        input.kind,
        input.idempotencyKey,
        input.description ?? null,
        input.orderId ?? null,
        input.executionId ?? null,
      ],
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM ledger_transactions WHERE account_id = $1::uuid AND idempotency_key = $2`,
        [input.accountId, input.idempotencyKey],
      );
      const existingId = existing.rows[0]?.id;
      if (existingId === undefined) throw new LedgerInputError('idempotency lookup failed');
      const stored = await client.query<{ type: string; currency: string; amount: string }>(
        `SELECT la.type::text AS type, e.currency, e.amount
           FROM ledger_entries e JOIN ledger_accounts la ON la.id = e.ledger_account_id
          WHERE e.transaction_id = $1::uuid`,
        [existingId],
      );
      const same =
        JSON.stringify(canonical(stored.rows)) ===
        JSON.stringify(
          canonical(
            input.legs.map((l) => ({
              type: l.ledgerAccountType,
              currency: l.currency,
              amount: l.amount,
            })),
          ),
        );
      if (!same) {
        throw new IdempotencyConflictError(
          'idempotency key was already used with different legs; nothing was posted',
        );
      }
      await client.query('RELEASE SAVEPOINT ledger_post');
      return { transactionId: existingId, created: false };
    }

    const accounts = await client.query<{ id: string; type: string; currency: string }>(
      `SELECT id, type::text AS type, currency FROM ledger_accounts WHERE account_id = $1::uuid`,
      [input.accountId],
    );
    const idOf = new Map(accounts.rows.map((a) => [`${a.type}|${a.currency}`, a.id]));
    const entries = input.legs.map((l) => {
      const ledgerAccountId = idOf.get(`${l.ledgerAccountType}|${l.currency}`);
      if (ledgerAccountId === undefined) {
        throw new LedgerAccountNotFoundError(
          `account has no ${l.ledgerAccountType} ledger account in ${l.currency}`,
        );
      }
      return { ledgerAccountId, leg: l };
    });
    // One consistent lock order (by ledger account id) so concurrent multi-leg posts cannot deadlock.
    entries.sort((a, b) =>
      a.ledgerAccountId < b.ledgerAccountId ? -1 : a.ledgerAccountId > b.ledgerAccountId ? 1 : 0,
    );
    for (const { ledgerAccountId, leg } of entries) {
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, ledger_account_id, currency, amount, amount_usd)
         VALUES ($1::uuid, $2::uuid, $3, $4::numeric, $5::numeric)`,
        [transactionId, ledgerAccountId, leg.currency, leg.amount, leg.amountUsd ?? leg.amount],
      );
    }
    // Fail now, with a clear error, instead of at COMMIT.
    await client.query('SET CONSTRAINTS ledger_tx_balanced IMMEDIATE');
    await client.query('SET CONSTRAINTS ledger_tx_balanced DEFERRED');
    await client.query('RELEASE SAVEPOINT ledger_post');
    return { transactionId, created: true };
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT ledger_post');
    await client.query('RELEASE SAVEPOINT ledger_post');
    throw mapDbError(e);
  }
}

/** Posts the initial capital grant with the key `grant:<accountId>` (idempotent). */
export async function grantInitialCapital(
  client: Queryable,
  accountId: string,
): Promise<PostedTransaction> {
  const r = await client.query<{ initial_capital: string }>(
    `SELECT initial_capital FROM accounts WHERE id = $1::uuid`,
    [accountId],
  );
  const capital = r.rows[0]?.initial_capital;
  if (capital === undefined) throw new LedgerInputError('account not found');
  return postTransaction(client, {
    accountId,
    kind: 'GRANT',
    idempotencyKey: `grant:${accountId}`,
    description: 'Initial capital grant',
    legs: grantLegs({ amount: capital }),
  });
}
