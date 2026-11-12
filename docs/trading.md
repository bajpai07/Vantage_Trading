# Trading core (M4a)

`executeMarketOrder(client, command)` turns one MARKET order request into exact, permanent records of money and shares, inside the caller's open database transaction. Scope: MARKET orders (BUY and SELL), whole shares, US stocks and ETFs, USD, synchronous fill (D-30, D-33, D-39). There are no HTTP endpoints yet (M4b). Specs: TRADING_ENGINE sections 3, 4, 6, 7, 9, 11; DATABASE sections 7, 8, 11.

## Rule order (first failure wins)

`decideMarketOrder` in `@vantage/engine` is the only place that decides. A non-positive or unparsable quantity is malformed input, not an order: it throws and nothing is stored.

| #   | Code                        | When                                                                                     |
| --- | --------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | `TRADING_PAUSED`            | trading is disabled (admin kill switch)                                                  |
| 2   | `ACCOUNT_NOT_ACTIVE`        | the account or its user is not `ACTIVE`                                                  |
| 3   | `INSTRUMENT_NOT_TRADABLE`   | `tradable_in` lacks `MVP`, the instrument is `DELISTED`, or a BUY on `SELL_ONLY`         |
| 4   | `INSTRUMENT_HALTED`         | status `HALTED`                                                                          |
| 5   | `QTY_BELOW_MIN`             | quantity below the instrument minimum                                                    |
| 6   | `QTY_STEP_VIOLATION`        | quantity is not a multiple of the step (fractions violate a step of 1)                   |
| 7   | `NO_ELIGIBLE_QUOTE`         | freshness `UNAVAILABLE`, no quote, or `DELAYED` while `allowExecutionOnDelayed` is false |
|     | `MARKET_CLOSED`             | freshness `CLOSED`                                                                       |
|     | `STALE_QUOTE`               | freshness `STALE`                                                                        |
| 8   | `PRICE_MOVED`               | the price moved against the user by more than the 1% collar (D-51)                       |
| 9   | `INSUFFICIENT_BUYING_POWER` | BUY: cash is less than notional + fee                                                    |
|     | `INSUFFICIENT_POSITION`     | SELL: position is smaller than the quantity                                              |
| 10  | `FEE_EXCEEDS_PROCEEDS`      | SELL: the commission is larger than the proceeds (D-57); checked after the position      |

Rejects are **persisted** (D-50): an order row with status `REJECTED` and its `reject_code`, an `order_events` trail (`CREATED`, `REJECTED` with the facts used) and nothing else: no ledger entries, execution, lot or position change.

## Price and fee formulas

- BUY fill price = `ask x (1 + bps/10000)` rounded **up** to the tick; SELL = `bid x (1 - bps/10000)` rounded **down** (`fillPrice`, the single place a price is computed). `bps` is the schedule's base slippage (2 bps in v1; the size term is 0 because there is no ADV data).
- `notional = round8(qty x price)`. `fee = round8(max(notional x commission_bps / 10000, minimum))`, HALF_EVEN. Fees are expensed to the `FEES` account and are **not** part of lot cost.
- Collar (D-51): BUY rejects when `ask x 100 > reference x 101`; SELL rejects when `bid x 100 < reference x 99`. Favourable moves are accepted.
- D-52: prices are multiples of 0.01 and shares are whole, so notional and lot arithmetic are exact; reconciliation uses zero tolerance.

### Golden vectors (quote AAPL bid 189.95, ask 190.00, slippage 2 bps; hard-coded in the tests)

| Case                                                                | Result                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BUY 10                                                              | 190.00 x 1.0002 = 190.038 -> **190.04**; notional 1,900.40; fee 0; `CASH -1900.40`, `POSITION_COST +1900.40`; cash after the 10,000 grant **8,099.60**        |
| SELL 10 at bid 195.00                                               | 195.00 x 0.9998 = 194.961 -> **194.96**; proceeds 1,949.60; basis 1,900.40; realised **+49.20**; cash **10,049.20**; `REALIZED_PNL -49.20`                    |
| BUY 10, 10 bps commission                                           | fee **1.9004**; `CASH -1902.3004`, `FEES +1.9004`, `POSITION_COST +1900.40`; cash **8,097.6996**                                                              |
| FIFO: buy 3 at ask 100.00, buy 2 at ask 101.00, sell 4 at bid 99.00 | prices 100.02, **101.03**, **98.98**; basis 300.06 + 101.03 = **401.09**; proceeds 395.92 (296.94 + 98.98); realised **-5.17**; lot 2 keeps 1 share at 101.03 |

## Transaction steps and lock order

