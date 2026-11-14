# VANTAGE · Claude Code Prompt · M7a — MARKET DATA FEEDS (live crypto, simulated stocks, honest labelling)

Same standing rules as M0–M6b: native Windows, PowerShell, repo `C:\dev\vantage`, Node 22.19.0, exact dependency versions (verify each on npm, patch at least 2 weeks old), LF endings, no secrets in git or on command lines, specs are the source of truth, stop-and-report on ambiguity, never mark PASS unless you ran it, no push.

## 0. Context change (read carefully)
VANTAGE is now a **portfolio/interview demo** (virtual money, no real users, no real-money trading). It must look and behave like a serious product. It must never mislead: every price on screen says where it came from. Goal of the next phases: crypto (BTC, ETH, …) and US stocks, charts, elite UI. **This phase only builds the data feeds.** Trading crypto (fractional quantities) is M8; candles are M7b; UI is M9. Until M8, crypto instruments are **display-only** (`tradable_in` empty → the engine rejects with `INSTRUMENT_NOT_TRADABLE`).

## 1. Goal
1. A **live crypto feed**: real-time bid/ask (and last trade if available) for a small set of pairs from a public exchange market-data stream, normalised into the existing provider-adapter interface and QuoteStore, with reconnect, heartbeat and stale detection.
2. A **simulated stock feed**: deterministic, seeded, realistic quotes for a set of US stocks/ETFs, clearly labelled `SIM`.
3. **Honest source labelling** end to end: each quote carries `source`; the API's `/v1/market/feed` reports every active source with a human label; the web banner shows each class truthfully (crypto: "Live public exchange data — demo", stocks: "Simulated market data — not real prices").
4. A **demo session override** for simulated stocks (`SIM_SESSION=ALWAYS_OPEN`), so the demo works on weekends and at night, visibly labelled "Simulated 24/7 session".

Read first: `docs/market-data.md`, MARKET_DATA spec (adapter interface, validation, QuoteStore, kill switch), `docs/phase-reports/M3a-report.md`, `docs/phase-reports/M6b-report.md`, `docs/api.md`, `docs/web.md`, DECISIONS (D-09, D-29..D-48, D-64..D-73). If specs conflict with this prompt, stop and report.

