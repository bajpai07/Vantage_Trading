# VANTAGE facts

One page of checkable facts about the project. Every number has a source (a phase report in [phase-reports/](phase-reports) or a test file) and a command to reproduce it. Where something was not verified it says **UNVERIFIED**; those items are kept on purpose.

## 1. The project in one paragraph, and what is real versus simulated

VANTAGE is a trading simulator for practice: an account starts with $10,000 of virtual money and trades stocks, ETFs and crypto at market and limit prices. **Nothing is real money and nothing is a real order.** Prices come from a deterministic, seeded generator (the SIM feed) and are labelled SIM wherever they appear; an optional fixture feed exists for tests. The execution model (QBX-1) fills against the best bid or ask with a slippage amount and a commission; there is no order book that fills consume (the depth book is informational, D-98) and no partial fills.

| Thing                                                  | Real or simulated                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Money, fills, fees, portfolio                          | Virtual, but computed exactly (decimal strings, integers of 1e-8, an append-only ledger) |
| Prices and candles                                     | Simulated (seeded, deterministic, labelled SIM)                                          |
| Depth book                                             | Synthetic ladder around the quote; informational; fills never consume it                 |
| Accounts, sessions, passwords, rate limits, database   | Real software doing real work                                                            |
| Real market data, brokers, exchanges, margin, shorting | **Not present**                                                                          |

## 2. Numbers

### 2.1 Tests, by layer (the latest fresh-clone run reported in M9b)

Fresh clone of commit `1cbc1c2`, M9b report section 5.1. M10 adds tests; its own counts are in [phase-reports/M10-report.md](phase-reports/M10-report.md).

| Layer       | Result                                                                                         | Reproduce                                     |
| ----------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Unit        | 52 files, **1,387 tests**, all passed                                                          | `pnpm test:unit` (also part of `pnpm verify`) |
| Integration | 41 files plus 3 skipped files, **541 passed, 4 skipped**, twice in a row (392.9 s and 385.0 s) | `pnpm test:integration`                       |
| End to end  | **154 passed** (default profile, desktop and phone projects) and **1 passed** (always-open)    | `pnpm --filter web test:e2e`                  |

### 2.2 Benchmarks (not gates; Windows 11 with Docker Desktop, noisy machine, real HTTP and Postgres)

| Measurement                                                                   | Result                                                                                    | Source                  | Reproduce                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------- | ------------------------ |
| 1,000 sequential fractional market orders (BTC-USD, alternating BUY and SELL) | p50 33.4 ms, p95 38.5 ms, p99 48.9 ms, 29.4 orders/s, 30.0 database round trips per order | M8 report, benchmark    | `pnpm bench:orders:http` |
| Resting limit accept, 1,000 orders                                            | quiet machine p50 16.4 ms, p95 18.2 ms; loaded machine p50 35.1 ms, p95 41.4 ms           | M8b-1 report, section 6 | `pnpm bench:orders:http` |
| Matcher tick over 1,000 open orders, no fill                                  | 29 to 38 ms (loaded: 65 ms)                                                               | M8b-1 report, section 6 | M8b-1 matcher tests      |
| Matcher tick that fills 1,000 orders (one transaction each)                   | 23.6 to 24.7 s (about 24 ms per fill); loaded 52.1 s (about 52 ms per fill)               | M8b-1 report, section 6 | M8b-1 matcher tests      |
| Evaluating 5,000 open orders                                                  | 98 to 220 ms. **The 50 ms target was missed**; a bound of 2,000 ms is asserted            | M8b-1 report, section 6 | M8b-1 matcher tests      |
| `GET /v1/portfolio`, 200 positions, 5,000 executions                          | p50 93.4 ms, p95 162.2 ms, 5 database round trips                                         | M5 report               | `pnpm bench:portfolio`   |
| `GET /v1/market/depth?levels=25`, cold cache                                  | p50 8.8 to 14.1 ms, p95 12.0 to 23.4 ms (through supertest)                               | M8b-2 report            | M8b-2 depth tests        |

The earlier M4b before-and-after comparison was not taken under equal conditions, so no latency improvement is claimed from it (M4b report).

### 2.3 Concurrency results

