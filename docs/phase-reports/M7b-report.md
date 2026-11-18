# M7b report: candles, prior close and day change

Branch `phase/m7b-candles`. Not pushed.

## 1. Status

**READY WITH CAVEATS for M8.** T0 to T6 are done. Verified on a clean clone of the branch (final run at b24efcc): `pnpm verify` exit 0 (1,091 unit tests, 408 integration tests), a second consecutive `pnpm test:integration` exit 0 (408 passed, 3 skipped), e2e 80 of 80 passed plus 1 of 1 in the always-open profile, no leftover `t_*` databases, `--check` 0 / 2 / 64. Caveats: `pnpm --filter web build` alternates between exit 0 and exit 1 on identical code because `next build` prints a security-advisory notice for the pinned Next.js 16.4.3 and stops (section 5, 8); a cold maximum daily candle request costs about 0.7 s of CPU (section 6).

## 2. Dependency changes

None. No `package.json` or lockfile change.

## 3. Task status

| Task                                                                                                                                    | Status                | Commit               |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------- |
| Step 0 (main contains M7a by fast-forward, no divergence from `origin/main`; branch; baseline `pnpm verify`: 993 unit, 363 integration) | DONE                  |                      |
| T0 Leftovers (search copy, always-open e2e profile and test, NYSE control)                                                              | DONE                  | 62d4052              |
| T1 Pure candle model, prior close, day change                                                                                           | DONE                  | c3cb75a              |
| T2 `GET /v1/market/candles`                                                                                                             | DONE                  | eb28b0c              |
| T3 Quote day change (API and web)                                                                                                       | DONE                  | 7347118, fix b24efcc |
| T4 Snapshot catch-up from SIM candles                                                                                                   | DONE                  | 38e2478              |
| T5 Tests                                                                                                                                | DONE (with each task) |                      |
| T6 Docs and D-79..D-83                                                                                                                  | DONE                  | 1a49aa8              |

## 4. Files

**Created:** `packages/market-model/src/candles.ts` and `candles.test.ts`; `apps/api/src/modules/market-data/candles/{candle.provider.ts, candle.service.ts, candles.int.test.ts}`; `apps/api/src/modules/portfolio/snapshots-sim.int.test.ts`; `db/migrations/0026_equity_snapshot_mark_source.sql`; web `src/lib/change.ts` and `change.test.ts`, `src/components/change-cell.tsx`, `e2e/{change,always-open}.spec.ts`, `e2e/run-all.mjs`; `docs/prompts/M7b_candles.md`; `docs/phase-reports/m7b/*.png`; this report.

**Changed:** market-model `sim.ts` (integer tick-unit prices and a cheaper knot hash; every golden string unchanged), `sim-universe.ts` (synthetic volume parameters), `index.ts`; contracts (`CandlesQuery`, `CandleItem`, `CandlesResponse`, `changeFields` on `QuoteItem` and the preview quote, `EquitySnapshot.markSource`) and tests; config (`CANDLES_RATE_LIMIT_PER_MINUTE`) and tests; API `market-data.module.ts` (route, providers, limiter), `quote.service.ts` (`changeFor`), `orders.service.ts` (preview embeds the change), `snapshot.service.ts`, `portfolio.service.ts`, `tokens.ts`, `testing/e2e-server.ts`; web `quote-panel.tsx`, `search-box.tsx`, `playwright.config.ts`, `global-setup.ts`, `package.json` scripts, `eslint.config.mjs` (money guard covers the new files); older tests adjusted for the new fields; `.env.example`, `docs/market-data.md`, `docs/api.md`, `docs/web.md`, `docs/portfolio.md`, `docs/specs/DECISIONS.md` (5 rows added, 0 deletions). No applied migration was edited.

## 5. Commands and exit codes