## 2. Step 0
Ensure `main` contains M6b (if `origin` exists, fetch; diverged → STOP). Branch `phase/m7a-feeds`. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify` green before changes (stale DB: `pnpm db:reset`).

## 3. Decisions (record as D-74… `APPROVED by founder (M7a)` unless you object with a reason)
- **D-74** Crypto source: a public exchange market-data WebSocket, **read-only, no API key, no account, no trading**. Candidates: Binance public market data (`data-stream.binance.vision` / `stream.binance.com`) and Coinbase Exchange public feed. Task T1 is an **evidence task**: test connectivity from this Windows machine, read each exchange's market-data terms, and record in `docs/market-data.md` the URL of the terms page, the relevant clause (quote it briefly), and your conclusion on personal/portfolio-demo use. Choose one as primary (the other only as documented alternative). If the terms clearly forbid even a non-commercial demo display, or neither is reachable, STOP and report instead of choosing. The adapter sits behind the existing interface so the exchange can be swapped.
- **D-75** Source labels: `SIM` for simulated stocks, the exchange name (e.g. `BINANCE`) for live crypto, `FIXTURE` stays test/local only. Entitlement for the live crypto feed is `REAL_TIME`; for `SIM` also `REAL_TIME` so the shared freshness function works unchanged, but its label is always `SIM`. The label is a first-class field in `/v1/market/feed`, in every quote response and in every execution row (`quote_source`).
- **D-76** `SIM_SESSION=NYSE|ALWAYS_OPEN` (default `NYSE`). `ALWAYS_OPEN` makes the simulated stocks' market state OPEN 24/7 and is **only valid when the stock source is `SIM`** (startup guard otherwise). When active, `/v1/market/status` and the banner say "Simulated 24/7 session". Crypto is always 24/7.
- **D-77** Staging/production guard: `FIXTURE` and `SIM` feeds require `DEMO_MODE=true` (explicit). With `DEMO_MODE=true` the web banner and footer must say it is a demo with virtual money. Without it, the API refuses to start with a simulated source (extends the existing FIXTURE guard).
- **D-78** Simulated price model: seeded geometric random walk per symbol (volatility per symbol from config), prices are multiples of the instrument's tick, spread of 1–3 ticks varying with volatility, tick rate 1 per second per symbol, deterministic given `(seed, symbol, time)` — the price at time T must be reproducible without running continuously (pure function of seed and T, so restarts and tests agree). No randomness from `Math.random` or the wall clock inside pure code; the feed runner injects the clock. Include occasional realistic behaviour (small gaps at session open if `NYSE` mode) but never extreme outliers that trip the validator.

## 4. Tasks (in order; verify each; commit after each)

**T1 · Evidence and decision (D-74).** Connectivity tests (script under `scripts/`, not part of CI): connect to the candidate streams for 30 s, print message rate, latency vs local time, symbol names, field formats. Terms research as described. Write findings into `docs/market-data.md` (section "Crypto source decision") with dates. If STOP condition is met, stop here and report.

**T2 · Live crypto adapter.** In `apps/api/src/modules/market-data` (or its provider folder): a WebSocket client (use a well-known, exact-pinned library or Node's built-in WebSocket if stable on 22.19.0 — justify) implementing the existing provider-adapter interface. Pairs (config list, default BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD, BNB or equivalent as the exchange quotes them; map exchange symbols to VANTAGE symbols in one table). Behaviour:
- Normalise to `RawQuote` (decimal strings, provider timestamp as absolute instant, `receivedAt`, `source`, `entitlement REAL_TIME`, `delaySeconds 0`), run through the **existing** validation (crossed, future ts, out-of-order, outlier) — do not write a second validator.
- Reconnect with exponential backoff + jitter, ping/pong or heartbeat watchdog (no message for N seconds → treat as disconnected, quotes age naturally into STALE), resubscribe after reconnect, bounded memory, graceful shutdown, kill switch (`feedEnabled=false` → UNAVAILABLE).
- Never crash the API on a bad frame; count and log (without secrets) dropped frames per reason; expose counters in a health/diagnostics endpoint that already exists or a small new one (auth not required, no sensitive data).
- Configuration: `CRYPTO_FEED=off|live` (default `off` in test), symbol list, endpoint URL (validated https/wss only, host allow-list).
- The adapter takes an injectable WebSocket constructor/clock so tests run against a **local fake server** (no internet in tests or CI).

**T3 · Simulated stock feed (D-78, D-76).** Pure generator in `packages/market-model` (or engine; pure, lint-clean: no clock/random/IO) + a runner in the API that publishes `SIM` quotes into the QuoteStore every second for a configured symbol list (default AAPL, MSFT, NVDA, TSLA, AMZN, GOOGL, META, SPY, QQQ, VOO, JPM, KO — keep the existing instrument seeds; add missing ones via a forward-only migration with realistic names/tick sizes/exchanges, no invented identifiers presented as real). Base prices per symbol in a versioned config file with an "as of" date and a note that they are illustrative. `SIM_SESSION=ALWAYS_OPEN` per D-76 (market-state override that only applies to SIM). Golden tests: fixed `(seed, symbol, T)` → exact price strings hard-coded; same inputs give identical output across runs; prices are tick multiples; bid < ask; no outlier trips the validator over a simulated 24 h.

**T4 · Source labelling end to end.** Extend contracts: `/v1/market/feed` returns `{ sources: [{ assetClass, source, label, mode: LIVE|SIMULATED|FIXTURE, session: …, status: CONNECTED|DISCONNECTED|OFF, lastMessageAt }] }` (keep the M6a shape backward compatible or version it and update the web client and its tests). Quote responses and execution rows already carry source; add tests proving a SIM stock fill stores `quote_source='SIM'` and a crypto quote shows the exchange label. Web: update the banner/footer to render per-source truth (crypto live vs stocks simulated vs demo mode) from the API only; the banner stays non-dismissible; update e2e and unit tests. Seed the crypto instruments (display-only, `tradable_in` empty, asset class CRYPTO, 8-dp qty step noted for M8) via a forward-only migration; confirm the engine rejects an order on them with `INSTRUMENT_NOT_TRADABLE` (test with control).

**T5 · Tests.**
Unit: symbol mapping, frame parsing for every message type you subscribe to (valid, malformed, missing fields, huge numbers, wrong types), backoff schedule, watchdog, SIM generator goldens/properties, guard logic (`SIM_SESSION`, `DEMO_MODE`, endpoint allow-list).
Integration (fake WebSocket server, real Postgres where relevant): connect → quotes appear in the QuoteStore with correct freshness; drop the connection → state goes DISCONNECTED and quotes age to STALE; reconnect → resubscribe and recover; bad frames are counted and do not crash; out-of-order and crossed quotes rejected by the existing validator (control: a good quote passes); kill switch → UNAVAILABLE; 10,000 quotes/second burst does not grow memory unboundedly (bounded queue; report numbers); `/v1/market/feed` reports statuses truthfully; SIM + `ALWAYS_OPEN` makes stocks tradable on a Sunday in a test with an injected clock, while with `SIM_SESSION=NYSE` the same instant is CLOSED (control).
E2E (existing Playwright): banner shows per-source labels; demo-mode text; a SIM stock order fills end to end with `quote_source` SIM (vector-style exact strings through the ticket); a crypto instrument page shows live-labelled quotes from the fake server but Buy/Sell disabled with the reason "not tradable yet".
Manual (document, not CI): a 5-minute real-exchange run on this machine; paste message-rate, reconnect behaviour after turning Wi-Fi off/on, and screenshots of the instrument pages. Mark as manual evidence, never as automated PASS.
- Done when: `pnpm verify` green; `pnpm test:integration` green twice; e2e green locally; no leftover `t_*` DBs; no test touches the internet.

**T6 · Docs.** `docs/market-data.md` (sources, decision evidence, guards, adapter behaviour, SIM model, how to run each mode), `docs/web.md`, `docs/api.md`, `.env.example` (new vars with safe defaults), append D-74..D-78 to `docs/specs/DECISIONS.md` (zero deletions).

## 5. Out of scope
Candles/OHLC/prior-close (M7b); fractional quantities and crypto trading (M8); browser WebSocket/SSE streaming (polling stays; revisit in M9); charts and UI redesign (M9); any exchange account, API key or trading API; order-book depth; funding rates; Redis; deployment; CI changes.

## 6. Common mistakes
A second validation path; printing or committing keys (there should be none); an adapter that crashes the API on a bad frame; reconnect storms (no backoff/jitter); treating "connected but silent" as healthy; mislabelling SIM as live or live as SIM; letting `ALWAYS_OPEN` apply to real/live feeds or to production without `DEMO_MODE`; random/wall-clock inside the pure generator; unbounded queues; tests that hit the internet; claiming terms permit something the text does not say.

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
1. Step 0 baseline green. 2. Exchange choice backed by recorded connectivity evidence and quoted terms (or STOP reported). 3. Live adapter: reconnect, watchdog, resubscribe, bad frames, kill switch proven against the fake server. 4. Existing validator reused; no second path. 5. Memory bounded under burst (numbers reported). 6. SIM generator deterministic (goldens), tick-multiple, validator-clean over 24 h. 7. `SIM_SESSION=ALWAYS_OPEN` works with SIM only; guards enforced in staging/prod without `DEMO_MODE`. 8. `/v1/market/feed` truthful per source; banner/footers per source in e2e. 9. SIM fill stores `quote_source='SIM'`; crypto instruments reject trading with `INSTRUMENT_NOT_TRADABLE`. 10. No test uses the internet. 11. Manual 5-minute live run documented (UNVERIFIED if not done). 12. `pnpm verify` green, integration twice, e2e green, no leftover DBs. 13. Docs and D-74..D-78 appended, zero deletions.

## 9. Final report (`docs/phase-reports/M7a-report.md`, print the FULL report in the reply)
1. Status: READY / READY WITH CAVEATS / NOT READY for M7b (≤ 5 lines). 2. Dependency changes (exact versions, why). 3. Task status T1–T6. 4. Files created/modified. 5. Commands with exit codes; failing output verbatim. 6. Acceptance table with evidence. 7. Test list with controls. 8. Terms findings (quoted clause, URL, date) and the exchange chosen. 9. Deviations, spec questions. 10. Known limitations and what M7b needs.

Do not start M7b. Stop after the report.
