# Trading core (M4a)

`executeMarketOrder(client, command)` turns one MARKET order request into exact, permanent records of money and shares, inside the caller's open database transaction. Scope: MARKET orders (BUY and SELL), USD, synchronous fill (D-30, D-33, D-39): whole shares for US stocks and ETFs, and since M8 fractional quantities (up to 8 decimals) for crypto, see [Fractional quantities and exact cost basis](#fractional-quantities-and-exact-cost-basis-m8-d-85-to-d-90) below. HTTP endpoints are in [api.md](api.md) (M4b). Specs: TRADING_ENGINE sections 3, 4, 6, 7, 9, 11; DATABASE sections 7, 8, 11.

## Rule order (first failure wins)

`decideMarketOrder` in `@vantage/engine` is the only place that decides. A non-positive or unparsable quantity is malformed input, not an order: it throws and nothing is stored.

| #   | Code                        | When                                                                                                                                                               |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `TRADING_PAUSED`            | trading is disabled (admin kill switch)                                                                                                                            |
| 2   | `ACCOUNT_NOT_ACTIVE`        | the account or its user is not `ACTIVE`                                                                                                                            |
| 3   | `INSTRUMENT_NOT_TRADABLE`   | `tradable_in` lacks `MVP`, the instrument is `DELISTED`, or a BUY on `SELL_ONLY`                                                                                   |
| 4   | `INSTRUMENT_HALTED`         | status `HALTED`                                                                                                                                                    |
| 5   | `QTY_BELOW_MIN`             | quantity below the instrument minimum                                                                                                                              |
| 6   | `QTY_STEP_VIOLATION`        | quantity is not a multiple of the step (a fraction violates a step of 1; crypto steps are 0.00000001)                                                              |
| 7   | `NO_ELIGIBLE_QUOTE`         | freshness `UNAVAILABLE`, no quote, or `DELAYED` while `allowExecutionOnDelayed` is false                                                                           |
|     | `MARKET_CLOSED`             | freshness `CLOSED`                                                                                                                                                 |
|     | `STALE_QUOTE`               | freshness `STALE`                                                                                                                                                  |
| 8   | `PRICE_MOVED`               | the price moved against the user by more than the collar: 1% for stocks and ETFs, 2% for crypto (D-51, D-88)                                                       |
| 8b  | `QTY_BELOW_MIN`             | (M8) a BUY whose cost rounds to 0 at 8 decimals is too small to price; same code, checked right after the price rule, so the code list and its order are unchanged |
| 9   | `INSUFFICIENT_BUYING_POWER` | BUY: cash is less than notional + fee                                                                                                                              |
|     | `INSUFFICIENT_POSITION`     | SELL: position is smaller than the quantity                                                                                                                        |
| 10  | `FEE_EXCEEDS_PROCEEDS`      | SELL: the commission is larger than the proceeds (D-57); checked after the position                                                                                |

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

| Invariant                                                                                                                        | Database constraint                                   | Deferred trigger (D-53)                             | Reconciliation (`reconcileAccount`, trading checks on by default) |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| I1 every ledger transaction balances per currency                                                                                | no zero entries                                       | `ledger_tx_balanced`                                | yes                                                               |
| I2 stored balance = sum of entries                                                                                               | `apply_entry` trigger                                 |                                                     | yes                                                               |
| I3 cash, reserved, position cost never negative                                                                                  | `CHECK` on `ledger_accounts`                          |                                                     | yes                                                               |
| I4 `positions.qty` = sum of open lot quantities; `closed_at` set iff `qty_open = 0`                                              | `qty_open <= qty_initial`, column-limited lot updates | `position_lots_consistent`, `positions_consistent`  | yes                                                               |
| I5 `filled_qty` = sum of executions; FILLED fully filled; REJECTED has no fills; executions match their order and ledger account | `filled_qty <= qty`                                   | `orders_consistent`, `executions_order_consistent`  | yes                                                               |
| I6 every execution has exactly one ledger transaction of its account, none shared                                                | `UNIQUE (ledger_tx_id)`, `UNIQUE (order_id, seq)`     | (part of I5)                                        | yes (an execution without one, or one shared)                     |
| Position cost: `POSITION_COST` balance = sum of `cost_remaining` over lots (D-85; zero tolerance)                                | `cost_remaining >= 0`; column-limited lot updates     | I4 trigger: `cost_remaining = 0` iff `qty_open = 0` | yes, exact                                                        |
| Realised P&L: `REALIZED_PNL` = -(sum of lot closure P&L); positions cache agrees                                                 |                                                       |                                                     | yes, exact                                                        |
| Executions, order events, lot closures, fee schedules, orders never change                                                       | `forbid_mutation` triggers; no UPDATE/DELETE grants   |                                                     |                                                                   |
| I10 one grant = initial capital; `CAPITAL` = -grants; conservation per currency                                                  |                                                       |                                                     | yes                                                               |

