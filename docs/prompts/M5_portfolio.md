# VANTAGE · Claude Code Prompt · M5 — PORTFOLIO, P&L AND HISTORY (read side)

Same standing rules as M0–M4b: native Windows, PowerShell, repo `C:\dev\vantage`, Node 22.19.0, exact dependency versions, LF endings, no secrets in git or on command lines, specs are the source of truth, stop-and-report on ambiguity, never mark PASS unless you ran it, no push, no UI.

## 1. Goal
Give a user an honest view of what they own and how they are doing: cash, positions valued at current marks (with freshness labels), unrealised and realised P&L, total equity, and history (orders, executions, ledger activity), plus a daily equity snapshot for a future equity curve. **Read side only: no new trading logic, no ledger writes except the snapshot table.**

Honesty rules (non-negotiable): never show a number as real-time if its quote is not; a position with no usable quote is shown with `valuation: UNAVAILABLE` and is **excluded from totals with an explicit flag**, never valued at zero or at cost silently; every valuation carries its quote timestamp, source and freshness state.

Read first: `docs/phase-reports/M4b-report.md`, `docs/trading.md`, `docs/api.md`, `docs/market-data.md`, PRD portfolio/P&L requirements, TRADING_ENGINE (marks, P&L definitions), DATABASE §6–§7 (positions, lots, lot_closures), §13 (reconciliation), MARKET_DATA (freshness, QuoteStore). If specs conflict with this prompt, stop and report.

