import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { AccountResponse } from '@vantage/contracts';
import { parse } from '@vantage/money';
import { newId } from '../../ids.js';
import { CLOCK, POOL } from '../../tokens.js';
import type { Clock } from '../../tokens.js';
import { LedgerService } from '../ledger/ledger.service.js';

/** The starting balance: a real ledger GRANT of 10,000 USD (PRD, FR-ID-4). */
export const INITIAL_CAPITAL = '10000';

@Injectable()
export class AccountsService {
  constructor(
    @Inject(POOL) private readonly pool: pg.Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  /**
   * Creates the MAIN account, its ledger accounts and the GRANT inside the caller's transaction.
   * If any step fails the caller rolls back and nothing exists afterwards.
   */
  async createMainAccount(client: Pick<pg.ClientBase, 'query'>, userId: string): Promise<string> {
    const accountId = newId();
    await this.ledger.createAccount(client, {
      accountId,
      userId,
      kind: 'MAIN',
      initialCapital: INITIAL_CAPITAL,
    });
    await this.ledger.grantInitialCapital(client, accountId);
    return accountId;
  }

  /** The caller's own MAIN account. There is no account id in the request, so nobody can ask for another's. */
  async getAccountForUser(userId: string): Promise<AccountResponse | undefined> {
    const r = await this.pool.query<{ initial_capital: string; cash: string }>(
      `SELECT a.initial_capital, la.balance AS cash
         FROM accounts a
         JOIN ledger_accounts la ON la.account_id = a.id AND la.type = 'CASH' AND la.currency = 'USD'
        WHERE a.user_id = $1::uuid AND a.kind = 'MAIN'`,
      [userId],
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    const cash = parse(row.cash).toCanonicalString();
    return {
      currency: 'USD',
      cash,
      equity: cash, // no positions yet: equity equals cash
      initialCapital: parse(row.initial_capital).toCanonicalString(),
      asOf: this.clock.now().toISOString(),
    };
  }
}
