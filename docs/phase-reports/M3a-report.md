# M3a report — Market model, instruments, quotes, watchlists (provider-independent)

Branch `phase/m3a-market` (not pushed, no remote exists), based on `main` after a local `--no-ff` merge of `phase/m2-auth` (`536c32e`). Run date 2026-11-11.

## 1. Status

**READY WITH CAVEATS for M3b and M4.**

- T1–T7 are done and verified on a clean clone: `pnpm verify` green (304 unit and 155 integration tests) and `pnpm test:integration` green a second time, no leftover `t_*` databases.
- Caveats: the exchange calendar was read from the official NYSE page through an automated fetch (please re-check the dates against the page yourself, section 6); Nasdaq's page was not read separately; all quotes are FIXTURE data; one small judgement about what `instrumentStatus` does in `freshness()`.

## 2. New dependency versions

No new third-party dependency was added. `@vantage/market-model` is a new workspace package that uses packages already pinned (`zod` 4.6.7, `fast-check` 4.10.2, `@vantage/money`). **Date and time library: none.** Time zones use the platform's `Intl` (IANA tz database in Node 22.19.0), which handles both daylight-saving transitions correctly (tested for March and November 2026 and 2027), so no extra library was justified. All dependency versions remain exact (script check: 0 non-exact).

## 3. Task status

| Task                           | Status | Note                                                                                                                                                                                             |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1 `@vantage/market-model`     | DONE   | `freshness()`, `validateQuote()`, `parseCalendar()`/`marketState()`; 109 tests incl. every state, every boundary, every rejection reason, both outlier paths, DST and 4 properties               |
| T2 Migrations                  | DONE   | 0010 enums, 0011 exchanges/instruments/provider map (both trigram indexes), 0012 calendars 2026-2027, 0013 watchlists with limit triggers, 0014 minimal grants. Applied twice, second is a no-op |
| T3 Provider, fixture, pipeline | DONE   | `MarketDataProvider`, `FixtureProvider` (32 instruments, scripted bad feeds, throws in staging/production), `QuoteStore`, `QuoteIngest`, `QuoteService`, startup guard                           |
| T4 Instrument sync             | DONE   | One transaction, idempotent (zero diffs proven by row comparison), never deletes, DELISTED only when the provider says so                                                                        |
| T5 Endpoints                   | DONE   | search, instrument, quotes, market status, full watchlist CRUD with item reorder                                                                                                                 |
| T6 Tests                       | DONE   | 64 new integration tests plus unit tests; benchmark script                                                                                                                                       |
| T7 Docs and decisions          | DONE   | `docs/market-data.md`, `docs/api.md`, README, D-45 to D-48, ARCHITECTURE note (0 deletions)                                                                                                      |

## 4. Files

Created: `packages/market-model/*`; `packages/contracts/src/{market,money-string,market.test}.ts`; `db/migrations/0010`–`0014`; `apps/api/src/modules/{feed,instruments,market-data,watchlists}/*` (including `market-data/fixture/`); integration tests `instruments`, `market`, `watchlists`; unit tests `market-data.test.ts`, `no-hardcoded-prices.test.ts`; `tools/bench-search.ts`; `docs/market-data.md`; `docs/prompts/M3a_market_model.md`; this report.

Modified: `apps/api/src/{app.module,configure-app,main,tokens}.ts` (modules wired, CORS allows PUT/PATCH/DELETE, PROVIDER-mode exit), `apps/api/src/testing/harness.ts` (clock `set`, `registerUser`, `loginUser`, no pool leak on refused boot), `apps/api/src/modules/auth/security.int.test.ts` (closed-pool test now replaces the market startup step), `packages/contracts/src/index.ts` (the `MoneyString` constant moved to its own file to avoid an import cycle), `eslint.config.mjs` (determinism guard for market-model), `vitest.config.ts`, `package.json` (`bench:search`), `README.md`, `docs/api.md`, `docs/specs/DECISIONS.md` (+4 rows), `docs/specs/ARCHITECTURE.md` (+1 note), all with 0 deletions.

## 5. Commands run (clean clone of the branch)

| Command                                              | Exit | Time                                   |
| ---------------------------------------------------- | ---- | -------------------------------------- |
| `pnpm install --frozen-lockfile`                     | 0    | 13 s                                   |
| `pnpm setup:env --port 55433`                        | 0    | 1 s                                    |
| `pnpm db:up`                                         | 0    | 8 s                                    |
| `pnpm db:migrate` (twice)                            | 0, 0 | 2 s, 2 s                               |
| `pnpm db:status`                                     | 0    | lists 0001–0014 applied                |
| `pnpm verify` (304 unit, 155 integration)            | 0    | 126 s                                  |
| `pnpm test:integration` (second run)                 | 0    | 68 s                                   |
| `node --env-file=.env apps/api/dist/main.js --check` | 0    | `{"app":"api","status":"config_ok"}`   |
| same with an empty environment                       | 2    | names the missing variables, no values |
| same with `--bogus`                                  | 64   | usage line                             |
| `pnpm db:down`                                       | 0    |                                        |

