// Read-only checks of invariants I1, I2, I3 and I10 for one account (DATABASE section 13,
// TRADING_ENGINE section 11). An empty result means the account is clean.
import { negate, parse } from '@vantage/money';
import type { Queryable } from './repository.js';
import { reconcileTrading } from './reconcile-trading.js';

export interface Violation {
  readonly invariant:
    'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I10' | 'POSITION_COST' | 'REALIZED_PNL';
  readonly message: string;
}

async function reconcileLedger(client: Queryable, accountId: string): Promise<Violation[]> {
  const out: Violation[] = [];

  // I1: every ledger transaction balances to zero per currency.
  const i1 = await client.query<{ transaction_id: string; currency: string; s: string }>(
    `SELECT e.transaction_id, e.currency, SUM(e.amount) AS s
       FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.account_id = $1::uuid
      GROUP BY 1, 2 HAVING SUM(e.amount) <> 0`,
    [accountId],
  );
  for (const r of i1.rows) {
    out.push({
      invariant: 'I1',
      message: `transaction ${r.transaction_id} is unbalanced in ${r.currency} by ${r.s}`,
    });
  }

  // I2: stored balance equals the sum of entries.
  const i2 = await client.query<{ id: string; type: string; balance: string; s: string }>(
    `SELECT la.id, la.type::text AS type, la.balance, COALESCE(e.s, 0) AS s
       FROM ledger_accounts la
       LEFT JOIN (SELECT ledger_account_id, SUM(amount) AS s FROM ledger_entries
                   WHERE ledger_account_id IN (SELECT id FROM ledger_accounts WHERE account_id = $1::uuid)
                   GROUP BY 1) e ON e.ledger_account_id = la.id
      WHERE la.account_id = $1::uuid AND la.balance <> COALESCE(e.s, 0)`,
    [accountId],
  );
  for (const r of i2.rows) {
    out.push({
      invariant: 'I2',
      message: `ledger account ${r.id} (${r.type}) stores ${r.balance} but its entries sum to ${r.s}`,
    });
  }

  // I3: CASH, RESERVED and POSITION_COST are never negative.
  const i3 = await client.query<{ id: string; type: string; balance: string }>(
    `SELECT id, type::text AS type, balance FROM ledger_accounts
      WHERE account_id = $1::uuid AND type IN ('CASH','RESERVED','POSITION_COST') AND balance < 0`,
    [accountId],
  );
  for (const r of i3.rows) {
    out.push({
      invariant: 'I3',
      message: `ledger account ${r.id} (${r.type}) is negative: ${r.balance}`,
    });
  }

  // I10 (part 1): conservation per currency: all balances of one currency sum to zero.
  const cons = await client.query<{ currency: string; s: string }>(
    `SELECT currency, SUM(balance) AS s FROM ledger_accounts
      WHERE account_id = $1::uuid GROUP BY currency HAVING SUM(balance) <> 0`,
    [accountId],
  );
  for (const r of cons.rows) {
    out.push({ invariant: 'I10', message: `balances in ${r.currency} sum to ${r.s}, not zero` });
  }

  // I10 (part 2): exactly one GRANT for a MAIN account, equal to initial_capital; CAPITAL = -grants.
  const acct = await client.query<{ kind: string; initial_capital: string }>(
    `SELECT kind::text AS kind, initial_capital FROM accounts WHERE id = $1::uuid`,
    [accountId],
  );
  const account = acct.rows[0];
  if (account === undefined) {
    out.push({ invariant: 'I10', message: 'account does not exist' });
    return out;
  }
  const grants = await client.query<{ n: string; total: string }>(
    `SELECT COUNT(DISTINCT t.id) AS n, COALESCE(-SUM(e.amount), 0) AS total
       FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id = t.id
       JOIN ledger_accounts la ON la.id = e.ledger_account_id AND la.type = 'CAPITAL'
      WHERE t.account_id = $1::uuid AND t.kind IN ('GRANT','COMPETITION_GRANT')`,
    [accountId],
  );
  const mainGrants = await client.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM ledger_transactions WHERE account_id = $1::uuid AND kind = 'GRANT'`,
    [accountId],
  );
  const total = parse(grants.rows[0]?.total ?? '0');
  if (account.kind === 'MAIN') {
    if (mainGrants.rows[0]?.n !== '1') {
      out.push({
        invariant: 'I10',
        message: `a MAIN account needs exactly one GRANT, found ${mainGrants.rows[0]?.n ?? '0'}`,
      });
    }
    if (!total.equals(parse(account.initial_capital))) {
      out.push({
        invariant: 'I10',
        message: `grants total ${total.toString()} but initial_capital is ${parse(account.initial_capital).toString()}`,
      });
    }
  }
  const capital = await client.query<{ balance: string }>(
    `SELECT balance FROM ledger_accounts WHERE account_id = $1::uuid AND type = 'CAPITAL' AND currency = 'USD'`,
    [accountId],
  );
  const capitalBalance = capital.rows[0]?.balance;
  if (capitalBalance === undefined || !parse(capitalBalance).equals(negate(total))) {
    out.push({
      invariant: 'I10',
      message: `CAPITAL balance ${capitalBalance ?? '(missing)'} does not equal minus the grants (${negate(total).toString()})`,
    });
  }
  return out;
}

export interface ReconcileOptions {
  /**
   * Also check the trading tables (I4, I5, I6, position cost, realised P&L), with zero tolerance.
   * ON BY DEFAULT (D-56). `{ trading: false }` is an explicit opt-out used only by the old M1 ledger-only tests,
   * which post FILL ledger transactions without any orders or lots. No account that trades may be reconciled
   * without the trading checks.
   */
  readonly trading?: boolean;
}

/** Read-only. Returns the violations; an empty list means the account is clean. */
export async function reconcileAccount(
  client: Queryable,
  accountId: string,
  options: ReconcileOptions = {},
): Promise<Violation[]> {
  const out = await reconcileLedger(client, accountId);
  if (options.trading !== false) out.push(...(await reconcileTrading(client, accountId)));
  return out;
}
