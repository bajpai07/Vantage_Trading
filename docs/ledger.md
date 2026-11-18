# Ledger (M1)

Source of truth: DATABASE section 6, TRADING_ENGINE section 5. Money is exact decimal (`@vantage/money`); every amount crosses a boundary as a string.

## Sign convention

- An entry's signed `amount` is **added** to its ledger account balance: `+` increases, `-` decreases.
- A transaction is balanced when, **per currency**, its entries sum to exactly zero.
- `CASH`, `RESERVED` and `POSITION_COST` can never be negative (database CHECK `ledger_accounts_nonneg_chk`). `CAPITAL` is normally negative (credit). `REALIZED_PNL` is negative when there is a profit. `FEES` is positive (expense).
- Zero entries are forbidden (`CHECK (amount <> 0)`), so recipes leave zero legs out.

## Rules enforced by the database

- **The app role has no UPDATE, DELETE or TRUNCATE** on any table. It can `SELECT` and (on a few tables) `INSERT`.
- **Balances change only through entries.** `apply_entry()` is `SECURITY DEFINER` (owned by the migrator, fixed `search_path`, `EXECUTE` revoked from PUBLIC) and updates `ledger_accounts.balance` after each entry insert. The entry currency must match its ledger account.
- `ledger_transactions`, `ledger_entries` and `fx_rates` are append-only even for the table owner: row triggers block UPDATE and DELETE, statement triggers block TRUNCATE.
- A deferred constraint trigger (`ledger_tx_balanced`) rejects an unbalanced transaction at commit. The repository also runs `SET CONSTRAINTS ledger_tx_balanced IMMEDIATE` so the error is raised at once.
- A new ledger account must start at balance 0.

## Recipes (pure, in `packages/engine`)

All amounts are rounded to 8 decimal places, HALF_EVEN, **once per leg**; the cash leg is derived from already-rounded values so the legs sum to exactly zero.

| Recipe                                     | Legs                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `grantLegs({ amount })`                    | `CASH +A`, `CAPITAL -A`                                                                    |
| `buyFillLegs({ qty, price, fee })`         | `C = round8(qty x price)`, `f = round8(fee)`: `CASH -(C+f)`, `POSITION_COST +C`, `FEES +f` |
| `sellFillLegs({ qty, price, fee, basis })` | `P`, `f`, `B` rounded: `CASH +(P-f)`, `FEES +f`, `POSITION_COST -B`, `REALIZED_PNL -(P-B)` |

Market fills are synchronous (D-39): no `RESERVED` movement. USD only. M8b-1 adds the reservation recipes for resting LIMIT orders:

| Recipe                                                          | Legs                                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `reserveLegs({ amount })` (ORDER_RESERVE, a limit BUY accepted) | `CASH -R`, `RESERVED +R`                                                                                                                    |
| `releaseLegs({ amount })` (ORDER_RELEASE, cancel or expiry)     | `RESERVED -R`, `CASH +R`, with R the STORED `orders.reserved_usd`, never recomputed                                                         |
| `buyFillFromReserveLegs({ qty, price, fee, reserved })`         | `C = round8(qty x price)`, `f`: `RESERVED -R`, `POSITION_COST +C`, `FEES +f`, `CASH +(R - C - f)` (zero leg omitted); requires `C + f <= R` |

A limit SELL moves no ledger account: it reserves quantity (`positions.qty_reserved`), and its fill uses the ordinary `sellFillLegs`.

Vectors (BTC-USD, 5 bps slippage, 10 bps commission, grant 10,000; hard-coded in the tests):