Clean clone of the branch at `b24efcc` (shared Postgres on 55433; the main copy's database was stopped first and restored afterwards):

| Command                                                   | Exit                                                                       | Result                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `setup:env`, `db:reset` | 0                                                                          |                                                                                                      |
| `pnpm db:migrate` (twice)                                 | 0, 0                                                                       | first applies 0001 to 0026, second "No migrations to run!"                                           |
| `pnpm db:status`                                          | 0                                                                          | 0026_equity_snapshot_mark_source applied                                                             |
| `pnpm verify`                                             | 0                                                                          | format, lint, typecheck, build, 1,091 unit tests (39 files), 408 integration tests passed, 3 skipped |
| `pnpm test:integration` (second run)                      | 0                                                                          | 408 passed, 3 skipped                                                                                |
| `pnpm --filter web build`                                 | **1**                                                                      | see below                                                                                            |
| `pnpm --filter web test:e2e`                              | 0                                                                          | 80 passed (default profile, 4.2 min) and 1 passed (always-open profile)                              |
| leftover `t_*` databases                                  |                                                                            | 0                                                                                                    |
| `node apps/api/dist/main.js --check`                      | 0 with a valid `.env`; 2 with an empty environment; 64 for an unknown flag |                                                                                                      |
| `pnpm db:down`                                            | 0                                                                          |                                                                                                      |

**Failing output, verbatim (the standalone web build).** Compilation, TypeScript and page generation all finish; then:

```
> Build error occurred
Error [SecurityFatalError]: Your version of Next.js is affected by a known security vulnerability.
...
This command stopped to show the upgrade recommendation. Retry the same command to continue the original task.
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  web@0.0.0 build: `next build`
Exit status 1
```

On the same code, repeated runs alternate: in the main checkout three runs gave exit 1, 0, 1. The build inside `pnpm verify` (turbo) passed in every run. This is Next.js's own advisory check for the pinned version 16.4.3, not a code problem. Upgrading is a dependency change outside this phase and the project pins exact versions, so I did not change it. **It needs your decision** (upgrade to a patched Next.js 16.x in its own task); until then the acceptance line "web build exit 0" is only intermittently true.

Other failures during the work, all fixed or environmental: the first clean-clone run was interrupted when the machine went to sleep (one integration run reported 305,546 s and two tests hit 60 s hook timeouts; reruns are clean); my own manual rerun overlapped the script's still-running e2e and failed with the database going away (discarded); the first e2e run caught a real regression of mine (axe: red change text on the highlighted search row), fixed in b24efcc.

## 6. Acceptance criteria

| #   | Criterion                                                                                                               | Result                      | Evidence                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Step 0 baseline green                                                                                                   | PASS                        | `pnpm verify` before changes: 993 unit, 363 integration                                                                                                                                                                                                                                                                                                       |
| 2   | Candle goldens exact and independently checked                                                                          | PASS                        | `candles.test.ts`: hard-coded candles (BTC 1h and 1d, DOGE 15m, AAPL 5m at the open, 1h, 4h, 1d, the early close, the 24/7 Saturday); structure checked by hand in comments (instants such as 1794321000 = 2026-11-10T14:30:00Z); prices recomputed in the test by a separate loop over `simMid` strings; the daily close equals the previous-close reference |
| 3   | Properties: OHLC bounds, tick multiples, contiguity, exact aggregation to 1h, documented weaker invariant for 4h and 1d | PASS                        | fast-check (120 runs each); aggregation tests for 6 cases (two crypto, three stocks including the early close and the first daylight-time day, the 24/7 session on a Saturday) against 1m children, clipped session edges included; the weaker invariant has a test showing a coarse candle is sometimes strictly narrower                                    |
| 4   | Determinism and immutability of closed candles                                                                          | PASS                        | same inputs identical, unrelated requests in between change nothing, another seed differs (control); unit and HTTP: the same closed candles at three different "now" values are byte-identical with the same ETag                                                                                                                                             |
| 5   | Session rules: early close, DST edges, crypto continuous, ALWAYS_OPEN continuous                                        | PASS                        | none on weekends or Thanksgiving in any interval; 2026-11-27 ends at 18:00Z (4 hourly, 210 one-minute candles); 2026-03-06 (open 14:30Z) against 2026-03-09 (13:30Z), 2026-10-30 against 2026-11-02; Saturday candles exist only in the 24/7 session                                                                                                          |
| 6   | Endpoint validation, truncation, caching headers, auth, rate limit; bounded cost measured                               | PASS                        | `candles.int.test.ts` (33 tests): 12 validation cases with the standard error format, 404s, 401, newest-`limit` truncation, ETag and 304, `no-store` for the forming answer, rate limit with `Retry-After`, bounded cache. **Cost** below                                                                                                                     |
| 7   | Prior close and day change exact; `null` handling; strings only in the web UI                                           | PASS                        | goldens (AAPL -3.61 / -1.89, BTC 3,364.25 / 4.67), half-even rows (0.005 gives 0.00, 0.015 gives 0.02), a BigInt reference property test (500 runs), null cases, one function for quotes and the preview; web: exact strings in and out, dash for null, lint-banned arithmetic in the new files; e2e                                                          |
| 8   | Snapshot catch-up uses same-date closes only, complete for SIM, incomplete for other sources                            | PASS                        | 5 missed sessions across Thanksgiving and an early close give 5 complete snapshots with exact closes computed independently; idempotent; fixture control incomplete; DST edge; crypto around a weekend (see deviation 8)                                                                                                                                      |
| 9   | T0 leftovers done and tested                                                                                            | PASS                        | placeholder asserted in e2e; always-open profile test and its NYSE control                                                                                                                                                                                                                                                                                    |
| 10  | `pnpm verify` green, integration twice, e2e green, no leftover DBs                                                      | PASS, with the build caveat | section 5                                                                                                                                                                                                                                                                                                                                                     |
| 11  | Docs and D-79..D-83 appended, zero deletions                                                                            | PASS                        | `git diff --numstat` for `DECISIONS.md`: 5 additions, 0 deletions                                                                                                                                                                                                                                                                                             |
|     | Screenshots                                                                                                             | PASS                        | `docs/phase-reports/m7b/`: `quote-change-stock-1280.png`, `quote-change-crypto-1280.png`, `search-change-1280.png`                                                                                                                                                                                                                                            |

**Cost and latency (measured through the service, Windows, Node 22.19, one process; the clean-clone runs were slower because the machine was busy).** Evaluations are for 500 closed candles of a 24/7 market; the bound is `limit x (interval / grid + 1)`:

| Interval | Evaluations | Bound   | Cold (development run) | Cold (clean clone) | Cached     |
| -------- | ----------- | ------- | ---------------------- | ------------------ | ---------- |
| 1m       | 501         | 1,000   | 7 ms                   | 5 ms               | about 2 ms |
| 5m       | 2,501       | 3,000   | 16 ms                  | 14 ms              | about 2 ms |
| 15m      | 7,501       | 8,000   | 41 ms                  | 37 ms              | about 2 ms |
| 1h       | 30,001      | 30,500  | 153 ms                 | 130 ms             | about 2 ms |
| 4h       | 24,001      | 24,500  | 126 ms                 | 107 ms             | about 2 ms |
| 1d       | 144,001     | 144,500 | 791 ms                 | 657 ms             | about 2 ms |

100 parallel identical maximum daily HTTP requests: total 1.1 to 2.4 s, p50 1.0 to 2.3 s, p95 1.1 to 2.4 s (one computation, 99 cache hits; budget asserted: under 30 s). 24 distinct cold maximum daily requests: p50 696 to 1,745 ms, p95 724 to 2,052 ms, max 804 to 2,216 ms (asserted under 10 s); the later numbers are from runs while other work used the machine. The answer cache is bounded (at most 60,000 candles, tested by overfilling it).

## 7. Tests

**Unit** (1,091 in total): `candles.test.ts` (55: goldens, sessions, DST, aggregation, properties, forming candle, truncation, cost bound, reference price, day change including a BigInt reference); `sim.test.ts` unchanged and still passing after the refactor (36: the goldens prove identical strings); always-open calendar and config tests; contracts (`CandlesQuery`, `CandleItem`, `CandlesResponse`, quote change fields, the UNAVAILABLE rule); web `change.test.ts` (22: exact strings, negative, zero, tiny, huge, null, property test, rendering, compact colour).

**Integration:** `candles.int.test.ts` (33), `sim.int.test.ts` (+6: day change goldens, both bases, null cases, the preview embeds the same fields, UNAVAILABLE has none), `snapshots-sim.int.test.ts` (6); older tests adjusted for the new fields.

**E2E:** `change.spec.ts` (4: stock change against the previous close, crypto change over 24h, null renders the dash, search results), `always-open.spec.ts` (1, own profile and API), NYSE control in `sim-feed.spec.ts` (1).

**Controls:** another seed changes candles; the NYSE session has no Saturday candles while the 24/7 session does; a fixture-mode catch-up is incomplete while SIM is complete; a different user keeps their own allowance; the validator-style "must fail" cases (reversed range, limit 501, unknown interval); `If-None-Match` with another tag gives a full answer.

## 8. Deviations and spec questions

1. **Candle close (D-80).** The prompt defines close as "the price at the last sampled instant before the next candle's open" and also requires `open(n+1) = close(n)` exactly. Both hold only if close is the price at the next candle's first instant, so that is what is built (documented in D-80). No spec conflict required stopping.
2. **Selection by open time.** Candles are selected by their reported open time `t` (a clipped first candle keeps its aligned `t`, for example 14:00Z for a session opening at 14:30Z), and only once they have begun. Found while testing the API (first draft selected by the clipped instant).
3. **`from > to` is a `400`** (read as a bad range); too many candles are clipped to the newest `limit` with `truncated: true`.
4. **No existing market-data rate limiter existed to reuse.** I added a per-user limiter in cost points (`CANDLES_RATE_LIMIT_PER_MINUTE`, default 120; a maximum daily request costs 8), because a flat per-request limit would let one user buy several seconds of CPU a minute.
5. **Session-only endpoint with `Cache-Control: private`** (not `public`): `/v1/quotes` needs a session, and a public cache could serve it without one. Strong ETag and 304 on closed answers.
6. **New error `404 CANDLES_UNAVAILABLE`** (not in the prompt) for an existing instrument no candle source serves (fixture mode, crypto feed off, kill switch).
7. **History starts at 2026-01-01T00:00:00Z** (my choice, the start of the calendar data); before it there are no candles and the day change is null.
8. **Crypto "weekend days" (T4).** Snapshots stay one per NYSE trading day (D-62), so a crypto-only account has a Friday and a Monday snapshot, each valued at the price at its own session close instant, and no Saturday or Sunday snapshot. I read the requirement that way rather than changing D-62; say if you want calendar-day snapshots for crypto. Crypto cannot be traded yet, so the test opens one instrument for itself.
9. **Migration 0026** adds the nullable `equity_snapshots.mark_source` column (D-83 allowed it when no field existed).
10. **Instrument item has no quote**, so it carries no change fields; the web search calls `/v1/quotes` once for its results. The order preview's embedded quote does carry them. I also added `changeOf` (`LAST` or `MID`) to label the price the change is measured from.
11. **Search results use the neutral text colour** for the compact percentage (the red and green tokens failed axe contrast on the highlighted row); the arrow and sign carry the direction.
12. **e2e now runs two profiles** (`e2e/run-all.mjs`; `test:e2e:default` runs one); the API serves answers with `end()` so Express adds no automatic weak ETag.
13. **`sim.ts` was refactored** to exact integer tick units for speed; every golden string is unchanged.
14. **Next.js advisory** (section 5): the pinned 16.4.3 triggers an advisory stop in `next build`. Decision needed.

## 9. Known limitations and what M8 and M9 need

**Limitations.** Prices, candles and volume are simulated and labelled so. A cold maximum daily request blocks the event loop for most of a second; the allowance and cache bound it but one user can still cost seconds of work a minute (a worker thread or shared cache before a public launch). The cache and limiter are in memory and per process. Candle selection uses the aligned open time, so a clipped first candle's `t` is before the session open. No portfolio day P&L per position, no stored candle tables, no chart UI. Volume is synthetic and not tied to orders. The day change depends on the candle provider, so it is null on the fixture feed.

**M8 (fractional crypto trading) needs:** fractional quantities in the order contract, ticket and engine (the instruments already carry 0.00000001 steps, `fractional_ok` and an empty `tradable_in` that M8 fills); a reviewed crypto fee schedule (migration 0025 is a placeholder); a decision on whether crypto snapshots should follow calendar days (deviation 8); the day change and candles already exist for crypto (24h basis).

**M9 (charts) needs, exactly:**

- `GET /v1/market/candles?symbol=BTC-USD&interval=1h&from=2026-11-10T00:00:00Z&to=2026-11-10T15:00:00Z&limit=200`. Session cookie. `interval` is one of `1m`, `5m`, `15m`, `1h`, `4h`, `1d`; `from` and `to` are ISO UTC instants bounding the candle open time (inclusive); `limit` 1 to 500, default 200; without `from` and `to` the answer is the latest `limit` candles ending now.
- Response `200`: `{ symbol, interval, source: "SIM", synthetic: true, truncated, candles: [{ t, o, h, l, c, v, closed }] }`; `t` ISO open time; `o h l c` canonical decimal strings with the instrument's tick decimals (at least 2); `v` decimal string (integer for stocks, 8 decimals for crypto); ascending; `closed: false` only on the forming candle (the last one); when more match than `limit` the newest `limit` are returned with `truncated: true`; `candles: []` for an empty range (for example a weekend on the NYSE session).
- Errors: `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED`, `404 INSTRUMENT_NOT_FOUND`, `404 CANDLES_UNAVAILABLE`, `429 RATE_LIMITED` with `Retry-After`.
- Caching: all-closed past answers have a strong `ETag` and `private, max-age=3600` (send `If-None-Match` for a `304`); answers with the forming candle are `no-store`, so poll them (D-73 style).
- Rules a chart must respect: stocks on the NYSE session have gaps between sessions (no candle between 21:00Z and the next open, and `open(n+1) = close(n)` holds only inside a session); the first and last candle of a session are clipped (`t` is aligned, prices are read at the session edges); the 1d candle of a stock is the session and starts at the open; 4h and 1d highs and lows can be narrower than the finer candles; everything is simulated and should be labelled with the returned `source`.
- Quotes also carry `prevClose`, `change`, `changePct`, `changeBasis`, `changeOf` for a header; all null when unknown, display "—", never 0.