| Scenario                                                            | Result                                                                                                                                                     | Source               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 50 parallel BUYs of 4 at 100.02 on one account                      | exactly 24 FILLED and 26 `INSUFFICIENT_BUYING_POWER`; cash 398.08; reconcile clean                                                                         | M4b report, item 9   |
| 50 parallel identical requests with one Idempotency-Key             | 1 order, 1 execution                                                                                                                                       | M4b report, item 6   |
| 100-way duplicate of one order                                      | exactly one execution                                                                                                                                      | M4a report, item 4   |
| 100 accepts of a limit order with one key; 100 cancels of one order | one order and one reserve; one cancel effect                                                                                                               | M8b-1 report, item 7 |
| Cancel versus fill race, **1,000 iterations** per run               | every iteration had exactly one outcome; filled / cancelled split **857 to 943 / 57 to 143** across eight runs (timing dependent; reported, not asserted)  | M8b-1 report, item 7 |
| 60 orders placed while the portfolio is read, in 5 waves            | every read consistent; each wave had overlapping reads. The file ran 30 times and passed 29; the one failure was a Windows sleep (event log in the report) | M9b report, T0a      |

Reproduce: `pnpm test:integration` (the files `trading-concurrency`, `orders-concurrency`, `portfolio-consistency`).

### 2.4 Reconcile invariants (`reconcileAccount`, zero tolerance)

`reconcileAccount` implements **I1 to I7 and I10** (and two extra checks on position cost and realised P&L). **I8 (equity equals the stored snapshot) and I9 (FX clearing, INR) are specified in the engine spec but are not implemented in `reconcileAccount`**: I9 belongs to the INR phase, and I found no code for I8 (UNVERIFIED whether another check covers it).

| ID  | Meaning                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------- |
| I1  | Every ledger transaction balances to zero per currency.                                                   |
| I2  | Each ledger account's stored balance equals the sum of its entries.                                       |
| I3  | CASH, RESERVED and POSITION_COST are never negative.                                                      |
| I4  | A position's quantity equals the sum of its open lots; reserved quantity equals the open SELL orders.     |
| I5  | An order's filled quantity equals the sum of its executions; terminal orders hold no reservation.         |
| I6  | Each execution has exactly one ledger transaction and no duplicate sequence.                              |
| I7  | The RESERVED balance equals the sum of the open orders' reservations.                                     |
| I8  | Equity from the ledger, lots and recorded marks equals the stored snapshot (tolerance 1e-8).              |
| I9  | FX clearing matches open foreign-currency lots (INR is specified, not built).                             |
| I10 | One GRANT per main account equal to the initial capital; the sum of all balances of one currency is zero. |

Source: [specs/TRADING_ENGINE.md](specs/TRADING_ENGINE.md) section 11 and `apps/api/src/modules/ledger/reconcile.ts`. Reproduce: the reconcile check runs at the end of most integration tests, and `pnpm compose:smoke` runs it against the container database.

### 2.5 Golden vectors

Every vector is a hard-coded string in a test with the arithmetic in a comment next to it. **The letters A to D are used twice:** the specification (TRADING_ENGINE section 5.3) names A (AAPL), B (BTC with a fee) and C (INR); the M8 tests reuse A to D for fractional BTC-USD. Both are listed.

