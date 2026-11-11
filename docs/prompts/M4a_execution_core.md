# VANTAGE · Claude Code Prompt · M4a — TRADING DATA MODEL AND EXECUTION CORE (no HTTP yet)

Environment and rules carry over from M0–M3a: native Windows, PowerShell, Docker Desktop, repo at `C:\dev\vantage` (not in OneDrive), Node 22.19.0, Postgres port from `POSTGRES_HOST_PORT`, exact dependency versions, LF endings, no secrets in git or on command lines, stop-and-report on ambiguity, never mark anything passed unless you ran it, no push, no UI.

## 1. Goal

This is the **riskiest phase** of the product. Build the part that turns a market-order request into exact, permanent, correct records of money and shares: the trading tables, the pure engine functions, and one database-transaction function `executeMarketOrder`. **No HTTP endpoints, no idempotency-key HTTP layer, no UI** (those are M4b).

Scope: **MARKET orders only (BUY and SELL), whole shares, US stocks and ETFs, USD, synchronous fill inside one transaction** (decisions D-30, D-33, D-39). Limit/stop orders, reservations, partial fills, async matcher and cancel are out of scope.

At the end, these must be provably true, in the database and not only in code:
- cash can never go negative, shares can never be oversold, even with many simultaneous orders on one account;
- every fill produces exactly one balanced ledger transaction, one execution, correct FIFO lots and closures, and a position equal to the sum of its lots;
- fees are recorded separately (zero fee allowed);
- a retried order (same `client_order_id`) never fills twice;
- rejected orders are recorded as `REJECTED` with a reason, and change no money or shares;
- executions, order events and lot closures can never be edited or deleted.

Read first: TRADING_ENGINE §1–§4, §7 (reject codes), §8, §9, §11, §12, §13; DATABASE §7, §8 (`idempotency_keys`, `fee_schedules`), §11, §13; `docs/ledger.md`; `docs/market-data.md`; the M3a report. If a spec is ambiguous or contradicts this prompt, stop and report. Do not invent.

## 2. Step 0