| Step                                                          | Legs                                                                                                   | Cash after             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------- |
| E: BUY 0.0025 LIMIT 89,900.00 accepted (R = 224.75 + 0.22475) | `CASH -224.97475`, `RESERVED +224.97475`                                                               | 9,775.02525            |
| E: filled at 89,894.93 (C 224.737325, f 0.22473732)           | `RESERVED -224.97475`, `POSITION_COST +224.737325`, `FEES +0.22473732`, `CASH +0.01268768`             | 9,775.03793768         |
| F: marketable at accept, fills at the limit 89,900.00         | ORDER_RESERVE as above, then `RESERVED -224.97475`, `POSITION_COST +224.75`, `FEES +0.22475` (CASH +0) | 9,775.02525            |
| G: resting SELL 0.001 LIMIT 90,100.00 filled at the limit     | `CASH +90.0099`, `FEES +0.0901`, `POSITION_COST -90.05501`, `REALIZED_PNL -0.04499`                    | (cash moves only here) |
| H: cancel or expire of E's accept                             | `RESERVED -224.97475`, `CASH +224.97475`                                                               | 10,000                 |

Invariants with a reservation (zero tolerance, `reconcileAccount`): I3 `CASH`, `RESERVED` and `POSITION_COST` are never negative; **I7** the `RESERVED` balance equals the sum of `reserved_usd` over the open orders; I4' `positions.qty_reserved` equals the remaining quantity of the open SELL orders; I5' a terminal order has `reserved_usd = 0`; I10 conservation includes `RESERVED`.

### Golden vectors (hard-coded in the tests; each sums to zero)

| Vector                                    | Legs                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| Grant 10,000                              | `CASH +10000.00000000`, `CAPITAL -10000.00000000`                              |
| A: buy 10 at 190.04, fee 0                | `CASH -1900.40`, `POSITION_COST +1900.40` (cash after grant 8,099.60)          |
| B: buy 0.05 at 60,030.00, fee 3.0015      | `CASH -3004.5015`, `POSITION_COST +3001.50`, `FEES +3.0015`                    |
| Sell 10 at 195.00, basis 1,900.40, no fee | `CASH +1950.00`, `POSITION_COST -1900.40`, `REALIZED_PNL -49.60`               |
| Same sell with fee 1.95                   | `CASH +1948.05`, `FEES +1.95`, `POSITION_COST -1900.40`, `REALIZED_PNL -49.60` |

## Repository (`apps/api/src/modules/ledger`)

Every function takes a `pg` client that **already has an open transaction**.

- `createAccount` inserts the account and its six USD ledger accounts.
- `postTransaction` inserts the transaction with `ON CONFLICT (account_id, idempotency_key) DO NOTHING`. If the key existed it compares the stored entries with the new legs: identical returns the old transaction (`created: false`), different throws `IdempotencyConflictError`. Otherwise it inserts the entries sorted by `ledger_account_id` (one lock order, no deadlocks), then checks the balance rule. It works inside a savepoint, so a failed post leaves nothing behind and the caller's transaction stays usable.
- Errors: `InsufficientFundsError` (balance CHECK), `LedgerUnbalancedError`, `IdempotencyConflictError`; anything else passes through.
- `grantInitialCapital` uses the key `grant:<accountId>`.
- `reconcileAccount` is read-only and checks I1, I2, I3 and I10. An empty list means clean.
- Parameters are strings with `$n::numeric`. No `pg` type parser is registered, so a `numeric` read returns text such as `0.1000000000`.

## Adding a new posting type

1. **Engine:** add a pure recipe in `packages/engine/src` that returns signed legs, omits zero legs and asserts each currency sums to zero. Add its golden vector as hard-coded strings with the hand-checked sum in a comment.
2. **Repository:** call `postTransaction` with the right `kind` and a deterministic idempotency key. If the kind or ledger account does not exist yet, add a **new** migration (never edit an old one).
3. **Tests:** unit test the recipe (vector plus a property test), then a Postgres test that posts it, checks exact entries and balances, and runs `reconcileAccount`. Pair every "must fail" test with a control that succeeds.
4. **Grants:** the app role needs no new privilege to post. Do not grant UPDATE, DELETE or TRUNCATE.
