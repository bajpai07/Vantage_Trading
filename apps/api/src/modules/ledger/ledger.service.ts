import { Injectable, Module } from '@nestjs/common';
import { createAccount, grantInitialCapital, postTransaction, reconcileAccount } from './index.js';
import type {
  CreateAccountInput,
  CreatedAccount,
  PostedTransaction,
  PostTransactionInput,
  Queryable,
  ReconcileOptions,
  Violation,
} from './index.js';

/** Nest wrapper around the M1 ledger repository. Every method takes a client with an open transaction. */
@Injectable()
export class LedgerService {
  createAccount(client: Queryable, input: CreateAccountInput): Promise<CreatedAccount> {
    return createAccount(client, input);
  }
  grantInitialCapital(client: Queryable, accountId: string): Promise<PostedTransaction> {
    return grantInitialCapital(client, accountId);
  }
  postTransaction(client: Queryable, input: PostTransactionInput): Promise<PostedTransaction> {
    return postTransaction(client, input);
  }
  reconcileAccount(
    client: Queryable,
    accountId: string,
    options?: ReconcileOptions,
  ): Promise<Violation[]> {
    return reconcileAccount(client, accountId, options);
  }
}

@Module({ providers: [LedgerService], exports: [LedgerService] })
export class LedgerModule {}