`reconcileAccount` checks the trading tables **by default** (D-56). The opt-out `{ trading: false }` exists only for the old M1 ledger-only tests, which post `FILL` transactions with no lots; no account that trades may be reconciled without the trading checks. The reverse check (a `FILL` ledger transaction with no execution) is not made for the same reason.

## HTTP layer (M4b)

Endpoints, examples and error codes: [api.md](api.md). Decisions D-55 to D-59 are in specs/DECISIONS.md.

- **Server decides (D-59).** `OrdersService.place` resolves the account (the session user's MAIN account), the instrument by symbol (unknown: 404), the quote and freshness (`QuoteService.snapshotFor`, which uses only the shared `freshness()`), the fee schedule (exchange-specific first, else the latest global version effective at `now`), `TRADING_ENABLED` and the time from the injected clock. The client sends symbol, side, qty, type and `referencePrice` only.
- **Idempotency (D-58).** The `Idempotency-Key` header is stored as `orders.client_order_id`. Flow: look up `(account, key)` (one query together with the account lookup); the same canonical request hash returns the stored status and body; a different hash is 422 `IDEMPOTENCY_MISMATCH`; otherwise one transaction: lock the account, re-check the key (a concurrent twin may have committed), `executeMarketOrder`, insert the idempotency row with the response, commit. The row and the order commit together or not at all. 50 parallel identical requests produce one fill.
- **`DUPLICATE_CLIENT_ORDER_ID` is an unreachable guard.** The key row and the order are written in one transaction under the account lock, so an order with an existing client order id cannot appear without its key row. The executor's own replay check and the `UNIQUE (account_id, client_order_id)` index remain as second guards; if one ever fires through HTTP it maps to 409.
- **New reject code (D-57).** `FEE_EXCEEDS_PROCEEDS` is rule 10: a SELL whose fee is larger than its proceeds. A fee equal to the proceeds still fills.
- **Rate limit.** 30 orders per user per minute (in memory, per process; `ORDER_RATE_LIMIT_PER_MINUTE`).
- **Round trips.** A first-time FILL costs 29 database round trips (session, account and key lookup, instrument and fee schedule, BEGIN, lock, key re-check, status, replay check, cash lock and read, position, lots, the ledger post, order, the three events in one statement, execution, lot or closures, position, idempotency row, COMMIT, audit). The executor does not repeat the account lock the service already took (`accountLocked`).

## Order preview is advisory (M6b, D-70)

`POST /v1/orders/preview` runs the same `decideForCommand` (the engine's `decideMarketOrder` with the same input mapping the executor uses) on a plain read of the current state: one read-only `REPEATABLE READ` transaction, **no locks, no writes, nothing stored, no audit row**. So a preview can never use different rules from the real order, never blocks it, and never changes money. It is **not a promise**: between the preview and the order the quote, the cash or the position may change, and the real order decides again under its account locks. The estimates after a reject that comes after the price check (price moved, not enough cash or shares, fee above proceeds) show what the order would have cost; earlier rejects have no honest price, so their estimates are `null`. Tests prove that the preview equals the real fill for the four golden vectors and for random orders, that it equals the reject code for all 13 codes, and that it writes and locks nothing.

## Fractional quantities and exact cost basis (M8, D-85 to D-90)

M8 lets a user trade crypto (BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD, BNB-USD) with fractional quantities, market orders only, 24/7 on the simulated feed. Stocks and ETFs keep a step of 1: a fractional stock quantity is a `QTY_STEP_VIOLATION` decided by the server (the browser only blocks the obvious). Amendment to TRADING_ENGINE section 1 and decision D5 ("whole shares in the MVP", D-87): the whole-share rule stays for stocks and ETFs; crypto is fractional. The spec text itself is unchanged.

**Why exactness still holds (D-85).** With whole shares the old argument was that `qty x tick price` is exact. With fractions it is not (a lot of 0.3 that cost 27.01 cannot be split into three equal tenths in 8 decimals). So exactness is now built in by construction:

- `position_lots.cost_remaining numeric(38,8)` is the total cost basis of the REMAINING quantity of a lot. The invariant is `POSITION_COST` ledger balance = sum of `cost_remaining` over the lots, always, compared with zero tolerance by `reconcileAccount`. `cost_local_per_unit` is kept as informational data.
- A BUY sets `cost_remaining` to the number that is posted to the ledger as `POSITION_COST` (the executor reads it from the posted leg: one number, one formula).
- A SELL that takes `q` of a lot with quantity `Q` and cost `R` consumes exactly `R` when `q = Q` (by subtraction), and `round8(R x q / Q)` (HALF_EVEN) otherwise. The consumed costs of the sale are the basis `B` posted to the ledger, so the ledger and the lots can never drift: cost is conserved exactly (sum consumed + sum remaining = sum before).
- CLAMP (a corner the rule above does not cover): the database requires `cost_remaining = 0` iff `qty_open = 0`. A partial piece whose rounded share would equal the whole remaining cost consumes one smallest unit (0.00000001) less, so a lot that keeps quantity keeps cost. It can only happen when a lot's remaining cost is a few smallest units.
- Proceeds are allocated over the consumed lots by quantity, every piece but the last rounded (one division, no double rounding), the last by subtraction. The position's `avg_cost_local` is `sum(cost_remaining) / sum(qty_open)` at 8 decimals.
- The `position_lots` UPDATE trigger and the column grant now allow `qty_open`, `cost_remaining` and `closed_at` to change and nothing else; the deferred I4 trigger also checks `cost_remaining >= 0` and `cost_remaining = 0` iff `qty_open = 0` at commit.

**Quantities (D-86).** The request quantity is a decimal string with at most 8 decimals (1 to 7 integer digits, at most 1,000,000), normalised to one canonical spelling (`0.0025000` is `0.0025`, `10.0` is `10`) so the idempotency hash is stable. Exponents, signs, `NaN`, a leading dot, a trailing dot, leading zeros and more than 8 decimals are `400 VALIDATION_ERROR`. `QTY_BELOW_MIN` and `QTY_STEP_VIOLATION` stay the reject codes (checked against the instrument's `min_qty` and `qty_step`); too large is a validation error (no `QTY_ABOVE_MAX`: the maximum is a contract limit, the spec has no equivalent reject).

**Crypto parameters (D-88, illustrative).** `fee_schedules` gets a new immutable CRYPTO version 2 (migration 0027; version 1, the M7a placeholder, stays): taker commission 10 bps, no minimum fee, base slippage 5 bps, size coefficient 0, model `QBX-1/r8he`, fee rounding 8 decimals HALF_EVEN. The collar is 2% (TRADING_ENGINE section 6). No minimum notional (a BUY that costs 0 at 8 decimals is rejected as too small, see rule 8b). Crypto uses the 24/7 session of M7a: no `MARKET_CLOSED` while the feed is live; `STALE_QUOTE` and `NO_ELIGIBLE_QUOTE` still reject. These numbers are starting values for tuning, not research constants.

**Tradability (D-89).** Migration 0027 adds the `MVP` gate to `tradable_in` of the seeded crypto instruments (and the simulated instrument master now writes it). `INSTRUMENT_NOT_TRADABLE` still protects any instrument without it.

**The maximum quantity (D-90).** The preview response has `maxQty` (a string, or null): for a BUY the largest quantity, rounded down to the instrument step, whose notional plus fee the cash covers at the estimated price (an exact binary search over steps on top of the same `priceOrder` pricing the decision uses); for a SELL the position quantity. "0" when not even the minimum fits, null when it cannot be known (no usable quote, not tradable, paused: the decision is asked about the candidate and must say FILL). The browser only fills this string into the form.

**Golden vectors** (BTC-USD bid 89,990.00, ask 90,010.00, slippage 5 bps, commission 10 bps, grant 10,000; hard-coded in the tests, never computed by the code under test):

| Step           | Fill price | Notional   | Fee        | Consumed cost | Ledger legs                                                                           | Cash after     |
| -------------- | ---------- | ---------- | ---------- | ------------- | ------------------------------------------------------------------------------------- | -------------- |
| A: BUY 0.0025  | 90,055.01  | 225.137525 | 0.22513752 |               | CASH -225.36266252, POSITION_COST +225.137525, FEES +0.22513752                       | 9,774.63733748 |
| B: SELL 0.001  | 89,945.00  | 89.945     | 0.089945   | 90.05501      | CASH +89.855055, FEES +0.089945, POSITION_COST -90.05501, REALIZED_PNL +0.11001       | 9,864.49239248 |
| C: SELL 0.0015 | 89,945.00  | 134.9175   | 0.1349175  | 135.082515    | CASH +134.7825825, FEES +0.1349175, POSITION_COST -135.082515, REALIZED_PNL +0.165015 | 9,999.27497498 |

A: 90,010.00 x 1.0005 = 90,055.005 rounds UP to the tick; the fee 0.225137525 is an exact tie and 8-decimal HALF_EVEN keeps the even digit 2. B: 89,990.00 x 0.9995 = 89,945.005 rounds DOWN; the consumed cost is 225.137525 x 0.001 / 0.0025 = 90.05501 exactly; the lot keeps 0.0015 with `cost_remaining` 135.082515 (average 90,055.01). C: the lot is fully consumed by subtraction. Total equity change -0.72502502 = fees 0.45000002 + realised loss 0.275025. D (cost rounding): a lot of 0.3 costing 27.01 sold in three pieces of 0.1 consumes 9.00333333, then 9.00333334 (18.00666667 x 0.1 / 0.2 = 9.003333335 is an exact tie, HALF_EVEN rounds to the even neighbour), then the last 9.00333333 by subtraction: 27.01 in total.

## What comes next

Limit and stop orders, reservations, cancel, the async matcher, the account-event outbox, the purge of idempotency rows after 48 hours, portfolio valuation and P&L (M5).