Leftover `t_*` databases: 0. Step 0 baseline (after merging M2): install, `db:up`, `db:migrate`, `verify` all exit 0 (171 unit, 91 integration).

Failures met along the way (all fixed, none hidden):

1. `bans Number() — AssertionError: expected 0 to be greater than 0`: my first version of the market-model guard also allowed `Number(...)`. I kept it banned (integer parsing uses `parseInt(x, 10)`).
2. Two bad string replacements again corrupted a file or did not apply (JavaScript treats `$'` specially in a replacement string); the contracts test file, a config regex (`\d` lost its backslash) and a migration were caught by tests or lint and rewritten with the file editor. Several shell here-documents also failed to parse and were redone with the file tool; nothing was half-applied.
3. A circular import between `contracts/index.ts` and `contracts/market.ts` would have broken at runtime although it type-checked; fixed by moving `MoneyString` into `money-string.ts` before any test ran.
4. After wiring the market startup, one M2 test failed: `Error: Cannot use a pool after calling end on the pool` (the closed-pool health test now needs a database at boot). That test replaces the market startup with a no-op.
5. First search test run: `AssertionError: expected [] to deeply equal ArrayContaining{…}` for the typo `Vangaurd`. Plain trigram similarity on names was too strict; names now use `word_similarity` (threshold 0.4). The required `APPL` to `AAPL` case passed from the start.
6. My own test mistakes, caught by the tests: wrong age in the CLOSED test (26,100 s, not 25,500 s), and moving the clock backwards after a refresh produced `OUT_OF_ORDER` rejections (the test no longer refreshes into the future).

## 6. Acceptance table

| #   | Criterion                                                                                       | Result             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Step 0 baseline green                                                                           | PASS               | After merging M2: all four commands exit 0 (171 unit, 91 integration tests)                                                                                                                                                                                                                                                                                                                               |
| 2   | Freshness: all states and boundaries; one shared function                                       | PASS               | `freshness.test.ts` (REAL_TIME at exactly 5 s inclusive, STALE at 5.001 s, DELAYED at delay + 60 s inclusive, STALE at +60.001 s, CLOSED, UNAVAILABLE variants, 2 properties). `QuoteService` calls `freshness()` and contains no thresholds; the API tests move the injected clock and see DELAYED, STALE, CLOSED, UNAVAILABLE                                                                           |
| 3   | Validation rejects each bad case with the right reason; outlier confirmation; nothing corrected | PASS               | `validate.test.ts` (all 7 reasons, outlier held, confirmed, discarded, replaced, pending preserved, properties) and API tests: crossed, future, out-of-order, negative size, non-positive each rejected and counted while the stored quote is unchanged; confirmed outlier shows `gapConfirmed: true`                                                                                                     |
| 4   | Calendar sourced from the official schedule; open/closed, early close, holiday, DST pass        | PASS (with a note) | Source URL and date below. `calendar.test.ts` and the market-status API tests with hand-computed UTC instants for a normal day, weekend, Thanksgiving, both 2026 early closes, Good Friday, observed holidays, and the March and November 2026 and 2027 DST days. The data was read through an automated page fetch, then checked against the weekday and observance rules; see the calendar source below |
| 5   | Instrument sync is idempotent                                                                   | PASS               | Second run: `inserted 0, updated 0, unchanged 32`; row comparison of `instruments` and `instrument_provider_map` including `updated_at` identical even an hour later; a real change updates exactly one row                                                                                                                                                                                               |
| 6   | Search: exact symbol first in 100%; typos; injection and wildcards safe; benchmark              | PASS               | 200 symbol cases (32 fixture plus 168 synthetic, each also lower-cased): exact symbol first 200 of 200. `APPL` finds `AAPL`, `NVIDA` finds `NVDA`, `Microsft` finds `MSFT`, `GOOG` ranks `GOOGL` first. `%`, `_`, `\`, quotes and `'; DROP TABLE instruments; --` are safe (200, table intact). Benchmark below                                                                                           |
| 7   | UNAVAILABLE carries no price; every quote has source and freshness                              | PASS               | Unknown, never-quoted, DELISTED and kill-switched symbols have no `bid`, `ask` or `last` keys; every `/v1/quotes` item in the test run (over 50) has a source and a freshness; the Zod schema rejects an UNAVAILABLE item with a price                                                                                                                                                                    |
| 8   | FIXTURE guards                                                                                  | PASS               | `FixtureProvider` throws in staging and production; the child process `main.ts` with `MARKET_DATA_SOURCE=PROVIDER` exits 2 with `no provider adapter installed; M3b` (control: `--check` with FIXTURE exits 0); the app refuses to boot in staging when a FIXTURE instrument exists, and a clean staging database passes the guard and stops only on the missing adapter; local and test boot             |
| 9   | Watchlists: CRUD, limits at service and database, isolation, cascade                            | PASS               | 21st list and 101st item refused with 409 by the service and by the database trigger (direct inserts as `vantage_app`: SQLSTATE 23514, named constraints); 5 parallel inserts with 98 items present let exactly 2 in; another user's list is 404 on every operation; deleting a list removes its items but not instruments; 401 without a session                                                         |
| 10  | `vantage_app` privileges as specified                                                           | PASS               | DELETE and TRUNCATE on `instruments`, DELETE on the provider map, and every write on `exchanges` are denied (42501); INSERT and UPDATE on instruments and the map work; watchlists and items can be deleted                                                                                                                                                                                               |
| 11  | `pnpm verify` green; integration green twice; no leftover test databases                        | PASS               | Section 5                                                                                                                                                                                                                                                                                                                                                                                                 |
| 12  | `docs/market-data.md` written; D-45 to D-48 appended with zero deletions                        | PASS               | `git diff --numstat 536c32e HEAD -- docs/specs`: `2 0 ARCHITECTURE.md`, `4 0 DECISIONS.md`                                                                                                                                                                                                                                                                                                                |