## 2. Step 0
Ensure `main` contains M4b (if `origin` exists, fetch; diverged → STOP). Branch `phase/m5-portfolio`. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify` green before changes (stale DB: `pnpm db:reset`).

## 3. Decisions (record as D-60… `APPROVED by founder (M5)` unless you object with a reason)
- **D-60** Mark price for valuation: **bid for long positions** (the price you could sell at), falling back to `last` only if no bid; never the ask. Label which was used (`markBasis: BID|LAST`). Freshness comes from the shared market-model function.
- **D-61** Definitions (exact decimals, USD, 8 dp internally, display 2 dp rounded HALF_EVEN only at the API edge as strings with full-precision companion where useful):
  - `marketValue = qty × mark`; `costBasis = Σ open lots qty_open × cost`; `unrealisedPnl = marketValue − costBasis`; `realisedPnl = −REALIZED_PNL ledger balance` (equals Σ lot-closure `trading_pnl_usd`); `fees = FEES ledger balance`; `equity = cash + Σ marketValue (valued positions only)`; `totalReturn = equity − 10,000 grant` reported **only when every position is valued**, otherwise `null` with `incomplete: true`.
  - Day change is out of scope until prior-close data exists (M3b); do not fake it.
- **D-62** Equity snapshots: table `equity_snapshots(account_id, snapshot_date, cash, positions_value, equity, valued_complete boolean, quote_asof, created_at)`, append-only (same trigger pattern), unique `(account_id, snapshot_date)`. Written by an in-process job (injectable clock, idempotent upsert-by-insert-ignore) at the first run after the NYSE close each trading day using the stored marks; incomplete valuations are stored with `valued_complete=false`, never invented. Grants: app role `SELECT, INSERT` only.
- **D-63** Balances and positions are read **from the database in one consistent snapshot** (a single `REPEATABLE READ` read-only transaction per request), so cash and lots never disagree inside one response.

## 4. Tasks (in order; verify each; commit after each)

**T1 · `@vantage/engine` (or market-model) pure valuation functions.** `valuePosition`, `summarisePortfolio` per D-60/D-61, exact decimals, no float/clock/IO. Golden vectors hard-coded as strings, hand-verified in comments: e.g. cash 8,099.60 + 10 AAPL cost 1,900.40 with bid 195.00 → marketValue 1,950.00, unrealised +49.60, equity 10,049.60, totalReturn +49.60; after a SELL scenario realised P&L from M4a vector (+49.20) matches the ledger; a position with UNAVAILABLE quote → excluded, `incomplete: true`, `totalReturn: null`; STALE quote → valued but flagged `STALE`. Property tests: equity = cash + Σ value; unrealised = value − cost; summing positions is order-independent.

**T2 · Migration.** `equity_snapshots` per D-62 with immutability triggers and minimal grants (no UPDATE/DELETE/TRUNCATE).

**T3 · Endpoints (auth + CSRF as before; account always from the session; other users' data never reachable).**
- `GET /v1/portfolio` → cash, positions (symbol, qty, avgCost, costBasis, mark, markBasis, marketValue, unrealisedPnl, valuation state, quote asOf/source/freshness), totals, realisedPnl, fees, equity, totalReturn/incomplete, `asOf` (the oldest quote timestamp used).
- `GET /v1/portfolio/history?from&to` → equity snapshots (cursor or bounded range, max 366 rows).
- `GET /v1/executions` (cursor pagination, newest first; fields incl. price, fee, quote used, realised P&L for sells via lot closures).
- `GET /v1/ledger/activity` → the user's own transactions in plain-language form (kind, time, signed cash effect, linked order), cursor pagination. No internal ledger account ids leaked beyond what docs/api.md allows.
- All money as strings; update `docs/api.md` with schemas, examples, error codes. Zod contracts in `@vantage/contracts`.

**T4 · Snapshot job.** In-process scheduler (injectable clock; no new infra): after each NYSE close (use the calendar from M3a, incl. early closes), snapshot every active account once. Safe to run twice (no duplicates), safe if the app was down (catch-up for the missed trading days uses **only stored data**; if no stored mark exists for that day it writes `valued_complete=false`, never today's price for an old date). Test with the injected clock.

**T5 · Tests** (real Postgres, HTTP via Nest test app; every "must fail" has a control that succeeds):
1. Golden valuation vectors through HTTP after real orders placed via the M4b API (buy, partial sell, full sell) — exact strings.
2. Honesty: UNAVAILABLE quote → excluded + `incomplete`, `totalReturn: null`; STALE labelled; CLOSED uses last bid with `asOf` shown; never zero-valued.
3. Cross-check: `portfolio.realisedPnl`, `fees`, `cash`, `costBasis` equal the ledger / lots via `reconcileAccount` after a random order sequence (reuse the M4a reference model).
4. Consistency: concurrent order placement while reading `/v1/portfolio` 100 times → every response internally consistent (cash + cost basis − realised … matches a ledger-derived identity: `cash + costBasis + fees − realisedPnl = 10,000` at every read).
5. Isolation/auth: no session 401; user B never sees A's data; pagination stable under concurrent inserts.
6. Snapshots: idempotent, catch-up, early-close day, incomplete flag, append-only protection as `vantage_app` (must fail + control).
7. Performance: seed 1 account with 200 positions and 5,000 executions; report p50/p95 for `/v1/portfolio` and `/v1/executions`. Not a CI gate; fix obvious N+1 queries.
- Done when: `pnpm verify` green; `pnpm test:integration` green twice in a row; no leftover `t_*` DBs.

**T6 · Docs.** `docs/portfolio.md` (definitions, mark rules, honesty rules, identity checks, snapshot job), `docs/api.md`, append D-60..D-63 to `docs/specs/DECISIONS.md` (zero deletions).

## 5. Out of scope
UI; day-change/prior-close P&L; benchmarks/leaderboards; limit/stop orders; real provider (M3b); FX/INR; crypto; WebSocket; Redis; email; CI/GitHub push; new trading rules.

## 6. Common mistakes
Valuing at ask or silently at cost; valuing missing quotes at zero; including unvalued positions in totals without a flag; floats in JSON; rounding before summing; two reads in separate transactions giving inconsistent totals; snapshots using today's price for past dates; leaking other users' rows; unbounded history queries; computing P&L in a different formula than the ledger.

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
1. Step 0 baseline green. 2. Valuation golden vectors exact (unit and HTTP). 3. Honesty rules proven (UNAVAILABLE/STALE/CLOSED). 4. Portfolio numbers equal ledger/lots after random sequences. 5. Concurrent-read identity holds 100/100. 6. Auth/isolation/pagination. 7. Snapshots idempotent, catch-up honest, append-only enforced. 8. `pnpm verify` green, integration green twice, no leftover DBs. 9. Performance numbers reported. 10. Docs and D-60..D-63 appended, zero deletions.

## 9. Final report (`docs/phase-reports/M5-report.md`, print it in full in the reply)
1. Status: READY / READY WITH CAVEATS / NOT READY for M6 (UI) (≤ 5 lines). 2. Dependency changes. 3. Task status T1–T6. 4. Files created/modified. 5. Commands with exit codes; failing output verbatim. 6. Acceptance table with evidence. 7. Test list with controls. 8. Deviations, spec questions. 9. Known limitations and what M6 needs (list every endpoint the UI can use).

Do not start M6. Stop after the report.
