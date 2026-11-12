# M4b report: order API (HTTP, idempotency, M4a hardening)

## 1. Status

**READY WITH CAVEATS for M5.** All T1 to T5 tasks are done and verified on a clean clone of the branch (`pnpm verify` exit 0, a second `pnpm test:integration` exit 0, no leftover `t_*` databases). Caveats: the in-memory rate limit is per process; quotes are still FIXTURE data (no real provider, M3b); the benchmark shows 11 to 85 orders/s depending on the run and machine load, and the round-trip reduction did not measurably improve latency; file mode 0600 and CI remain UNVERIFIED (Windows, no remote).

## 2. Dependency changes

None. No package was added or changed; `pnpm-lock.yaml` is unchanged.

## 3. Task status

| Task                             | Status | Commit                       |
| -------------------------------- | ------ | ---------------------------- |
| Step 0 baseline                  | DONE   | (main fast-forwarded to M4a) |
| T1 M4a hardening (D-55/56/57)    | DONE   | c81db7a                      |
| T2 contracts                     | DONE   | 64bd3b2                      |
| T3 endpoints                     | DONE   | d1f4a46                      |
| T4 tests, benchmark, round trips | DONE   | 4a298ee, market test fix     |
| T5 docs and decisions            | DONE   | docs commits                 |