**Calendar source:** NYSE, "Holidays and Trading Hours", https://www.nyse.com/trade/hours-calendars, retrieved **2026-11-11**. The page was read through a web-fetch helper, so what I have is its extracted text, not a file I could inspect myself. It lists 2026, 2027 and 2028 and says all NYSE markets (including NYSE Arca) observe the listed holidays. Recorded data: holidays 2026 (Jan 1, Jan 19, Feb 16, Apr 3, May 25, Jun 19, Jul 3 observed, Sep 7, Nov 26, Dec 25) and 2027 (Jan 1, Jan 18, Feb 15, Mar 26, May 31, Jun 18 Juneteenth observed, Jul 5 observed, Sep 6, Nov 25, Dec 24 Christmas observed); early closes at 1:00 p.m. ET on 2026-11-27, 2026-12-24 and 2027-11-26. As an independent check, every date is consistent with the weekday and observance rules (a test asserts all holidays and early closes fall on weekdays), but **please open the page and compare the dates before launch**. Nasdaq's own page was not read; the task states it follows the same schedule.

**Search benchmark** (20,000 SYNTHETIC instruments, throwaway test database, 600 queries mixing exact symbols, short prefixes, typos and name words, on this Windows machine with Docker Desktop):

| Run | p50     | p95      | p99      | max      |
| --- | ------- | -------- | -------- | -------- |
| 1   | 91.1 ms | 122.2 ms | 198.8 ms | 338.0 ms |
| 2   | 88.3 ms | 109.2 ms | 180.4 ms | 208.5 ms |
| 3   | 86.2 ms | 108.5 ms | 180.2 ms | 220.1 ms |

The PRD target (p95 under 150 ms on 20,000 rows) is met on this machine in all three runs, with limited headroom: the query is a sequential scan with trigram similarity (the OR of exact, prefix and similarity conditions does not use the GIN indexes). If this becomes tight, split the query into indexable branches and set `pg_trgm.similarity_threshold` per transaction.

## 7. Test list (each "must fail" with its control)

- **market-model (109 unit tests):** freshness table (every state, 13 boundary rows) with controls; kill switch and DELISTED (control: enabled and ACTIVE give DELAYED); crypto 3 s (control: equity 4 s is REAL_TIME). Validation: a good quote accepted, every rejection reason (15 cases), outlier held, confirmed, discarded, replaced; tick warning (control: on-tick has none). Calendar: open, close and one-millisecond edges, weekends, 5 holidays, observed holidays, 3 early closes, 4 DST transitions, coverage; `parseCalendar` rejects 13 bad inputs (control: the NYSE data parses). Properties: never open when closed, monotone staleness, never accepts crossed, never rewrites an accepted quote, open/closed consistency. ESLint guard: 13 bans (control: allowed constructs pass).
- **Sync (5 tests):** first run, zero-diff second run, single-row update and revert, missing and explicitly delisted instruments, unknown exchange.
- **Search (8 tests):** needs a session (control: with one it works); labels; 200 exact-first cases; typos; wildcards, quotes and SQL (control: normal text still works, table intact); rejects empty, blank, oversized, missing and repeated `q` (control: 1 and 40 characters work); at most 20 results; instrument endpoint.
- **Quotes API (29 tests, with the guards and calendar):** DELAYED labelling, boundary and STALE via the injected clock, CLOSED, UNAVAILABLE for four causes (control: AAPL has a price), five rejection kinds with unchanged stored quote, both outlier paths, feed DEGRADED and recovery, input validation (control: 50 symbols), market status for 6 groups of hand-checked instants, all FIXTURE guards with controls, safety scan of every quote.
- **Watchlists (20 tests):** CRUD, validation (control: 40 characters), duplicate names, idempotent add and remove, reorder, cascade; limits at service and database (control: the 20th list and 100th item work), concurrency; isolation 404 on every operation (control: the owner can), 401 and CSRF on every route; privileges with controls; safety scan of bodies and logs.
- **Unit tests in `apps/api` and `contracts`:** fixture provider (deterministic, labelled, synthetic, scripted, refuses staging), ingest counters and the exact 1% boundary, store, `escapeLike`, no hard-coded price tables outside the fixture directory (with a control for the detector), contract schemas.

