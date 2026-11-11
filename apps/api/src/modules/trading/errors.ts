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