1. Make sure local `main` contains M3a (if `origin` exists, fetch and make sure `main` is not behind `origin/main`; if diverged, STOP and report). Create branch `phase/m4a-execution`.
2. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify` must pass before you change anything. Stale local database: `pnpm db:reset`. Otherwise stop and report.

## 3. Decisions for this phase (record in DECISIONS as `APPROVED by founder (M4a)` unless you object with a reason)

- **D-49** M4 supports synchronous `MARKET` orders only. In this phase `orders` rows are inserted once in their final state (`FILLED` or `REJECTED`) and never updated, so the app role gets **no UPDATE on `orders`** yet. The state machine (§7 of TRADING_ENGINE) arrives with async orders.
- **D-50** Business rejects (market closed, stale quote, insufficient funds, …) are **persisted** as `REJECTED` orders with an `order_events` trail and no ledger entries. Malformed input is not an order (HTTP layer, M4b).
- **D-51** Price-moved protection: the command carries `referencePrice` (the ask the user saw for a BUY, the bid for a SELL). If the current price moved against the user by more than the collar (1% for equities and ETFs, TRADING_ENGINE §6), the order is rejected `PRICE_MOVED`. Favourable moves are accepted.
- **D-52** Because prices are multiples of the tick (0.01) and quantities are whole shares, notional and lot arithmetic are **exact** (no rounding dust). Reconciliation compares ledger and lots with **zero tolerance**. Fees (basis-point commissions) are rounded 8 dp HALF_EVEN and are not part of lot cost. If tick or quantity rules change later, this must be revisited.
- **D-53** Critical invariants I4 and I5 get **deferred database constraint triggers** (checked at commit), in addition to reconciliation.
- **D-54** Fee and slippage parameters come from a versioned, immutable `fee_schedules` table (v1: commission 0 bps, base slippage 2 bps, size coefficient 0 because there is no ADV data yet), not from constants in code. Each execution stores `model_version`.

## 4. Tasks (in order; verify each; commit after each)

**T1 · Migrations (plain SQL, forward-only).** Tables exactly as DATABASE §7 and §8 for: `orders`, `order_events`, `executions`, `position_lots`, `lot_closures`, `positions`, `idempotency_keys` (created now, used in M4b), `fee_schedules`. Do **not** create `account_events` or `accounts.event_seq` (outbox is later). Seed `fee_schedules` v1 for `EQUITY` and `ETF` (`exchange_id` NULL, `model_version 'QBX-1/r8he'`, effective from a fixed past date) in the migration.
1. **Immutability** (row and TRUNCATE triggers, reusing `forbid_mutation`): `order_events`, `executions`, `lot_closures`, `fee_schedules`, `orders` (rows are never updated in M4a). `position_lots`: only `qty_open` and `closed_at` may change (a trigger rejects changes to any other column).
2. **Deferred constraint triggers (D-53):**
   - I4: at commit, for every `(account_id, instrument_id)` touched, `positions.qty` equals the sum of `position_lots.qty_open` (a missing positions row is allowed only when the lot sum is 0); `qty_open <= qty_initial`; `closed_at` is set iff `qty_open = 0`.
   - I5: at commit, `orders.filled_qty` equals the sum of `executions.qty` for that order; a `FILLED` order has `filled_qty = qty`; a `REJECTED` order has `filled_qty = 0` and no execution; an execution's `account_id`/`instrument_id`/`side` match its order and its ledger transaction belongs to the same account.
3. **Grants to `vantage_app` (explicit, minimal):** `orders`, `order_events`, `executions`, `lot_closures`, `idempotency_keys`: `SELECT, INSERT`; `position_lots`: `SELECT, INSERT, UPDATE (qty_open, closed_at)`; `positions`: `SELECT, INSERT, UPDATE`; `fee_schedules`: `SELECT`; sequence `USAGE` as needed. **No DELETE or TRUNCATE anywhere.** Any new function: `REVOKE EXECUTE … FROM PUBLIC`.
- Done when: migrations apply twice (second no-op).

**T2 · `@vantage/engine` additions (pure; no IO, no clock, no randomness; time is an argument).**
- `decideMarketOrder(input) → { decision: 'FILL', price, notional, fee, slippageBps, … } | { decision: 'REJECT', code }`. Input: side, whole-share qty, instrument (status, `tradable_in`, tick, min qty, qty step, asset class), quote and its freshness state (from `@vantage/market-model`), `allowExecutionOnDelayed`, fee schedule, `referencePrice`, account state (active, trading enabled), cash, position qty. **Rule order, first failure wins (document it):** `TRADING_PAUSED`, `ACCOUNT_NOT_ACTIVE`, `INSTRUMENT_NOT_TRADABLE` (not tradable in MVP, `DELISTED`, or a BUY on `SELL_ONLY`), `INSTRUMENT_HALTED`, `QTY_BELOW_MIN`, `QTY_STEP_VIOLATION`, quote eligibility (`UNAVAILABLE` → `NO_ELIGIBLE_QUOTE`, `CLOSED` → `MARKET_CLOSED`, `STALE` → `STALE_QUOTE`, `DELAYED` with `allowExecutionOnDelayed = false` → `NO_ELIGIBLE_QUOTE`), `PRICE_MOVED` (D-51), then funds (`INSUFFICIENT_BUYING_POWER`: cash < notional + fee) or position (`INSUFFICIENT_POSITION`).
- `fillPrice(side, bid, ask, slippageBps, tick)`: BUY = `ask × (1 + bps/10000)` rounded **up** to tick; SELL = `bid × (1 − bps/10000)` rounded **down** to tick (TRADING_ENGINE §4). Result must be `> 0`.
- `commission(notional, schedule)`: `max(notional × bps/10000, min)` rounded 8 dp HALF_EVEN.
- `consumeLotsFIFO(lots, qty)`: oldest first by `(opened_at, id)`; returns the consumption per lot (qty, cost = qty × lot cost per unit). Throws if the lots hold less than `qty`.
- `allocateProceeds(totalProceeds, consumptions)`: splits proceeds over the consumed pieces proportionally by quantity, last piece by subtraction, so the pieces sum **exactly** to the total.
- Reuse the M1 `buyFillLegs` / `sellFillLegs` for the ledger legs (assert balance before returning).
- **Golden vectors, hard-coded as strings in the tests (never computed by the code under test):** use quote AAPL bid 189.95, ask 190.00, slippage 2 bps.
  - BUY 10: price 190.038 → **190.04**, notional 1,900.40, fee 0; cash after the 10,000 grant = **8,099.60**.
  - SELL 10 at bid 195.00: 195.00 × 0.9998 = 194.961 → **194.96**, proceeds 1,949.60, basis 1,900.40, realised **+49.20**; cash **10,049.20**; ledger: `POSITION_COST 0`, `REALIZED_PNL −49.20`, `CAPITAL −10000`, sum 0.
  - BUY 10 with a 10 bps commission schedule: fee **1.9004**; `CASH −1902.3004`, `FEES +1.9004`; cash after the grant **8,097.6996**.
  - FIFO: buy 3 at ask 100.00 → 100.02 (lot 1); buy 2 at ask 101.00 → 101.0202 → **101.03** (lot 2); sell 4 at bid 99.00 → 98.9802 → **98.98**: consumes lot 1 fully and 1 share of lot 2; basis = 300.06 + 101.03 = **401.09**; proceeds 395.92; realised **−5.17**; remaining lot 2 has 1 share at 101.03; position avg cost 101.03.
  - Verify each vector by hand in the test comments.
- Property tests: random valid inputs give a fill price that is a multiple of tick, never better than the quote for the user, and ledger legs that sum to zero per currency; `allocateProceeds` pieces always sum exactly to the total; FIFO conserves quantity.
- Done when: unit tests pass and `pnpm lint` shows the engine has no floats, no clock, no randomness, no IO.

**T3 · `executeMarketOrder(client, command)`** (module `apps/api/src/modules/trading`, uses `pg`; takes a client **with an open transaction** so M4b can add idempotency-key storage in the same transaction).
The command carries already-resolved facts: `orderId`, `accountId`, `clientOrderId`, instrument, side, qty, `referencePrice`, the quote snapshot with its freshness state, the fee schedule row, `allowExecutionOnDelayed`, `tradingEnabled`, and `now`. In order:
1. **Lock** `accounts` row `FOR UPDATE` (the first lock, always). Read the account and its user status under the lock. All order processing for an account is serialised by this lock.
2. **Replay check:** if an order with `(account_id, clientOrderId)` exists, return it unchanged when the stored parameters match the command; throw `ClientOrderIdMismatchError` when they differ. Never fill twice.
3. Read cash (lock the `CASH` ledger account row), the position and its open lots (lock them `FOR UPDATE`, ordered by `opened_at, id`).
4. Call `decideMarketOrder`. On **REJECT**: insert the `REJECTED` order (`reject_code`) and `order_events` (`CREATED`, `REJECTED` with the reason and the facts used); no ledger entries; return.
5. On **FILL**:
   - BUY: post the ledger transaction (kind `FILL`, key `fill:<orderId>:1`) via the M1 repository using `buyFillLegs`; insert the lot (`qty_initial = qty_open = qty`, cost per unit = fill price); upsert the position (qty, `avg_cost_local` = Σ(qty_open × cost) ÷ Σ qty_open, rounded 8 dp).
   - SELL: `consumeLotsFIFO`; basis from the consumptions; ledger via `sellFillLegs`; update each lot's `qty_open` and `closed_at`; insert `lot_closures` (proceeds from `allocateProceeds`, cost, `trading_pnl_usd = proceeds − cost`, `fx_pnl_usd = 0`, USD fields equal local fields); update the position and add the realised P&L.
   - Insert the order (`FILLED`, `filled_qty = qty`), `order_events` (`CREATED`, `ACCEPTED`, `FILLED`) with contiguous `seq`, and the `executions` row with **every** column: price, `fee_local`/`fee_usd`, `gross_usd`, `slippage_bps`, `quote_bid`, `quote_ask`, `quote_last`, `quote_ts`, `quote_source`, `quote_entitlement`, `model_version`, `ledger_tx_id`, `executed_at = now`.
6. Return a typed result (`FILLED` with order, execution, ledger tx id; or `REJECTED` with code). Map database errors to typed errors; **any unexpected error aborts the whole transaction** (the caller rolls back). Never swallow an error to "finish" an order.
7. Extend `reconcileAccount` to check, with **zero tolerance**: I1, I2, I3, I4 (`positions.qty` = Σ lot `qty_open`), I5, I6 (every execution has exactly one ledger transaction and none is shared), position cost (`POSITION_COST` ledger balance = Σ over open lots of `qty_open × cost_local_per_unit`), realised P&L (`REALIZED_PNL` = −Σ lot-closure `trading_pnl_usd`), and I10 (existing).
- Done when: the T4 tests pass.

**T4 · Tests** (real Postgres via `createTestDatabase()`; account created with the M1/M2 helpers and the 10,000 grant; app connected as `vantage_app`; clock injected; quotes built directly in the test. Each "must fail" has a control that succeeds).
1. **Golden vectors end to end** through `executeMarketOrder`: the four vectors of T2 produce exactly the stated orders, executions (all quote fields filled), lots, closures, positions, ledger entries and balances. `reconcileAccount` is clean after each.
2. **Every reject code** in the T2 list is reachable and tested: the order is stored `REJECTED` with events, **no** ledger entries, execution, lot or position change, and balances unchanged. Include `DELAYED` accepted when allowed and rejected when `allowExecutionOnDelayed = false`.
3. **Replay:** the same `clientOrderId` and parameters twice returns the same order and creates one execution and one ledger transaction; the same id with different parameters throws `ClientOrderIdMismatchError`; 100 parallel calls with the same id give exactly one execution.
4. **Atomicity:** inject a failure after the ledger post and before the end of the function (test hook): after rollback there is no order, execution, lot, position change or ledger transaction, and a retry then succeeds once.
5. **Concurrency (real Postgres):** (a) cash 10,000, 50 parallel BUYs of 4 shares at a price of 100.02 (cost 400.08 each): exactly 24 fill, 26 are `REJECTED INSUFFICIENT_BUYING_POWER`, final cash is the exact expected value and never negative, no deadlock; (b) a position of 10 shares, 20 parallel SELLs of 1 and 10 parallel SELLs of 2: total sold never exceeds 10, `positions.qty` never negative, lots equal the position; (c) mixed parallel BUY/SELL on one account: `reconcileAccount` clean; (d) parallel orders on **different** accounts do not block each other (assert both complete, no lock timeout).
6. **Property test on Postgres** (fast-check, about 30 runs of up to 20 operations): random BUY and SELL orders with random quotes; after every operation `reconcileAccount` is clean and the account's cash, shares and realised P&L equal an **independent reference model written in the test** (simple arrays, FIFO by hand).
7. **Database protection (as `vantage_app`):** `UPDATE`/`DELETE`/`TRUNCATE` on `orders`, `order_events`, `executions`, `lot_closures`, `fee_schedules` all fail; `UPDATE position_lots SET qty_open …` succeeds (control) but changing `cost_local_per_unit` fails; a hand-written transaction that leaves `positions.qty` different from the lot sum fails **at commit** (control: a consistent one commits); a `FILLED` order with no execution, or an execution whose quantity does not match, fails at commit; a second execution for the same ledger transaction fails (unique); an execution whose order belongs to another account fails.
8. **Exactness:** with whole shares and tick-multiple prices, `Σ(qty_open × cost)` equals the `POSITION_COST` balance exactly after a long random sequence (this proves D-52).
- Done when: `pnpm verify` is green and `pnpm test:integration` passes **twice in a row** with no leftover `t_*` databases. Add a **benchmark script** (not a CI gate) that runs 1,000 sequential market orders and prints p50/p95 latency; report the numbers.

**T5 · Docs and decisions.**
- `docs/trading.md` (short): the rule order, the price and fee formulas with the golden vectors, the transaction steps and lock order (account row, then CASH ledger row, then position and lots), the invariants and where each is enforced (DB constraint, deferred trigger, reconciliation), and "what M4b adds".
- Append D-49 to D-54 to the `docs/specs/DECISIONS.md` table (existing lines untouched; zero deletions).

## 5. Out of scope (do not build)
HTTP endpoints, DTOs, controllers; the `Idempotency-Key` HTTP handling and storing responses (the table exists, the logic is M4b); limit/stop/stop-limit orders, reservations (`RESERVED` stays unused), partial fills, cancel/expire, matcher or worker; `account_events`/outbox; FX or INR; crypto; fractional shares; P&L valuation with marks, portfolio endpoints, equity curve; UI; a real market-data provider; Prisma; Redis; rate limiting.

## 6. Common mistakes
Floats anywhere; computing a fill price in more than one place; locking the CASH row before the account row (or in another order); a replay that fills again; recording a reject without an order row (or recording ledger entries for a reject); lots updated without the closure rows; position cache updated by a different formula than lots; fees folded into lot cost; relying on application checks instead of the database constraints; tests that compute expected values with the code under test; "must fail" tests with no control; swallowing errors; editing old migrations; changing spec text.

## 7. Verification (clean clone of the branch)
```powershell
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate ; pnpm db:migrate ; pnpm db:status
pnpm verify
pnpm test:integration          # second consecutive run
node apps/api/dist/main.js --check
pnpm db:down
```

## 8. Acceptance criteria (run each; PASS / FAIL / UNVERIFIED)
1. Step 0 baseline green.
2. Golden vectors (BUY, SELL, fee, FIFO) reproduce to the stated digit end to end; each is hand-verified in comments.
3. Every reject code is tested; rejects persist a `REJECTED` order and change no money, shares or ledger.
4. Replay and 100-way duplicate calls produce exactly one execution; a mismatching replay throws.
5. Atomicity test: injected failure leaves nothing behind; the retry succeeds once.
6. 50-way concurrent BUYs: exactly 24 fills, cash never negative, no deadlock; concurrent SELLs never oversell; mixed parallel runs reconcile clean.
7. Property test: reconcile clean after every step and equal to the independent reference model.
8. The app role cannot update or delete append-only tables; column-limited updates enforced on lots; the commit-time triggers (I4, I5) fire on inconsistent data and pass consistent data.
9. Position cost equals Σ lot cost exactly (zero tolerance) after long random sequences.
10. Engine is lint-clean (no floats, clock, randomness, IO).
11. `pnpm verify` green; integration green twice in a row; no leftover test databases; benchmark numbers reported.
12. `docs/trading.md` written; D-49 to D-54 appended with zero deletions.

## 9. Final report (`docs/phase-reports/M4a-report.md`, also printed)
1. Status: READY / READY WITH CAVEATS / NOT READY for M4b (≤ 5 lines).
2. New dependency versions and how verified (if any).
3. Task status T1–T5.
4. Files created / modified.
5. Commands run with exit codes and durations; failing output verbatim.
6. Acceptance table (12 items) with evidence and the benchmark numbers.
7. Test list, each "must fail" with its control; the reference model used in the property test.
8. Deviations, surprises, spec questions (stop-and-report format).
9. Known limitations and what M4b needs from this phase.

Do not start M4b. Stop after the report.
