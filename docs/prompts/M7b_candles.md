# VANTAGE · Claude Code Prompt · M7b — CANDLES, PRIOR CLOSE AND DAY CHANGE

Same standing rules as M0–M7a: native Windows, PowerShell, repo `C:\dev\vantage`, Node 22.19.0, exact dependency versions (verify each on npm, patch at least 2 weeks old), LF endings, no secrets in git or on command lines, specs are the source of truth, stop-and-report on ambiguity, never mark PASS unless you ran it, no push.

## 1. Goal
Give the platform history so charts (M9) and day-change numbers are possible: an OHLCV candle API for every instrument (stocks and crypto) on the simulated feed, server-computed prior close and day change on quotes, and honest equity-curve catch-up that uses the same candle source. All of it labelled `SIM` and never presented as real. **No chart UI in this phase** (M9). No new tables unless you can justify one.

Read first: `docs/market-data.md`, `docs/phase-reports/M7a-report.md`, `docs/phase-reports/M5-report.md` (stored-marks caveat, snapshot job), `packages/market-model/src/sim.ts` and `sim-universe.ts`, MARKET_DATA spec (candles section if any), `docs/api.md`, `docs/web.md`, DECISIONS (D-60..D-78). If specs conflict with this prompt, stop and report.

## 2. Step 0
Ensure `main` contains M7a (if `origin` exists, fetch; diverged → STOP; if M7a is not merged into main yet, fast-forward main to `phase/m7a-feeds` first). Branch `phase/m7b-candles`. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify` green before changes (stale DB: `pnpm db:reset`).

## 3. Decisions (record as D-79… `APPROVED by founder (M7b)` unless you object with a reason)
- **D-79** Candle source behind an interface (`CandleProvider`: `getCandles({ instrument, interval, from, to, limit, now })`). The only implementation now is `SimCandleProvider`, which **computes candles on demand from the pure SIM price function** (no table, no stored ticks), deterministic for `(seed, symbol, interval, time range)`. A future real provider would implement the same interface (and may need a table then, not now).
- **D-80** Candle model (document exactly in `docs/market-data.md`): intervals `1m, 5m, 15m, 1h, 4h, 1d`. A candle covers `[t, t+interval)` (open time `t`, UTC, aligned to the interval; `1d` aligned to the session day for stocks and to the UTC day for crypto). `open` = price at the first instant of the candle, `close` = price at the last sampled instant before the next candle's open, so consecutive candles are contiguous (`open(n+1) = close(n)` exactly), `high`/`low` = max/min of the price over a **sample grid** inside the candle (1-minute grid for intervals up to 1h, 5-minute grid for 4h and 1d), and always include open and close. Volume = a deterministic synthetic volume (pure function of seed, symbol and time, tick-size-free, 8 dp for crypto, integer for stocks), documented as synthetic. Prices use the instrument's tick (they already do). Every candle response carries `source: "SIM"` and `synthetic: true`.
- **D-81** Sessions: crypto candles are continuous (24/7). Stocks follow the **effective calendar**: with `SIM_SESSION=NYSE` there are candles only inside regular sessions (early closes respected; no candles for closed days); `1d` candle = open-to-close of the session; with `ALWAYS_OPEN` candles are continuous. The **current (forming) candle** is included with `closed: false` and its values computed up to `now` (the injected clock); every earlier candle has `closed: true` and is immutable (same inputs, same bytes, forever).
- **D-82** Prior close and day change (server-computed, strings, no browser math): for stocks in `NYSE` mode, `prevClose` = close of the previous regular session and `changeBasis = PREV_SESSION_CLOSE`; for crypto and for `ALWAYS_OPEN` stocks, `prevClose` = price 24 hours ago (the candle-grid price at `now − 24h`) and `changeBasis = ROLLING_24H`. `change = last − prevClose`, `changePct = change / prevClose × 100` rounded **2 dp HALF_EVEN** using `@vantage/money` (exact decimals; `last` falls back to mid only if no last, labelled). If there is no prior data (e.g. before the instrument exists in the universe) the fields are `null`, never 0. Add to the quote contract as optional fields (like `spread` in M6b): `prevClose`, `change`, `changePct`, `changeBasis`.
- **D-83** Equity-curve catch-up (resolves the M5 "stored marks" caveat for SIM): the snapshot job's catch-up for missed days may use the `CandleProvider` daily close for each held instrument **when the source is SIM**, producing `valued_complete = true` snapshots labelled with `quote_asof` = that close time and a new nullable column or note field value indicating `mark_source = 'SIM_CANDLE'` (add a forward-only migration only if the table has no suitable field; otherwise reuse existing columns). For any other source the M5 honesty rule stays: missing marks → `valued_complete = false`. Never use today's price for an old date; candle closes are the price **of that date**.

## 4. Tasks (in order; verify each; commit after each)

**T0 · Small M7a leftovers.** Search box placeholder → "Search stocks, ETFs and crypto" (and its test). Add an e2e launcher option for `SIM_SESSION=ALWAYS_OPEN` and one e2e test asserting the "Simulated 24/7 session" banner text and that a stock is tradable at an injected weekend instant (control: NYSE mode closed at the same instant).

**T1 · Pure candle model (`packages/market-model`, lint-clean: no clock, no randomness, no IO).** `buildCandles(...)` per D-80/D-81 on top of the existing SIM price function, plus `prevClose(...)` per D-82. Required properties (property tests with fast-check) and golden vectors (hard-coded strings, hand-verified in comments, independent BigInt check where practical):
- `low ≤ min(open, close) ≤ max(open, close) ≤ high`; prices are tick multiples; positive.
- Contiguity: `open(n+1) = close(n)` for consecutive candles of the same interval.
- Aggregation: for 1m → 5m → 15m → 1h, a larger candle's open/close equal the first/last of its smaller candles, high = max, low = min, volume = sum (exact). For 4h and 1d (coarser grid) document and test the weaker invariant you actually guarantee (`high ≤` aggregated high, `low ≥` aggregated low) — or choose a model that keeps exact aggregation if you can do so within the cost limit below.
- Determinism: same inputs → identical output; order of requests doesn't matter; different seed → different output (control).
- Bounded cost: one request of the maximum size (see T2) completes in a bounded number of price evaluations; report the number and the measured time.
- NYSE mode: no candles on weekends/holidays/outside sessions; early close respected; DST edges (a March and a November date) correct; ALWAYS_OPEN continuous.

**T2 · API: `GET /v1/market/candles`.** Query: `symbol`, `interval` (enum above), `from`, `to` (ISO instants, optional; default = the latest `limit` candles ending at `now`), `limit` (default 200, **max 500**). Auth as the other market endpoints (follow the existing pattern; decide and document whether quotes/candles are public or session-only — consistent with `/v1/market/feed` public and `/v1/quotes`). Response: `{ symbol, interval, source, synthetic, candles: [{ t, o, h, l, c, v, closed }] }`, prices as strings, ascending by time. Validation: unknown symbol → 404 `INSTRUMENT_NOT_FOUND`; bad interval/range/limit → 400 with the standard error format; `from > to`, ranges producing more than `limit` candles are clipped to `limit` from the **end**, with a `truncated: true` flag; no instrument is ever served without a source label. Caching: closed candles are immutable, so responses that contain only closed candles may carry `Cache-Control: public, max-age=…` and an ETag; responses with the forming candle use `no-store` or a very short max-age. Rate limit: reuse the existing market-data limiter; max-size requests must not be a cheap DoS (the bounded-cost property from T1 is the protection; test it). Contracts in `@vantage/contracts`; update `docs/api.md`.

**T3 · Quotes: prior close and day change.** Extend the quote service/contract per D-82 (`prevClose`, `change`, `changePct`, `changeBasis`). Make sure `/v1/quotes`, the instrument endpoint(s) and the order preview's embedded quote all carry the new fields consistently (they come from one function). Web: show change and change % in the quote panel and search results **from the API strings only** (sign, arrow, plus the existing colour-not-only rule), with the basis in a tooltip/label ("vs previous close" / "24h"). No browser arithmetic (existing lint ban applies to the new code). Update web unit tests and one e2e.

**T4 · Snapshot catch-up (D-83).** Wire the daily-close lookup into the M5 snapshot job for SIM. Tests with the injected clock: an account that held a position for 5 days while the app was down gets 5 complete snapshots with the correct closes (exact strings, computed independently in the test from the pure functions); no snapshot uses a later price; a non-SIM source still produces `valued_complete=false` (control); idempotent re-run; early-close and holiday days handled in NYSE mode; weekend days in crypto-only accounts valued correctly.

**T5 · Tests.**
Unit: everything in T1; contract tests for candles and the new quote fields; web display tests for change/changePct (exact strings in, exact strings out, including negative, zero, very small and very large; `null` renders "—").
Integration (real Postgres, HTTP): endpoint happy paths for stock and crypto in both session modes; validation errors; limit/truncation behaviour; ETag/Cache-Control behaviour for closed vs forming candles; immutability test (the same closed candle requested at two different `now` values is byte-identical); 100 parallel requests at max size stay within a stated time budget (report p50/p95, not a hard gate unless clearly safe); auth/rate-limit; the forming candle changes as the injected clock advances while earlier candles do not.
E2E (existing Playwright): quote panel shows change and basis; crypto vs stock basis differ; `null` change renders "—"; ALWAYS_OPEN banner test from T0.
- Done when: `pnpm verify` green; `pnpm test:integration` green twice in a row; e2e green locally; no leftover `t_*` DBs.

**T6 · Docs.** `docs/market-data.md` (candle model, grids, invariants, session rules, prior-close definitions, cost bound, how a future real provider plugs in), `docs/api.md`, `docs/web.md`, `docs/portfolio.md` (catch-up), append D-79..D-83 to `docs/specs/DECISIONS.md` (zero deletions).

## 5. Out of scope
Chart UI/Lightweight Charts (M9); WebSocket/SSE streaming; portfolio day P&L per position (needs "bought today" logic; later); fractional/crypto trading (M8); limit orders and order book (M8b); real provider; stored candle tables; CI/GitHub changes.

## 6. Common mistakes
Floats in candle math or change %; non-contiguous candles; a forming candle served as immutable/cached; candles on closed market days in NYSE mode; wrong DST handling; `0` instead of `null` when there is no prior close; computing day change in the browser; unbounded work per request; leaking `SIM` as a real source name; edits to old migrations; weakening M5's honesty rule for non-SIM sources.

## 7. Verification (clean clone of the branch)
```powershell
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate ; pnpm db:migrate ; pnpm db:status
pnpm verify
pnpm test:integration          # second consecutive run
pnpm --filter web build
pnpm --filter web test:e2e
node apps/api/dist/main.js --check
pnpm db:down
```

## 8. Acceptance criteria (PASS / FAIL / UNVERIFIED, each run)
1. Step 0 baseline green. 2. Candle goldens exact and independently checked. 3. Properties: OHLC bounds, tick multiples, contiguity, exact aggregation up to 1h and the documented weaker invariant for 4h/1d. 4. Determinism and immutability of closed candles. 5. Session rules incl. early close and DST edges; crypto continuous; ALWAYS_OPEN continuous. 6. Endpoint validation, truncation, caching headers, auth, rate limit; bounded cost measured. 7. Prior close/day change definitions implemented exactly; `null` handling; strings only in the web UI. 8. Snapshot catch-up uses same-date closes only, complete for SIM, incomplete for other sources. 9. T0 leftovers done and tested. 10. `pnpm verify` green, integration twice, e2e green, no leftover DBs. 11. Docs and D-79..D-83 appended, zero deletions.

## 9. Final report (`docs/phase-reports/M7b-report.md`, print the FULL report in the reply)
1. Status: READY / READY WITH CAVEATS / NOT READY for M8 (≤ 5 lines). 2. Dependency changes. 3. Task status T0–T6. 4. Files created/modified. 5. Commands with exit codes; failing output verbatim. 6. Acceptance table with evidence and the cost/latency numbers. 7. Test list with controls. 8. Deviations, spec questions. 9. Known limitations and what M8 (fractional crypto trading) and M9 (charts UI) need from this phase, including the exact candle endpoint contract for the UI.

Do not start M8. Stop after the report.