| Vector                  | One line                                                                                                                                             | Test file                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Spec A (AAPL)           | BUY 10, bid 189.95 / ask 190.00, 2 bps slippage: fill 190.04, cost 1,900.40, fee 0; legs CASH -1900.40, POSITION_COST +1900.40; cash 8,099.60        | `packages/engine/src/engine.test.ts`                   |
| Spec B (BTC, fee)       | BUY 0.05 at 60,030.00, fee 3.0015: CASH -3004.5015, POSITION_COST +3001.50, FEES +3.0015                                                             | `packages/engine/src/engine.test.ts`                   |
| Spec C (INR round trip) | Specified (realised 12.47446397 USD) but **not built**: INR is a later phase                                                                         | [specs/TRADING_ENGINE.md](specs/TRADING_ENGINE.md) 5.3 |
| M8 A (BTC-USD)          | BUY 0.0025, ask 90,010.00: fill 90,055.01, cost 225.137525, fee 0.22513752, CASH -225.36266252; cash 9,774.63733748                                  | `packages/engine/src/fractional.test.ts`               |
| M8 B                    | SELL 0.001, bid 89,990.00: fill 89,945.00, proceeds 89.945, fee 0.089945                                                                             | `packages/engine/src/fractional.test.ts`               |
| M8 C                    | SELL the remaining 0.0015: proceeds 134.9175, fee 0.1349175                                                                                          | `packages/engine/src/fractional.test.ts`               |
| M8 D                    | A lot of 0.3 costing 27.01 sold in three pieces of 0.1 consumes 9.00333333, 9.00333334, 9.00333333 (a tie at 8 dp rounds half to even)               | `packages/engine/src/fractional.test.ts`               |
| E                       | Resting limit BUY 0.0025 at 89,900.00 reserves 224.97475 (cash 9,775.02525); fills at 89,894.93 on 89,830.00 / 89,850.00; cash 9,775.03793768        | `packages/engine/src/limit-orders.test.ts`             |
| F                       | A marketable limit caps the slippage: the fill is the limit 89,900.00 and CASH +0                                                                    | `packages/engine/src/limit-orders.test.ts`             |
| G                       | Resting limit SELL 0.001 at 90,100.00 fills at the limit when the bid is 90,120.00; realised +0.04499                                                | `packages/engine/src/limit-orders.test.ts`             |
| H                       | Cancel and expire release exactly what was reserved (cash 10,000)                                                                                    | `packages/engine/src/limit-orders.test.ts`             |
| I                       | A stale quote is not evaluated and there is no back-fill; a fresh quote fills at its own price (89,754.86)                                           | `packages/engine/src/limit-orders.test.ts`             |
| J                       | BTC-USD depth at 89,990.00 / 90,010.00: level step 9.64; asks 90,010.00, 90,019.64, 90,029.28 ... 90,144.96; bids 89,990.00, 89,980.36 ... 89,855.04 | `packages/engine/src/depth.test.ts`                    |
| K                       | AAPL depth at 189.95 / 190.00: level step 0.04; asks 190.00, 190.04, 190.08 ... 190.56; bids 189.95, 189.91, 189.87 ... 189.39                       | `packages/engine/src/depth.test.ts`                    |
| L                       | Depth sizes reproduce: bid level 1 has noise 736 permille, notional 33,120 USD and quantity 0.36804089 (an independent BigInt implementation)        | `packages/engine/src/depth.test.ts`                    |

Reproduce: `pnpm test:unit`; the same vectors run again over HTTP in the integration tests. The diagram numbers in [ARCHITECTURE_DIAGRAMS.md](ARCHITECTURE_DIAGRAMS.md) are checked against these strings by `tools/diagrams.test.ts`.

## 3. Decision index

Every decision in [specs/DECISIONS.md](specs/DECISIONS.md), one line each. Generated by `node tools/build-decision-index.mjs`; `tools/facts.test.ts` fails if a decision is missing. The file is append-only: a decision changes only through a later entry.

<!-- decisions:start -->

