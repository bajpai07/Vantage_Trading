# VANTAGE · Claude Code Prompt · M3a — MARKET MODEL, INSTRUMENTS, QUOTES, WATCHLISTS (provider-independent)

Environment and rules carry over from M0–M2: native Windows, PowerShell, Docker Desktop, repo at `C:\dev\vantage` (not in OneDrive), Node 22.19.0, Postgres port from `POSTGRES_HOST_PORT`, exact dependency versions, LF endings, no secrets in git or on command lines, stop-and-report on ambiguity, never mark anything passed unless you ran it, no push (unless a separate task told you), no UI.

## 1. Goal

Everything the trading engine and the UI will need from "market data", **except a real data vendor** (not chosen yet; that is M3b). At the end:
- instruments (US stocks and ETFs) exist in the database, are searchable, and can be loaded by an idempotent sync job;
- one shared, pure **freshness function** and one pure **quote validator** decide what a quote is (`REAL_TIME`, `DELAYED`, `STALE`, `CLOSED`, `UNAVAILABLE`);
- an exchange **calendar** (sessions, holidays, early closes) says whether a market is open;
- quotes flow through `provider → normalise → validate → store → read`, with a clearly labelled **FIXTURE** provider used **only** in `local` and `test`;
- authenticated users can search instruments, read quotes with their labels, see market status, and manage watchlists.

**Hard rule: no fabricated data is ever presented as real.** Fixture data is allowed only in local/test, carries `source: "FIXTURE"` everywhere (database, API, logs), and the app must refuse to start in staging/production if fixture instruments or a FIXTURE source are present.

Read first: MARKET_DATA §1, §2.1, §4–§8, §13; DATABASE §4, §9 (watchlists), §10 (search/performance); TRADING_ENGINE §2, §3; PRD §5.2 (FR-INS) and §5.10 (FR-WL); `docs/api.md`; the M2 report. If a spec is ambiguous or contradicts this prompt, stop and report.

## 2. Step 0

