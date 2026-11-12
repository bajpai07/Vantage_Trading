# VANTAGE · Claude Code Prompt · M4b — ORDER API (HTTP, idempotency, hardening of M4a)

Same standing rules as M0–M4a: native Windows, PowerShell, repo `C:\dev\vantage`, Node 22.19.0, exact dependency versions, LF endings, no secrets in git or on command lines, specs are the source of truth, stop-and-report on ambiguity, never mark PASS unless you ran it, no push, no UI.

## 1. Goal
Expose the M4a execution core safely over HTTP. A logged-in user can place a market order, retry it safely, and read their orders and positions. Also close the four M4a caveats. **No UI, no limit/stop orders, no real provider (M3b), no portfolio valuation/P&L endpoints (M5).**

Read first: `docs/phase-reports/M4a-report.md`, `docs/trading.md`, `docs/api.md`, TRADING_ENGINE §7–§8, DATABASE §8 (`idempotency_keys`), ARCHITECTURE (API conventions, error format), existing auth/CSRF/rate-limit code (M2). If specs conflict with this prompt, stop and report.

## 2. Step 0
Merge/ensure `main` contains M4a; create branch `phase/m4b-order-api`. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify` must be green before changes (stale DB: `pnpm db:reset`).

## 3. Decisions (record as D-55… `APPROVED by founder (M4b)` unless you object with a reason)
- **D-55** The M4a lock functions (SECURITY DEFINER) are accepted, provided: they only lock and return nothing, `REVOKE EXECUTE … FROM PUBLIC`, `GRANT` only to `vantage_app`, fixed `search_path`. Add a test that proves this. Known trade-off: the app role can lock any account row; documented in `docs/trading.md`.
- **D-56** `reconcileAccount` runs the trading checks **by default**. Opt-out is explicit (`{ trading: false }`) and used only by the old M1 ledger-only tests. No trading account may ever be reconciled without them.
- **D-57** SELL where commission > proceeds is a business **reject** `FEE_EXCEEDS_PROCEEDS` (new code, decided by `decideMarketOrder` after the position check; persisted as a REJECTED order like the others). It must never reach a DB error. Add to the rule-order docs and tests (needs a fee schedule with a min commission, built in the test).
- **D-58** Idempotency: follow DATABASE §8 / TRADING_ENGINE §8 for how `Idempotency-Key` relates to `client_order_id`. If the specs are ambiguous, STOP and report. Required behaviour either way: same key + same request body → same stored response (same status code, body) and exactly one execution; same key + different body → **422 `IDEMPOTENCY_MISMATCH`**; missing/invalid key on `POST /v1/orders` → 400. Compare requests by a canonical hash of the validated body (not raw bytes). The idempotency row is written **in the same DB transaction** as the order.
- **D-59** The server decides the account, instrument resolution, quote, fee schedule, trading-enabled flag and `now`. The client sends only: instrument (symbol), side, qty (positive integer), type `MARKET`, `referencePrice` (decimal string). Never trust client price/fee/time/account id.

## 4. Tasks (in order; verify each; commit after each)

**T1 · M4a hardening.** Implement D-55, D-56, D-57 (+ tests with controls). Fix any M4a test or doc that depended on the old defaults.

**T2 · Contracts (`@vantage/contracts`, Zod).** Request/response schemas: `PlaceOrderRequest`, `OrderResponse` (all money/qty as **strings**), `ListOrdersQuery` (cursor pagination, limit ≤ 100, newest first), `PositionResponse`. Reject unknown fields, non-integer or ≤ 0 qty, absurd sizes (set a documented max qty), non-decimal prices. Export a stable error code list for order rejects.

**T3 · Endpoints (`apps/api`, module `orders`, `positions`).** All require auth + the existing Origin/CSRF check; the account is always the session user's account (no account id in the URL; another user's order id returns 404, never 403).
- `POST /v1/orders` — flow: validate → resolve instrument by symbol (unknown → 404 `INSTRUMENT_NOT_FOUND`) → read quote from the QuoteStore and compute freshness with the shared function → load fee schedule, config flags → open one transaction → idempotency check/insert → `executeMarketOrder` → store the response in the idempotency row → commit. Response: 201 with the order (FILLED or REJECTED; a business reject is **not** an HTTP error, it is a REJECTED order with `rejectCode`, still 201 on first call). Config kill switch `TRADING_ENABLED` (default true local, explicit in staging/prod) → rejects with `TRADING_PAUSED`.
- `GET /v1/orders/:id`, `GET /v1/orders` (cursor pagination, filter by status/symbol), `GET /v1/positions` (qty, avg cost, from the positions cache; **no market values or P&L yet**).
- Rate limit order placement per user (reuse M2 limiter, in-memory is fine; document). Audit-log every order placement (user, order id, outcome code), never log request secrets.
- Errors follow the existing API error format; no stack traces or SQL in responses; unexpected errors → 500 with a request id, transaction rolled back.
- Update `docs/api.md` with every endpoint, example requests/responses, error codes.

**T4 · Tests.**
Unit/contract: schema edge cases (decimal strings, floats rejected, huge qty, unknown fields).
Integration (real Postgres, real HTTP via Nest test app, `vantage_app` role, injected clock, FIXTURE quotes). Every "must fail" has a control that succeeds:
1. **Golden vector A through HTTP:** register, log in, buy 10 AAPL → exact order/execution/ledger/cash as in M4a (8,099.60); `reconcileAccount` clean.
2. **Idempotency:** same key + body twice → identical response, one execution; same key + different body → 422; 50 parallel identical requests → exactly one fill, all get the same body; key reuse across two different users must not collide or leak.
3. **Auth & isolation:** no session → 401; bad Origin → rejected; user B cannot read or act on user A's orders (404); account id in the body is ignored/rejected.
4. **Rejects over HTTP:** market closed, stale quote, insufficient funds, insufficient position, price moved, instrument not found, trading paused, fee exceeds proceeds, each with the right body; money unchanged.
5. **Concurrency over HTTP:** 50 parallel BUY requests with distinct keys on one account → exactly 24 FILLED and 26 REJECTED, cash exactly the expected value; parallel requests from different users don't interfere.
6. **Atomicity:** a failure injected after the ledger post (test hook) → 500, nothing persisted (no order, no idempotency row), and a retry with the same key succeeds once.
7. **Pagination:** stable cursor, no duplicates/skips with concurrent inserts.
8. **Secrets/logging:** responses and logs contain no session token, password, cookie or SQL.
9. **Throughput:** extend the benchmark: (a) sequential orders on one account over HTTP, (b) 20 accounts in parallel. Print p50/p95 and orders/s. Also print **number of DB round trips per order** (count queries) and, if you can remove obvious redundant queries without weakening any lock/constraint, do so and re-measure. Not a CI gate; report honestly.
- Done when: `pnpm verify` green; `pnpm test:integration` green twice in a row; no leftover `t_*` DBs.

**T5 · Docs.** `docs/trading.md` (D-55..D-59, reject codes incl. `FEE_EXCEEDS_PROCEEDS`, lock-function trade-off), `docs/api.md`, append D-55..D-59 to `docs/specs/DECISIONS.md` (zero deletions).

## 5. Out of scope
UI; limit/stop orders; cancel; reservations; partial fills; outbox/WebSocket; portfolio valuation, P&L, equity curve (M5); real provider (M3b); Prisma; Redis; email; CI/GitHub push.

## 6. Common mistakes
Trusting client-supplied price/account/time; idempotency row written outside the order transaction; replay that re-executes; comparing raw request bytes; returning 403 vs 404 inconsistently (leaks existence); a business reject mapped to an HTTP 4xx and not stored; floats or numbers instead of decimal strings in JSON; swallowing errors; missing auth on a route; weakening M4a constraints to make tests pass; "must fail" tests without controls.

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

## 8. Acceptance criteria (PASS / FAIL / UNVERIFIED, each run)
1. Step 0 baseline green. 2. D-55 lock-function privileges proven by test. 3. Reconcile runs trading checks by default. 4. `FEE_EXCEEDS_PROCEEDS` reject works, no DB error path. 5. Golden vector A through HTTP exact. 6. Idempotency: replay, mismatch 422, 50-way parallel → one fill. 7. Auth/CSRF/isolation (404 for other users). 8. All reject codes over HTTP, money unchanged. 9. 50-way HTTP concurrency → exactly 24 fills. 10. Atomicity test passes, retry succeeds once. 11. No secrets in logs/responses. 12. `pnpm verify` green, integration green twice, no leftover DBs, benchmark and round-trip counts reported. 13. Docs and D-55..D-59 appended, zero deletions.

## 9. Final report (`docs/phase-reports/M4b-report.md`, also printed)
1. Status: READY / READY WITH CAVEATS / NOT READY for M5 (≤ 5 lines). 2. Dependency changes. 3. Task status T1–T5. 4. Files created/modified. 5. Commands with exit codes; failing output verbatim. 6. Acceptance table with evidence and benchmark numbers. 7. Test list with controls. 8. Deviations, spec questions. 9. Known limitations and what M5 needs.

Do not start M5. Stop after the report.