| ID          | Decision (first phrase of the row)                                                                          | Status                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| D-01        | Modular monolith                                                                                            | In force (no status recorded in the row) |
| D-02        | PostgreSQL as the only source of truth                                                                      | In force (no status recorded in the row) |
| D-03        | Double-entry, append-only ledger with DB-level triggers                                                     | In force (no status recorded in the row) |
| D-04        | USD base account; cash held in USD only                                                                     | In force (no status recorded in the row) |
| D-05        | US equities launch on licensed DELAYED data                                                                 | In force (no status recorded in the row) |
| D-06        | Crypto from one USD-pair exchange feed with written display terms + a commercial aggregator as fallback     | In force (no status recorded in the row) |
| D-07        | NSE/BSE only via an authorised vendor under written licence                                                 | In force (no status recorded in the row) |
| D-08        | Execution model QBX-1: quote-based, deterministic, no order book, no partial fills in MVP                   | In force (no status recorded in the row) |
| D-09        | Execution on DELAYED data allowed                                                                           | In force (no status recorded in the row) |
| D-10        | Long-only cash account                                                                                      | In force (no status recorded in the row) |
| D-11        | FIFO lot accounting                                                                                         | In force (no status recorded in the row) |
| D-12        | Fees expensed separately                                                                                    | In force (no status recorded in the row) |
| D-13        | Collar-based reservation                                                                                    | In force (no status recorded in the row) |
| D-14        | Crypto quantities live in lots/positions; ledger holds only USD cost                                        | In force (no status recorded in the row) |
| D-15        | Prisma for CRUD, raw SQL for ledger/locking/triggers; hand-written SQL migrations alongside                 | In force (no status recorded in the row) |
| D-16        | NestJS                                                                                                      | In force (no status recorded in the row) |
| D-17        | Hosting: managed containers + managed Postgres/Redis in one region; closed beta may use one VM with Compose | In force (no status recorded in the row) |
| D-18        | Single write region                                                                                         | In force (no status recorded in the row) |
| D-19        | Opaque server-side sessions (cookies) with Argon2id                                                         | In force (no status recorded in the row) |
| D-20        | WebSocket gateway inside the api process initially, with `account_events` outbox + per-account `seq`        | In force (no status recorded in the row) |
| D-21        | Stop trigger uses last (fallback mid); gap-through fills at gap price                                       | In force (no status recorded in the row) |
| D-22        | Age 18+ only; store `is_adult` + country, not date of birth                                                 | In force (no status recorded in the row) |
| D-23        | FX for INR: vendor bid/ask where licensed, else reference mid ± disclosed modelled spread (labelled)        | In force (no status recorded in the row) |
| D-24        | No raw ticks in Postgres; candles with retention tiers; quote snapshots 30 d                                | In force (no status recorded in the row) |
| D-25        | AI coach is read-only, tool-fed, numbers rendered from tool results                                         | In force (no status recorded in the row) |
| D-26        | Feature gating by `instruments.tradable_in` and `provider_feeds` config with licence refs                   | In force (no status recorded in the row) |
| D-27        | Nightly reconciliation freezes accounts on violation                                                        | In force (no status recorded in the row) |
| D-28        | Mobile = responsive web (reorganised panels) in MVP; PWA in P2                                              | In force (no status recorded in the row) |
| D-29        | One-process modular monolith first                                                                          | APPROVED by founder (M0)                 |
| D-30        | Synchronous market-order execution                                                                          | APPROVED by founder (M0)                 |
| D-31        | Multi-currency schema, but USD-only balances and trading in the first MVP                                   | APPROVED by founder (M0)                 |
| D-32        | ETFs use the same pipeline as stocks                                                                        | APPROVED by founder (M0)                 |
| D-33        | Whole shares in the MVP                                                                                     | APPROVED by founder (M0)                 |
| D-34        | Stack unchanged                                                                                             | APPROVED by founder (M0)                 |
| D-35        | Plain-SQL forward-only migrations via node-pg-migrate                                                       | APPROVED by founder (M0)                 |
| D-36        | Two env files; apps never get migration credentials                                                         | APPROVED by founder (M0)                 |
| D-37        | Layout deferral                                                                                             | APPROVED by founder (M0)                 |
| D-15 (note) | Superseded by D-35                                                                                          | Superseded by D-35                       |
| D-38        | `accounts.user_id` foreign key is added in M2                                                               | APPROVED by founder (M1)                 |
| D-39        | MVP recipes post fills directly, with no RESERVED movement                                                  | APPROVED by founder (M1)                 |
| D-40        | Ledger layering                                                                                             | APPROVED by founder (M1)                 |
| D-41        | All new IDs are UUIDv7                                                                                      | APPROVED by founder (M2)                 |
| D-42        | Email verification is deferred to the closed-beta hardening phase (M8)                                      | APPROVED by founder (M2)                 |
| D-43        | Prisma is not introduced in M2                                                                              | APPROVED by founder (M2)                 |
| D-44        | Ledger hardening from the M1 review                                                                         | APPROVED by founder (M2)                 |
| D-45        | Watchlists and instrument reads use plain `pg` repositories                                                 | APPROVED by founder (M3a)                |
| D-46        | Quote store is an in-memory `QuoteStore` behind an interface                                                | APPROVED by founder (M3a)                |
| D-47        | The calendar source of truth is `exchanges.calendar` (JSONB)                                                | APPROVED by founder (M3a)                |
| D-48        | A `FixtureProvider` exists for local/test only                                                              | APPROVED by founder (M3a)                |
| D-49        | M4 supports synchronous `MARKET` orders only                                                                | APPROVED by founder (M4a)                |
| D-50        | Business rejects are persisted                                                                              | APPROVED by founder (M4a)                |
| D-51        | Price-moved protection                                                                                      | APPROVED by founder (M4a)                |
| D-52        | Exact arithmetic                                                                                            | APPROVED by founder (M4a)                |
| D-53        | I4 and I5 are enforced by deferred database constraint triggers                                             | APPROVED by founder (M4a)                |
| D-54        | Fee and slippage parameters come from a versioned, immutable `fee_schedules` table                          | APPROVED by founder (M4a)                |
| D-55        | The M4a lock functions are accepted                                                                         | APPROVED by founder (M4b)                |
| D-56        | `reconcileAccount` runs the trading checks by default                                                       | APPROVED by founder (M4b)                |
| D-57        | A SELL whose commission is larger than its proceeds is a business reject `FEE_EXCEEDS_PROCEEDS`             | APPROVED by founder (M4b)                |
| D-58        | Idempotency                                                                                                 | APPROVED by founder (M4b)                |
| D-59        | The server decides                                                                                          | APPROVED by founder (M4b)                |
| D-60        | Mark price for valuation is the bid for long positions                                                      | APPROVED by founder (M5)                 |
| D-61        | Definitions                                                                                                 | APPROVED by founder (M5)                 |
| D-62        | Equity snapshots                                                                                            | APPROVED by founder (M5)                 |
| D-63        | A portfolio response is read from the database in one consistent snapshot                                   | APPROVED by founder (M5)                 |
| D-64        | Web app: Next.js (App Router) 16 + React 19 + TypeScript strict, styled with the DESIGN_SYSTEM tokens       | APPROVED by founder (M6a)                |
| D-65        | The browser talks to the API same-origin through a Next.js proxy                                            | APPROVED by founder (M6a)                |
| D-66        | Route protection is server-side                                                                             | APPROVED by founder (M6a)                |
| D-67        | Data fetching                                                                                               | APPROVED by founder (M6a)                |
| D-68        | Security headers                                                                                            | APPROVED by founder (M6a)                |
| D-69        | Trusted proxy for client addresses                                                                          | APPROVED by founder (M6b)                |
| D-70        | `POST /v1/orders/preview`                                                                                   | APPROVED by founder (M6b)                |
| D-71        | `referencePrice` is never typed                                                                             | APPROVED by founder (M6b)                |
| D-72        | Idempotency key lifecycle in the UI                                                                         | APPROVED by founder (M6b)                |
| D-73        | Quote refresh on the instrument page                                                                        | APPROVED by founder (M6b)                |
| D-74        | Simulated source for crypto and stocks; live adapter deferred                                               | APPROVED by founder (M7a)                |
| D-75        | Source labels                                                                                               | APPROVED by founder (M7a)                |
| D-76        | **`SIM_SESSION=NYSE                                                                                         | APPROVED by founder (M7a)                |
| D-77        | Demo mode guard                                                                                             | APPROVED by founder (M7a)                |
| D-78        | Simulated price model                                                                                       | APPROVED by founder (M7a)                |
| D-79        | Candle source behind an interface                                                                           | APPROVED by founder (M7b)                |
| D-80        | Candle model                                                                                                | APPROVED by founder (M7b)                |
| D-81        | Sessions                                                                                                    | APPROVED by founder (M7b)                |
| D-82        | Prior close and day change                                                                                  | APPROVED by founder (M7b)                |
| D-83        | Equity-curve catch-up for SIM                                                                               | APPROVED by founder (M7b)                |
| D-84        | Next.js 16.4.3 → 16.4.5                                                                                     | APPROVED by founder (N1)                 |
| D-85        | Exact cost basis by construction                                                                            | APPROVED by founder (M8)                 |
| D-86        | Fractional quantities                                                                                       | APPROVED by founder (M8)                 |
| D-87        | Amends TRADING_ENGINE section 1 and D5 (whole shares in the MVP)                                            | APPROVED by founder (M8)                 |
| D-88        | Crypto parameters (illustrative, tuning values, not research):                                              | APPROVED by founder (M8)                 |
| D-89        | Tradability                                                                                                 | APPROVED by founder (M8)                 |
| D-90        | The preview carries a server-computed `maxQty`                                                              | APPROVED by founder (M8)                 |
| D-91        | Order lifecycle revisits D-49                                                                               | APPROVED by founder (M8b-1)              |
| D-92        | Limit BUY reserve                                                                                           | APPROVED by founder (M8b-1)              |
| D-93        | Supported scope (an amendment note on TRADING_ENGINE section 7)                                             | APPROVED by founder (M8b-1)              |
| D-94        | Expiry                                                                                                      | APPROVED by founder (M8b-1)              |
| D-95        | Matcher                                                                                                     | APPROVED by founder (M8b-1)              |
| D-96        | Sells and `qty_reserved`                                                                                    | APPROVED by founder (M8b-1)              |
| D-97        | Marketable limit at accept                                                                                  | APPROVED by founder (M8b-1)              |
| D-98        | Depth is informational; fills are unchanged                                                                 | APPROVED by founder (M8b-2)              |
| D-99        | Depth is a pure deterministic function                                                                      | APPROVED by founder (M8b-2)              |
| D-100       | Freshness rule                                                                                              | APPROVED by founder (M8b-2)              |
| D-101       | Cost and caching                                                                                            | APPROVED by founder (M8b-2)              |
| D-102       | The caller's own orders on the book                                                                         | APPROVED by founder (M8b-2)              |
| D-103       | Charts use `lightweight-charts` (TradingView, Apache-2.0), pinned exactly at 5.2.1                          | APPROVED by founder (M9a)                |
| D-104       | The watchlist is a per-viewer convenience stored in this browser                                            | APPROVED by founder (M9a)                |
| D-105       | Motion and feedback                                                                                         | APPROVED by founder (M9a)                |
| D-106       | Keyboard shortcuts                                                                                          | APPROVED by founder (M9a)                |
| D-107       | Breakpoints and structure                                                                                   | APPROVED by founder (M9b)                |
| D-108       | The ticket is a bottom sheet on a phone and keeps the same component and logic                              | APPROVED by founder (M9b)                |
| D-109       | Touch and mobile-browser rules                                                                              | APPROVED by founder (M9b)                |
| D-110       | Containers                                                                                                  | APPROVED by founder (M10)                |
| D-111       | Compose smoke test                                                                                          | APPROVED by founder (M10)                |
| D-112       | `/about` page                                                                                               | APPROVED by founder (M10)                |
| D-113       | Temporary demo accounts (guarded)                                                                           | APPROVED by founder (M10)                |
| D-114       | `demo:seed`                                                                                                 | APPROVED by founder (M10)                |
| D-115       | `FACTS.md` rules                                                                                            | APPROVED by founder (M10)                |
| D-116       | Licence acceptance                                                                                          | APPROVED by founder (M10)                |

<!-- decisions:end -->

## 4. Bugs the tests found

These are real defects or traps that a test, not a person, exposed. Each is in a phase report with the full output.

| Where | What was found                                                                                                                                                                                                                                        | How it was found                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| M8    | Migration 0027 failed with `cannot ALTER TABLE "position_lots" because it has pending trigger events`: the backfill queued the deferred I4 triggers. Invisible on an empty database. Fixed with `SET CONSTRAINTS ALL IMMEDIATE`.                      | A migration test that backfills existing rows                |
| M7a   | A crypto order returned HTTP 500 because no CRYPTO fee schedule existed (migration 0025 added one).                                                                                                                                                   | A new order test for crypto                                  |
| M6b   | zod 4 probes `new Function()` when schemas are created, which the strict CSP (no unsafe-eval) reported in the browser. Fixed with `z.config({ jitless: true })`.                                                                                      | The security end-to-end test that fails on any CSP violation |
| M9a   | The chart library injects an inline style element, blocked by the CSP and with no nonce option. The in-chart logo is off (a founder decision) and attribution is shown elsewhere. Two of the four reports were the app's own style attributes, fixed. | The CSP violation report in the end-to-end run               |
| M6b   | Two colour-contrast failures (the search result exchange label; a link inside the retry alert, where a global rule beat the utility class).                                                                                                           | axe in the end-to-end tests                                  |
| M7b   | Red and green percentage text failed contrast on the highlighted search row; the neutral colour is used and the arrow and sign carry the direction.                                                                                                   | axe                                                          |
| M8    | `label-content-name-mismatch` on the ticket's Max button: the accessible name did not contain the visible text "Max".                                                                                                                                 | axe                                                          |
| M9a   | The new footer link failed `link-in-text-block`, and the watchlist symbol failed `color-contrast` (the global `a` colour beat the utility class).                                                                                                     | axe                                                          |
| M4a   | A replayed order returned database-formatted decimals (`'194.9600000000'`) where the first response had plain ones.                                                                                                                                   | The replay test comparing the two responses                  |
| M8b-2 | A depth-versus-no-depth snapshot compared unequal because legs of one ledger transaction come out in the order of random account ids. A test bug, not a product bug; the snapshot now orders them.                                                    | The test that compares two databases                         |

Also recorded: M8b-2's widened property test found no bug against the independent model on 11 seeds (a result worth stating, not a defect), and the M9b portfolio-consistency test was rewritten to force the interleaving it claims (a barrier and counted overlapping reads) instead of relying on timing luck.

## 5. Limitations and non-goals

As stated in the phase reports and the specifications.

**Not built, on purpose:** real money, brokers and exchanges; margin, leverage and short selling; stop and stop-limit orders; partial fills against a book; live market data; INR and Indian markets (specified, a later phase); corporate actions; real email verification; multi-factor sign-in; legal pages.

**Behaviour to know about:**

- Depth is informational. Fills use QBX-1, never the book (D-98).
- Cancel is synchronous (no CANCEL_REQUESTED state in the MVP, D-93).
- The API keeps its rate limiters and quote caches in process memory, so **run one API instance**. The matcher takes an advisory lock, so an accidental second instance only skips ticks.
- Demo accounts are never deleted: the ledger is append-only, so they accumulate.
- Clock jumps from machine sleep affect only the test runs (the reports show the event-log timestamps).
- Evaluating 5,000 open orders took 98 to 220 ms, missing the 50 ms target (M8b-1). One matcher fill is one transaction (about 24 to 52 ms), so 1,000 crossing orders on one instrument take 24 to 52 s to clear.
- The `web` container exits with code 143 on `docker stop` (the web app holds no state); the API logs `shutting down` and exits 0 (M10).
- The three licences outside the original "permissive" list (OFL-1.1 fonts, CC-BY-4.0 data in caniuse-lite, the LGPL image binary that is not shipped) were accepted by the founder (D-116).

**UNVERIFIED (kept on purpose):**

- On real devices: the soft keyboard, iOS Safari (dynamic toolbar, safe-area insets, zoom on focus), real touch hardware, chart panning and pinch-zoom with a finger, a notched phone in landscape, reduced motion on a real device, rotation while an order is being sent (M9b report, section 7).
- The mechanism behind the lost keystrokes seen once in the keyboard end-to-end test under heavy load (M8b-1 F5): the fix is measured, the cause is not proven. It was also not reproduced in M9a.
- File mode 0600 of the env files on Windows (cannot be checked there).
- The Postgres property test for limit orders is narrower than first asked: BTC-USD only, no stale-quote moves, and it does not compare `cost_remaining` per lot or realised P&L (M8b-1 caveat 1).
- Results of the CI workflow in a hosted runner have not been reviewed for this document.
- Behaviour on any real data provider: none is connected.

## 6. Security posture

**Exists:**

- Passwords hashed with argon2id (19 MiB memory cost, time cost 2); sign-in (per address and per address-and-account pair) and registration are rate limited.
- An httpOnly, SameSite=Lax session cookie (`Secure` outside local and test); server-side sessions with idle and absolute expiry; nothing in localStorage or sessionStorage.
- A CSRF origin check on state-changing requests; one allowed web origin for CORS.
- A strict content security policy with a per-request nonce and no `unsafe-inline` or `unsafe-eval`; `nosniff`, `no-referrer`, `frame-ancestors 'none'` and `no-store` on pages (tested end to end).
- Trusted-proxy handling: `X-Forwarded-For` is believed only from addresses in `TRUSTED_PROXY_CIDRS` (D-69); staging and production must set it.
- Least-privilege database roles: the application role has no UPDATE on `accounts` or `ledger_accounts` and gets two narrow `SECURITY DEFINER` lock functions instead (D-55); migrations run as a separate role the applications never hold.
- Append-only ledger enforced by triggers, plus constraints for non-negative cash and balanced transactions (D-03).
- Secret handling: `.env*` files are untracked and kept out of images; the compose secrets are generated with random bytes and never printed; no secret appears in logs. A full-history scan with gitleaks 8.28.0 in M10 found no real secret (details in the M10 report).
- Containers run as a non-root user; Postgres and the API are not published to the host in the compose stack.

**Does not exist:** email verification, multi-factor sign-in, a penetration test, and legal pages (terms and privacy text beyond the registration checkboxes).

## 7. What I would do next

- Stop and stop-limit orders, then partial fills against a simulated book.
- WebSocket price streaming in place of polling.
- A multi-instance matcher with a lease, and shared rate limiting (Redis or the database).
- The INR and India phase (specified: FX clearing, the INR vectors).
- Load testing beyond the single-machine benchmarks above.
- Observability: metrics, tracing and alerting on reconcile violations.
- Real-device testing of the phone layout.