1. Make sure local `main` contains M2 (if `origin` exists, `git fetch` and make sure local `main` is not behind `origin/main`; if main has diverged, STOP and report). Create branch `phase/m3a-market`.
2. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify` must pass before you change anything. If the local database has stale passwords use `pnpm db:reset`; otherwise stop and report.

## 3. Decisions for this phase (record in DECISIONS as `APPROVED by founder (M3a)` unless you object with a reason)

- **D-45 Data access:** watchlists and instrument reads use plain `pg` repositories (like the ledger). Prisma is deferred again: the CRUD surface is tiny, and a second database client adds generate/introspection steps on Windows and in CI for little value. Re-evaluate when CRUD volume grows (M5/M6).
- **D-46 Quote store:** an in-memory `QuoteStore` behind an interface (single process). A Redis implementation replaces it when real-time fan-out or multiple processes are needed.
- **D-47 Calendar:** the source of truth is `exchanges.calendar` (JSONB) as in DATABASE §4, filled by a SQL migration with data taken from the exchange's official published calendar. A yearly update is a new forward-only migration. The calendar is parsed and validated with Zod at load.
- **D-48 FIXTURE:** a `FixtureProvider` exists for local/test only. Its instruments carry `attrs.source = 'FIXTURE'`. A startup guard refuses to boot when `APP_ENV` is staging or production and any instrument has `attrs.source = 'FIXTURE'` or the quote source is FIXTURE.

## 4. Tasks (in order; verify each; commit after each)

**T1 · `@vantage/market-model` (pure and deterministic; no IO, no `Date.now`; time is always an argument).** Covered by the existing determinism/no-float lint rules (extend the guard to this package if it is not already). Money-like values (`bid`, `ask`, `last`) are decimal strings handled with `@vantage/money`.
- Types: `RawQuote`, `Quote` (bid, ask, last, size fields optional, `providerTs`, `receivedAt`, `source`, `entitlement`, `delaySeconds`), `FreshnessState`.
- `freshness(quote | null, instrumentStatus, calendarState, now)`: TRADING_ENGINE §3 exactly. `UNAVAILABLE` when there is no valid quote ever or the feed is disabled; `CLOSED` when the market is closed per calendar (quote is last close); otherwise `REAL_TIME` (entitlement REAL_TIME and age ≤ 5 s for equities) or `DELAYED` (age − declared delay ≤ 60 s); else `STALE`. Thresholds are named constants. Returns the state and `ageSeconds`.
- `validateQuote(raw, lastAccepted, pendingGap, now)`: MARKET_DATA §6. Reject: bid or ask ≤ 0; crossed (bid > ask); `providerTs` more than 2 s in the future; `providerTs` older than the last accepted quote; negative size. Outlier: a change over 10% from the last accepted quote is **held as pending** and accepted (flag `gapConfirmed`) only if a second consecutive tick confirms it; otherwise discarded. A price that is not a multiple of tick size is a **warning only**. Returns `{ accepted | rejected(reason) , nextPending }`. Never "fix" a quote silently.
- Calendar: `parseCalendar(json)` (Zod), `marketState(calendar, instant)` → `OPEN | CLOSED` plus the current session and next open/close instants. Use IANA time zones (via `Intl` or one small pinned library you justify; no fixed UTC offsets). Handle regular sessions, holidays, early closes, weekends, and both daylight-saving transitions.
- Tests (table-driven): every freshness state and boundary (exactly 5 s, 60 s, 900 s declared delay), every rejection reason, the outlier-confirmed and outlier-discarded paths, calendar cases (weekday open/close edges, a holiday, an early close, weekend, the DST start and end days in March and November), and fast-check properties (freshness never returns an "open" state when the calendar says closed; validation never accepts a crossed quote).

**T2 · Migrations (plain SQL, forward-only).**
1. Enums `asset_class`, `instrument_status`, `quote_entitlement`, `freshness_state` (DATABASE §2, if not yet created). Tables `exchanges`, `instruments`, `instrument_provider_map` exactly as DATABASE §4 (including both trigram indexes), plus `watchlists` and `watchlist_items` from DATABASE §9. Use `fractional_ok = false`, `qty_step = 1`, `min_qty = 1` for stocks/ETFs (whole shares, TRADING_ENGINE §1 and D-33).
2. Seed `exchanges` for `XNYS`, `XNAS` and `ARCX` (time zone `America/New_York`) with the calendar JSON for the calendar years **2026 and 2027**. **Source the dates from the exchange's official published holiday and early-close schedule** (NYSE; Nasdaq follows the same) and put the source URL and retrieval date in a comment at the top of the migration. If you cannot read the official source, STOP and report; do not write holiday dates from memory.
3. Grants to `vantage_app` (explicit, minimal): `SELECT` on `exchanges`, `instrument_provider_map`; `SELECT, INSERT, UPDATE` on `instruments` and `instrument_provider_map` (no DELETE; delisting is a status change); `SELECT, INSERT, UPDATE, DELETE` on `watchlists`, `watchlist_items`. Nothing else. Add `CHECK`s: watchlist name 1–40 characters; limits (20 lists per user, 100 items per list) are enforced in the service **and** by a trigger or constraint so a bug cannot exceed them.
- Done when: migrations apply twice (second no-op).

**T3 · Provider interface, fixture provider, quote pipeline** (`apps/api/src/modules/market-data`).
- `MarketDataProvider` interface (MARKET_DATA §4, trimmed to what M3a needs): `id`, `capabilities()`, `loadInstrumentMaster()`, `getSnapshot(symbols)`, `health()`. Candles and subscriptions are out of scope.
- `FixtureProvider`: deterministic, with an **injected clock**, about 30 well-known US stocks and ETFs (real names, real exchange codes), fixture prices that are obviously synthetic, `source = "FIXTURE"`, entitlement `DELAYED` with `delaySeconds = 900` so the delayed paths are exercised. It can be told to emit stale, crossed, outlier and out-of-order quotes for tests. It throws if constructed when `APP_ENV` is `staging` or `production`.
- `QuoteStore` interface (get, set, per-symbol last-accepted and pending-gap) with the in-memory implementation.
- `QuoteIngest`: normalise (UTC timestamps) → `validateQuote` → store; per-feed counters (accepted, rejected by reason, out-of-order); mark the feed `DEGRADED` when the rejection rate exceeds 1% over a rolling window (injected clock).
- `QuoteService.getQuotes(symbols)`: returns, for **each** requested symbol, the quote (if any), the freshness from the shared `freshness()`, `source`, `entitlement`, `ageSeconds`, `asOf`. When no valid quote exists it returns `UNAVAILABLE` and **no price**. It never returns a made-up price.
- `MARKET_DATA_SOURCE=PROVIDER` has no adapter yet: the app must exit with a clear error ("no provider adapter installed; M3b"). `FIXTURE` is accepted only in `local`/`test` (existing config guard).
- Startup guard (D-48): refuse to boot in staging/production when any instrument has `attrs.source = 'FIXTURE'`.

**T4 · Instrument master sync.**
- `syncInstrumentMaster(provider)`: upserts `instruments` by `(exchange, symbol)` and `instrument_provider_map` in one transaction. **Idempotent:** a second run changes nothing (do not touch `updated_at` when values are equal; test with row comparison). Missing instruments are not deleted; they are set to `DELISTED` only if the provider explicitly reports it, otherwise left alone and logged. Quotes never edit instruments.
- Runs at startup in `local`/`test` with the fixture provider and is exposed as a function for a later scheduled job. Document that production data comes from the vendor adapter in M3b.

**T5 · Endpoints** (all require a valid session; follow the `docs/api.md` conventions: `/v1`, error envelope, Zod schemas in `@vantage/contracts`; **all prices are canonical decimal strings**).
- `GET /v1/instruments/search?q=` (min 1 character, max 40; at most 20 results): exact symbol match ranks first, then prefix, then trigram similarity on symbol and name; each result has symbol, name, assetClass, exchange (MIC), currency, status, `entitlement` and `source` labels. Use parameterised SQL with `pg_trgm`; escape `%`/`_`; never concatenate input into SQL.
- `GET /v1/instruments/:symbol`.
- `GET /v1/quotes?symbols=A,B` (1–50 symbols, unknown symbols reported per symbol, never silently dropped).
- `GET /v1/market/status`: per exchange `OPEN/CLOSED`, current session, next open/close.
- Watchlists: `GET /v1/watchlists`, `POST /v1/watchlists`, `PATCH /v1/watchlists/:id` (rename/reorder), `DELETE /v1/watchlists/:id`, `POST /v1/watchlists/:id/items`, `DELETE /v1/watchlists/:id/items/:symbol`, plus reorder items. A user can only see and change their own lists (return 404, not 403, for other users' lists). Adding an instrument twice is a 409 or an idempotent no-op (choose, document, test).
- A response carrying quotes always includes `source` and `freshness`; never a bare price.

**T6 · Tests** (real Postgres via `createTestDatabase()`, app as `vantage_app`; each "must fail" has a "control succeeds").
1. Sync: first run inserts the fixture instruments; second run produces **zero diffs**; fixture rows carry `attrs.source = 'FIXTURE'`.
2. Search: exact symbol first (200 generated symbol cases from the fixture set and a synthetic list); typo tolerance (`APPL` finds `AAPL`); wildcard and quote characters in `q` are safe; an empty or oversized `q` is rejected. Add a **benchmark script** (not a CI gate) that loads 20,000 **synthetic** instruments into a throwaway test database (tagged synthetic) and prints p50/p95 search latency; report the numbers.
3. Quotes through the API: each freshness state appears with the right label when the injected clock is moved (REAL_TIME is not reachable with the DELAYED fixture feed; prove DELAYED, STALE, CLOSED, UNAVAILABLE). An unknown or never-quoted symbol returns `UNAVAILABLE` and **no price field**. Crossed, outlier-unconfirmed, future-dated and out-of-order fixture quotes are rejected and counted; an outlier confirmed by a second tick is accepted with `gapConfirmed`.
4. Guards: constructing `FixtureProvider` with `APP_ENV=production` throws; booting with `MARKET_DATA_SOURCE=PROVIDER` exits with the clear error; the startup guard refuses to boot when a fixture instrument exists and `APP_ENV=staging`. Control: local/test boot normally.
5. Calendar: market status matches hand-checked instants for a normal day, a holiday, an early close (using the verified 2026–2027 data), and the DST days.
6. Watchlists: CRUD works; limits (21st list, 101st item) fail at the service **and** at the database (try inserting directly as `vantage_app`); another user's list returns 404; deleting a list removes its items; unauthenticated gets 401. `vantage_app` has no DELETE on `instruments` (permission denied) but can insert/update (control).
7. Safety: no response, log line or error contains a session cookie or password; every quote in every response has `source` and `freshness`.
- Done when: `pnpm verify` is green and `pnpm test:integration` passes **twice in a row** with no leftover `t_*` databases.

**T7 · Docs and decisions.**
- `docs/market-data.md` (short): the pipeline, freshness table, validation rules, calendar source and how to update it each year, the FIXTURE policy, and "what M3b adds".
- Update `docs/api.md` with the new endpoints. Append D-45 to D-48 to the `docs/specs/DECISIONS.md` table (no edits to existing lines; zero deletions). Add one append-only note to ARCHITECTURE: "API conventions (`/v1`, error envelope, cookie sessions) follow `docs/api.md`, which supersedes §6 where they differ."
- README: say clearly that local/test quotes are FIXTURE data.

## 5. Out of scope (do not build)
A real provider adapter or any vendor API call; WebSocket, Redis; candles or charts; indices, movers, sector data; a `provider_feeds` table; the subscription manager; crypto, India, FX; price alerts; orders, trading, positions, P&L; UI; admin features; Prisma.

## 6. Common mistakes
Returning a price when the quote is `UNAVAILABLE`; freshness computed in more than one place; reading `Date.now()` inside the model package; holiday dates written from memory; fixture data without a `source` label; fixture instruments surviving into a non-local environment; money as numbers; unescaped `LIKE` patterns; string-built SQL; users reading each other's watchlists; sync that rewrites rows every run; deleting instruments; editing old migrations.

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
2. Freshness: every state and boundary passes; one shared function is used by the API (no duplicate logic).
3. Quote validation rejects each bad case with the right reason; outlier confirmation works; nothing is silently corrected.
4. Calendar data is sourced from the official exchange schedule (URL and date recorded); open/closed, early close, holiday and DST cases pass.
5. Instrument sync is idempotent (second run: zero diffs).
6. Search: exact symbol first in 100% of the test list; typo tolerance works; SQL-injection and wildcard inputs are safe; benchmark numbers reported (UNVERIFIED against the 150 ms target on 20k rows if not met; say so).
7. `UNAVAILABLE` quotes carry no price; every returned quote has `source` and `freshness`.
8. FIXTURE guards: provider cannot be built in staging/production; boot refuses fixture instruments outside local/test; `PROVIDER` mode exits with the clear error.
9. Watchlists: CRUD, limits enforced at service and database level, user isolation, cascade delete.
10. `vantage_app` privileges as specified (no DELETE on instruments; no grants beyond T2).
11. `pnpm verify` green; integration green twice in a row; no leftover test databases.
12. `docs/market-data.md` written; D-45 to D-48 appended with zero deletions.

## 9. Final report (`docs/phase-reports/M3a-report.md`, also printed)
1. Status: READY / READY WITH CAVEATS / NOT READY for M3b and M4 (≤ 5 lines).
2. New dependency versions and how verified (including any date/time library and why).
3. Task status T1–T7.
4. Files created / modified.
5. Commands run with exit codes and durations; failing output verbatim.
6. Acceptance table (12 items) with evidence, the benchmark numbers, and the exact calendar source (URL, date).
7. Test list, each "must fail" with its control.
8. Deviations, surprises, spec questions (stop-and-report format).
9. Known limitations and what M3b and M4 need from this phase.

Do not start M3b or M4. Stop after the report.