## 8. Deviations, surprises, spec questions

**Spec questions I resolved conservatively (please confirm):**

1. `freshness(quote, instrumentStatus, …)`: TRADING_ENGINE section 3 defines the five states without using instrument status. I made `DELISTED` return `UNAVAILABLE` (nothing to quote) and left `HALTED` and `SELL_ONLY` with their quote (a halted quote simply goes STALE). Eligibility by status stays with the trading engine.
2. Determinism guard: the prompt says market-model is covered by the existing no-float rules, but calendar code must parse and divide integers. I added a relaxed variant for this package only: the same bans (clock, randomness, IO, float literals, `parseFloat`, `Number()`) except `parseInt(x, 10)` and `Math.floor/trunc/abs/min/max` are allowed. Prices are never parsed with them; they stay strings handled by `@vantage/money`.
3. Outlier rule: the first outlier tick is returned as rejected `OUTLIER_UNCONFIRMED` (and counted) and held; the confirming second tick is the one accepted, with `gapConfirmed`. MARKET_DATA does not say whether the held tick itself is stored; only the latest matters for the store.
4. Outside the calendar's `coverage` range the market state is `CLOSED` with reason `CALENDAR_NOT_COVERED`, and quotes show `CLOSED`. A yearly update is therefore a real operational task (documented).
5. MARKET_DATA section 13 asks for a grep-based CI check for hard-coded price tables outside `/test`. The fixture provider necessarily contains synthetic prices, so they live in one directory (`market-data/fixture/`) that the check exempts.
6. Symbols are unique per exchange in the database, but the API addresses instruments by symbol alone. The fixture set has no duplicates, so this is safe now; a symbol listed on two exchanges would need an exchange qualifier (M3b or later).
7. `GET /v1/watchlists` returns symbols without prices; a client calls `/v1/quotes` for prices, so no bare price is ever returned from a watchlist.
8. Idempotent choices (documented and tested): adding an instrument that is already in a list returns 200 (201 when added); removing a missing one returns 204.
9. UUIDv7 exchange ids in migration 0012 were generated once and written into the seed.

**Other surprises:** the M2 harness needed a no-op replacement of the market startup for its closed-database test; M2's unit timeout from the previous phase also covers the new ESLint guard tests.

## 9. Known limitations and what M3b and M4 need

- **All quotes are FIXTURE data.** Nothing here is real market data; the README, API docs and every response say so. No vendor was contacted.
- The quote store is in memory (single process, lost on restart); only 3 exchanges and US equities and ETFs exist; no candles, WebSocket, Redis, crypto, India or FX.
- Search is a sequential scan: fast enough at 20,000 rows (p95 about 110 to 120 ms here) but with little headroom.
- Unchanged from earlier phases: file mode 0600 is unverified on Windows; CI has never run (nothing pushed); rate limits are in memory; no email verification.
- **M3b needs:** a real `MarketDataProvider` adapter and licence-backed entitlement config, nightly master sync, provider health and kill switch plumbing (`FeedInfoService.setEnabled` is the hook), and removing `MARKET_DATA_SOURCE=PROVIDER`'s exit. It must keep the calendar refreshed (next update before the end of 2027) and re-verify Nasdaq's page.
- **M4 needs:** read quotes only through `QuoteService`; treat `STALE`, `CLOSED` and `UNAVAILABLE` as not eligible (TRADING_ENGINE section 3); look up the instrument by `(exchange, symbol)` if duplicates ever appear; whole shares only (`qty_step = 1`, `fractional_ok = false` are already in the instrument rows).
- Local state: this checkout's database was reset at the end of the clean-clone run and migrated to 0014 (port 55433).

M3b and M4 were not started.
