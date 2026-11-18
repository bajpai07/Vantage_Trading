export class TradingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The same clientOrderId was used before with different parameters. Nothing was changed. */
export class ClientOrderIdMismatchError extends TradingError {}

/** Two requests with the same clientOrderId raced past the account lock (cannot happen under the lock). */
export class DuplicateClientOrderIdError extends TradingError {}

export class AccountNotFoundError extends TradingError {}

/** The order does not exist (or belongs to another account: the two are indistinguishable on purpose). */
export class OrderNotFoundError extends TradingError {}

/** A guarded transition updated no row: the order is no longer in the state the caller read (a lost race). */
export class LostRaceError extends TradingError {}

/** A fill with this idempotency key was already posted for an order that is still open: corruption, never silently ignored. */
export class FillAlreadyPostedError extends TradingError {}