Decisions given by the founder before the run were applied: D-58 amendment (the `Idempotency-Key` header is stored as `orders.client_order_id`; no `clientOrderId` in the body), 201 for the first call and a stored replay (a note superseding ARCHITECTURE section 5's 202 was appended, the line itself is untouched), 30 orders per user per minute in memory, key format 8 to 128 characters of `A-Za-z0-9._:-`, lookup-first order of checks, `DUPLICATE_CLIENT_ORDER_ID` kept as an unreachable guard.

## 4. Files

Created: `db/migrations/0022_lock_functions_return_nothing.sql`; `packages/contracts/src/orders.ts` and `orders.test.ts`; `apps/api/src/modules/orders/` (`orders.service.ts`, `orders.module.ts`, `orders-http.int.test.ts`, `orders-rejects.int.test.ts`, `orders-concurrency.int.test.ts`, `orders-bench.int.test.ts`); `apps/api/src/testing/orders-kit.ts`; `tools/bench-orders-http.mjs`; `docs/prompts/M4b_order_api.md`; this report.

Modified: `packages/engine/src/market-order.ts` and its test (rule 10); `apps/api/src/modules/trading/execute-market-order.ts` (void lock functions, `accountLocked` option, one statement for order events); `apps/api/src/modules/ledger/reconcile.ts` (trading checks on by default); `ledger.int.test.ts` (explicit opt-out); `trading.int.test.ts`, `trading-db.int.test.ts` (new tests); `market-data/quote.service.ts` (`snapshotFor`); `market.int.test.ts` (staging env sets `TRADING_ENABLED`); `packages/config` (`TRADING_ENABLED`, `ORDER_RATE_LIMIT_PER_MINUTE`) and its tests; `.env.example`; audit action `ORDER_PLACED`; CORS allows the `idempotency-key` header; `tokens.ts`; `app.module.ts`; `package.json` (script `bench:orders:http`); `docs/api.md`, `docs/trading.md`; `docs/specs/DECISIONS.md` (+5 rows) and `ARCHITECTURE.md` (+2 lines), zero deletions (`git diff --numstat`: 5/0 and 2/0).

## 5. Commands and exit codes (clean clone of `phase/m4b-order-api`, final run)

| Command                                         | Exit       | Time                                                         |
| ----------------------------------------------- | ---------- | ------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                | 0          | 25 s                                                         |
| `pnpm setup:env --port 55433`                   | 0          | 3 s                                                          |
| `pnpm db:reset`                                 | 0          | 15 s                                                         |
| `pnpm db:migrate` (twice)                       | 0, 0       | 4 s, 3 s (second a no-op; 0001..0022)                        |
| `pnpm verify`                                   | 0          | 347 s: 424 unit, 273 integration (2 skipped = the benchmark) |
| `pnpm test:integration` (second)                | 0          | 245 s: 273 passed                                            |
| leftover `t_*` databases                        | 0          |                                                              |
| `main.js --check` valid / empty env / `--bogus` | 0 / 2 / 64 |                                                              |

Failures along the way (verbatim cause, all fixed): (1) the first clone run was invalid because `setup:env` exited 1 while my own `vantage` Postgres still held port 55433; I stopped it and reran. (2) The second clone run failed one test: `market.int.test.ts > 4. FIXTURE guards > the startup guard refuses to boot in staging when a fixture instrument exists`, because my new rule (staging and production must set `TRADING_ENABLED`) made the test's staging config invalid; fixed by setting it in the test, then the whole clone verification was rerun from scratch (the table above). (3) In my own work: a shell heredoc with `$` and backticks stripped code names from `docs/trading.md` and I committed it once; fixed in the next commit.

## 6. Acceptance criteria (each PASS ran in the clean clone unless noted)

| #   | Criterion                                                                         | Result                       | Evidence                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Step 0 baseline green                                                             | PASS                         | 342 unit and 210 integration tests, exit 0 before any change                                                                                                                                                                                                               |
| 2   | D-55 lock-function privileges proven by test                                      | PASS                         | `trading-db.int.test.ts` "D-55": two functions, SECURITY DEFINER, `void`, one overload, `search_path` fixed, EXECUTE for owner and `vantage_app` only, none for PUBLIC; control proves the check can fail; direct `FOR UPDATE` refused with 42501 while the function works |
| 3   | Reconcile runs trading checks by default                                          | PASS                         | "D-56" test: a FILL with no lots is flagged by default (POSITION_COST), clean only with `{ trading: false }`; a real trade is clean by default                                                                                                                             |
| 4   | `FEE_EXCEEDS_PROCEEDS` reject, no DB error path                                   | PASS                         | engine tests (fee 5.00 vs proceeds 1.99 rejected; equal fills; after the position check); DB test and HTTP test with a 5.00 minimum-commission schedule built in the test; money unchanged; larger SELL fills                                                              |
| 5   | Golden vector A through HTTP exact                                                | PASS                         | BUY 10 AAPL: price 190.04, notional 1900.40, cash 8099.60, POSITION_COST 1900.40, `client_order_id` = key; GET equals POST body; reconcile clean                                                                                                                           |
| 6   | Idempotency: replay, 422, 50-way parallel one fill                                | PASS                         | identical replay body; 4 mismatching bodies are 422 `IDEMPOTENCY_MISMATCH`; canonical comparison (`10` = `"10"`, `190` = `190.00`); 50 parallel identical requests: 1 order, 1 execution, 50 equal 201 bodies; 50 parallel with two bodies: exactly one order              |
| 7   | Auth, CSRF, isolation (404 for others)                                            | PASS                         | 401 without session, 403 `CSRF_REJECTED` for bad or missing Origin, other user's order id gives the same 404 as a missing or malformed id; account id in body is 400; same key by two users: no collision, no leak                                                         |
| 8   | All reject codes over HTTP, money unchanged                                       | PASS                         | `orders-rejects`: all 13 codes (coverage test asserts the tested set equals the contract list and the engine list), each 201 REJECTED, stored, cash and counts unchanged, each followed by a control that fills; `INSTRUMENT_NOT_FOUND` is a 404 that stores nothing       |
| 9   | 50-way HTTP concurrency gives exactly 24 fills                                    | PASS                         | 50 parallel BUYs of 4 at 100.02: 24 FILLED, 26 `INSUFFICIENT_BUYING_POWER`, cash 398.08; 10 users in parallel plus a heavy account: each exact                                                                                                                             |
| 10  | Atomicity, retry succeeds once                                                    | PASS                         | hook after the ledger post: 500 `INTERNAL_ERROR` with request id, no order, execution, ledger transaction or idempotency row; retry fills once; replay returns the same body                                                                                               |
| 11  | No secrets in logs or responses                                                   | PASS                         | scan of every tracked response, header and log line: no session token, password, cookie name, SQL or stack; control finds `IDEMPOTENCY_MISMATCH` and `order_placed`; audit rows carry no secrets                                                                           |
| 12  | verify green, integration green twice, no leftover DBs, benchmark and round trips | PASS (with the caveat below) | table in section 5; benchmark below                                                                                                                                                                                                                                        |
| 13  | Docs and D-55..D-59, zero deletions                                               | PASS                         | `docs/api.md`, `docs/trading.md`, DECISIONS +5 rows, numstat 5/0 and 2/0                                                                                                                                                                                                   |

### Benchmark (`pnpm bench:orders:http`, in-process HTTP via supertest, Windows plus Docker Desktop, not a CI gate)

Round trips per order (every `pg` query, including session lookup and audit insert): **33 before, 29 after** (account lookup and first key lookup fused; duplicate account lock removed; order events in one statement). Nothing was removed that weakens a lock or constraint (lock order account, cash, position, lots; the second key check under the lock; the replay guard and unique indexes are kept).

| Run               | (a) one account, 300 sequential                       | (b) 20 accounts in parallel, 500 orders                 |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Before            | p50 51 ms, p95 75 ms, 18.6 orders/s                   | p50 197 ms, p95 246 ms, 98.6 orders/s                   |
| After, run 1      | p50 62 ms, p95 97 ms, 15.1 orders/s                   | p50 226 ms, p95 325 ms, 84.9 orders/s                   |
| After, later runs | p50 74 to 85 ms, p95 109 to 121 ms, 11 to 13 orders/s | p50 329 to 375 ms, p95 481 to 520 ms, 50 to 57 orders/s |

The numbers drift upward over the session while the round-trip count is constant, so the machine got slower (Docker Desktop and other load); the before and after runs were not taken under equal conditions. **I cannot claim the round-trip reduction improved latency.** Reconcile violations 0 in every run. The M4a engine targets (p95 under 150 ms, 200 fills/s) are met only for single-account p95 in the quiet runs; 200 fills/s is not met over HTTP on this machine, which also runs the client in the same process.

## 7. Tests and controls

- Engine (unit): rule 10 cases, equal-fee control, order after `INSUFFICIENT_POSITION`.
- Contracts (unit, 101 tests incl. 20+ edge cases): floats, zero, negative, huge, leading zero, exponent, hex, unsafe integer, numeric price, unknown fields (account id, price, fee, now, clientOrderId), key pattern boundaries 8 and 128, query limits and cursors; controls accept valid values.
- Config: `TRADING_ENABLED` explicit in staging and production, defaults in local and test, rate limit bounds.
- `orders-http` (37 tests): golden vector A, GET equals POST, replay, stored reject replay, 422 matrix, canonical hash, cross-user key reuse, 8 invalid key cases plus boundary controls, auth, CSRF, 404 uniformity, forbidden body fields, invalid bodies, malformed JSON, pagination (25 orders, ties on `created_at`, inserts between pages, filters, bad cursors, foreign cursor), rate limit with a window reopening control, secrets scan.
- `orders-rejects` (13 codes plus coverage), `orders-concurrency` (6), `trading-db` (D-55, D-56), `trading` (D-57 integration).

## 8. Deviations and spec questions

- **D-55 change:** the lock functions previously returned statuses and balance; to satisfy "only lock and return nothing" they now return `void` (migration 0022, new and forward-only; 0020 untouched) and the caller reads status and cash with a normal SELECT after the lock. That adds two small queries but they are separate statements, so they see the latest committed state.
- **New config variables** (not in the prompt, needed by it): `TRADING_ENABLED` (staging and production must set it) and `ORDER_RATE_LIMIT_PER_MINUTE` (default 30; tests raise it). A consequence: any staging or production environment, and tests that build one, must now set `TRADING_ENABLED`.
- **`allowExecutionOnDelayed`** is a constant `true` (TRADING_ENGINE section 3: default true in the MVP), not an environment variable; please confirm.
- **Key and body of a 404:** unknown-instrument errors are not stored, so the same key may be retried afterwards.
- **Fast key lookup is lock-free** (stored rows never change), so a replay does not take the account lock; the lookup is repeated under the lock before executing.
- **`created_at` and ordering:** `now` is read before the account lock is acquired, so under contention an order's timestamp can be slightly earlier than the order in which it executed (FIFO lots use `opened_at`, then id). Harmless today; worth knowing for M5.
- **Orders list** shows `FILLED` and `REJECTED` only (the only states that exist for market orders); the status enum widens with limit orders.
- ARCHITECTURE section 6 says orders are limited 30/min per account; implemented per user as instructed.

## 9. Known limitations and what M5 needs

- Rate limit and counters are in memory and per process; the idempotency purge after 48 hours is not implemented (rows accumulate).
- The audit insert is awaited after commit and its failure is swallowed (as in M2), so an order can exist without an audit row if that insert fails.
- Quotes are FIXTURE data in an in-memory store; no real provider (M3b).
- Throughput over HTTP on this machine is modest (see benchmark); the executor makes about 22 database calls per fill and the ledger post inserts entries one by one. Batching these is the obvious next step if throughput matters.
- M5 needs: portfolio valuation, P&L and equity curve (positions have only quantity and average cost), market values from QuoteService, snapshot jobs, and the `account_events` outbox if the UI needs live updates. Also: limit and stop orders, cancel and reservations (the state machine and `FEE_EXCEEDS_PROCEEDS` interplay with reserves), and the production config for `TRADING_ENABLED`.
- UNVERIFIED as before: file mode 0600 (Windows), CI (no remote), behaviour on a real provider.
