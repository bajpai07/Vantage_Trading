export class LedgerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A balance CHECK failed (cash, reserved or position cost would go below zero). Nothing was posted. */
export class InsufficientFundsError extends LedgerError {}

/** The legs do not sum to zero per currency. Nothing was posted. */
export class LedgerUnbalancedError extends LedgerError {}

/** The idempotency key was used before with different legs. Nothing was posted. */
export class IdempotencyConflictError extends LedgerError {}

/** A leg names a ledger account (type and currency) that the account does not have. */
export class LedgerAccountNotFoundError extends LedgerError {}

/** The input to a repository function is malformed (bad amount, no legs, ...). */
export class LedgerInputError extends LedgerError {}