1. **Lock the `accounts` row** (`lock_account_for_order`, returns nothing), always first, then read the account and user status with a new statement. All order processing for one account is serialised by it.
2. **Replay check**: an order with the same `(account_id, clientOrderId)` returns the stored result when the parameters match, and throws `ClientOrderIdMismatchError` when they differ. It never fills twice.
3. **Lock the `CASH` ledger row** (`lock_cash_balance`, returns nothing) and read the balance, then the **position row**, then the **open lots** ordered by `(opened_at, id)`.
4. Decide. A REJECT inserts the `REJECTED` order and its events and stops.
5. A FILL posts the ledger transaction (`FILL`, key `fill:<orderId>:1`, through the M1 repository with the engine's balanced legs), inserts the order (`FILLED`), the execution (every column, including the quote used and `model_version`), the lot (BUY) or the lot updates and `lot_closures` (SELL, FIFO), the position, and the order events (`CREATED`, `ACCEPTED`, `FILLED`, contiguous `seq`).

Any unexpected error aborts the whole transaction; the caller rolls back. Nothing is swallowed.

Why two lock functions (D-55): PostgreSQL requires the UPDATE privilege for any row-locking clause, and `vantage_app` deliberately has no UPDATE on `accounts` or `ledger_accounts`. Two narrow `SECURITY DEFINER` functions (migrations 0020 and 0022) take exactly those two locks, so the app gains no table privilege. Conditions, proven by a test: they only lock and **return nothing** (the caller reads status and balance with a normal SELECT after the lock), `EXECUTE` is revoked from PUBLIC and granted only to `vantage_app`, and the `search_path` is fixed. Known trade-off: the app role can take the row lock of any account through them (a denial-of-service lever for a compromised app, not a data or money risk).

## Invariants and where each is enforced

| Invariant                                                                                                                        | Database constraint                                   | Deferred trigger (D-53)                            | Reconciliation (`reconcileAccount`, trading checks on by default) |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| I1 every ledger transaction balances per currency                                                                                | no zero entries                                       | `ledger_tx_balanced`                               | yes                                                               |
| I2 stored balance = sum of entries                                                                                               | `apply_entry` trigger                                 |                                                    | yes                                                               |
| I3 cash, reserved, position cost never negative                                                                                  | `CHECK` on `ledger_accounts`                          |                                                    | yes                                                               |
| I4 `positions.qty` = sum of open lot quantities; `closed_at` set iff `qty_open = 0`                                              | `qty_open <= qty_initial`, column-limited lot updates | `position_lots_consistent`, `positions_consistent` | yes                                                               |
| I5 `filled_qty` = sum of executions; FILLED fully filled; REJECTED has no fills; executions match their order and ledger account | `filled_qty <= qty`                                   | `orders_consistent`, `executions_order_consistent` | yes                                                               |
| I6 every execution has exactly one ledger transaction of its account, none shared                                                | `UNIQUE (ledger_tx_id)`, `UNIQUE (order_id, seq)`     | (part of I5)                                       | yes (an execution without one, or one shared)                     |
| Position cost: `POSITION_COST` balance = sum of `qty_open x cost` over lots                                                      |                                                       |                                                    | yes, exact                                                        |
| Realised P&L: `REALIZED_PNL` = -(sum of lot closure P&L); positions cache agrees                                                 |                                                       |                                                    | yes, exact                                                        |
| Executions, order events, lot closures, fee schedules, orders never change                                                       | `forbid_mutation` triggers; no UPDATE/DELETE grants   |                                                    |                                                                   |
| I10 one grant = initial capital; `CAPITAL` = -grants; conservation per currency                                                  |                                                       |                                                    | yes                                                               |

`reconcileAccount` checks the trading tables **by default** (D-56). The opt-out `{ trading: false }` exists only for the old M1 ledger-only tests, which post `FILL` transactions with no lots; no account that trades may be reconciled without the trading checks. The reverse check (a `FILL` ledger transaction with no execution) is not made for the same reason.

## HTTP layer (M4b)

Endpoints, examples and error codes: [api.md](api.md). Decisions D-55 to D-59 are in specs/DECISIONS.md.

- **Server decides (D-59).** `OrdersService.place` resolves the account (the session user's MAIN account), the instrument by symbol (unknown: 404), the quote and freshness (`QuoteService.snapshotFor`, which uses only the shared `freshness()`), the fee schedule (exchange-specific first, else the latest global version effective at `now`), `TRADING_ENABLED` and the time from the injected clock. The client sends symbol, side, qty, type and `referencePrice` only.
- **Idempotency (D-58).** The `Idempotency-Key` header is stored as `orders.client_order_id`. Flow: look up `(account, key)` (one query together with the account lookup); the same canonical request hash returns the stored status and body; a different hash is 422 `IDEMPOTENCY_MISMATCH`; otherwise one transaction: lock the account, re-check the key (a concurrent twin may have committed), `executeMarketOrder`, insert the idempotency row with the response, commit. The row and the order commit together or not at all. 50 parallel identical requests produce one fill.
- **`DUPLICATE_CLIENT_ORDER_ID` is an unreachable guard.** The key row and the order are written in one transaction under the account lock, so an order with an existing client order id cannot appear without its key row. The executor's own replay check and the `UNIQUE (account_id, client_order_id)` index remain as second guards; if one ever fires through HTTP it maps to 409.
- **New reject code (D-57).** `FEE_EXCEEDS_PROCEEDS` is rule 10: a SELL whose fee is larger than its proceeds. A fee equal to the proceeds still fills.
- **Rate limit.** 30 orders per user per minute (in memory, per process; `ORDER_RATE_LIMIT_PER_MINUTE`).
- **Round trips.** A first-time FILL costs 29 database round trips (session, account and key lookup, instrument and fee schedule, BEGIN, lock, key re-check, status, replay check, cash lock and read, position, lots, the ledger post, order, the three events in one statement, execution, lot or closures, position, idempotency row, COMMIT, audit). The executor does not repeat the account lock the service already took (`accountLocked`).

## What comes next

Limit and stop orders, reservations, cancel, the async matcher, the account-event outbox, the purge of idempotency rows after 48 hours, portfolio valuation and P&L (M5).
