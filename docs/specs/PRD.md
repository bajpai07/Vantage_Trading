# VANTAGE — Product Requirements Document (PRD)

Version 2.0 · 2 Nov 2026 · Supersedes the v1 blueprint. Status: implementation-ready for Phase 0–6.

Notation: **[MVP]** = Phase 1 (US equities, ETFs, crypto). **[P2]** = Indian equities, delayed licensed data. **[P3]** = licensed real-time India and more asset classes. Anything unmarked inside a module is MVP. Items marked **ASSUMPTION** are decisions I made because none was given; change them deliberately in DECISIONS.md, not silently.

---

## 1. Vision and positioning

VANTAGE is a virtual brokerage and markets terminal. Every user gets $10,000 of virtual USD and trades real, labelled market data through a professional terminal, with honest execution and ledger-grade accounting. No real money moves, ever.

Positioning: **the most honest trading simulator, with an institutional terminal and a built-in coach.**

Three product promises (these are testable, see §8):

1. Every price shown has a source, a timestamp and a freshness state (REAL_TIME, DELAYED, STALE, CLOSED, UNAVAILABLE).
2. Every financial number can be recomputed from the immutable ledger.
3. Results teach the user something (journal, analytics, coach), not just rank them.

## 2. Users

| Segment | Who | Need |
|---|---|---|
| Primary | Students and early-career people (18–28), India and US | Learn with real data and a serious tool, no risk |
| Secondary | Self-taught retail traders | Test strategies with realistic costs and honest metrics |
| Tertiary | Educators, clubs | Private competitions, classroom leaderboards (P2+) |

Age policy **ASSUMPTION**: users must be 18+ (or the age of digital consent in their region with guardian terms, decided with counsel before launch). MVP enforces a date-of-birth gate at registration and stores only "is_adult" plus country, not the full date of birth.

## 3. Scope by phase

| Capability | MVP (P1) | P2 | P3 |
|---|---|---|---|
| US equities, ETFs | Yes | | Extended coverage |
| Crypto (USD-quoted pairs) | Yes | | More pairs |
| Indian equities NSE/BSE | | Delayed, licensed | Real-time licensed |
| FX, indices, commodities | Index reference quotes only (display) | Indices | FX, commodities |
| Options, futures | | | Later |
| Order types | Market, limit, stop, stop-limit, cancel | Modify, bracket/OCO | Trailing, conditional |
| Short selling, margin | No (long-only, cash account) | | Evaluate |
| Competitions | | Weekly public | Private, monthly, classroom |
| News and calendar | | Licensed feed | |
| AI coach | | Portfolio and journal explanations | Habit analysis |
| Mobile | Responsive web | PWA | Native, if justified |

**Explicit non-goals (all phases):** real-money deposits or withdrawals, brokerage routing, investment advice, copy-trading of real accounts.

## 4. Account and currency model (applies to all phases)

- Base currency USD. Starting grant $10,000.00 USD, granted exactly once per user (enforced in DB, see DATABASE.md).
- Cash is held **in USD only** in MVP and P2. **ASSUMPTION:** users do not hold INR cash balances; buying an INR-quoted stock converts USD to INR at the recorded FX rate inside the same transaction. This keeps buying power one number and avoids FX-balance management. Multi-currency cash wallets are a P3 option; the ledger is designed so adding them needs no schema change.
- Positions are denominated in the instrument's quote currency (USD for US stocks and crypto pairs, INR for NSE/BSE).
- Crypto: **ASSUMPTION** MVP supports pairs quoted in USD (e.g. BTC-USD). Crypto holdings are quantity-of-asset positions valued in USD. Users cannot hold crypto as a currency or trade crypto-for-crypto in MVP. USDT-quoted venues need an explicit USDT/USD rate and are avoided in MVP.
- Every INR trade stores the FX rate id, rate value, source and time. Historical FX rates are retained permanently.
- Consolidated equity is reported in USD using the latest valid FX rate; historical snapshots store the rate used.
- Realised P&L is split into **trading P&L** (in instrument currency) and **FX P&L** (from rate movement between entry and exit), both reported in USD.

## 5. Functional requirements and acceptance criteria

Each requirement has an ID. "AC" = measurable acceptance criteria. All ACs must pass in CI or a staged environment before a module is "done".

### 5.1 Identity and accounts (FR-ID) [MVP]

- FR-ID-1 Email + password registration with email verification; Argon2id; breached-password check.
- FR-ID-2 Server-side sessions, httpOnly Secure cookies, revocable, device list.
- FR-ID-3 Roles: user, support, admin, superadmin. Admin actions audited.
- FR-ID-4 Account auto-created on first verified login with the $10,000 grant.
- FR-ID-5 Account deletion and data export (privacy law readiness).
- FR-ID-6 TOTP 2FA [P2].

AC:
- 100 parallel verification/grant requests for one user yield exactly 1 grant ledger transaction and balance 10,000.00.
- Session revoke takes effect on the next request (p99 < 1 s).
- Password stored only as Argon2id hash; no plaintext in logs (log scan test).
- Unverified users cannot place orders.

### 5.2 Instruments and search (FR-INS) [MVP]

- FR-INS-1 Instrument master for US equities, ETFs, crypto with: id, symbol, name, asset class, exchange, quote currency, tick size, lot/qty step, fractional flag, status (active, halted, delisted), provider mappings.
- FR-INS-2 Search by symbol and name, typo-tolerant, results include exchange, currency, asset class, data entitlement label (REAL_TIME/DELAYED).
- FR-INS-3 Nightly instrument sync with change log; delisted instruments become sell-only.

AC: search p95 < 150 ms on 20k instruments; exact-symbol match ranks first in 100% of a 200-symbol test list; sync job idempotent (rerun creates zero diffs).

### 5.3 Market data (FR-MD) [MVP; see MARKET_DATA.md]

- FR-MD-1 Provider adapters behind one interface; normalised Quote/Candle models.
- FR-MD-2 Every quote carries source, provider timestamp, receive timestamp, entitlement (REAL_TIME or DELAYED with delay seconds) and computed freshness.
- FR-MD-3 Validation rejects crossed/zero/negative/future-dated/outlier quotes.
- FR-MD-4 Historical candles 1m, 5m, 15m, 1h, 1d with adjusted flag.
- FR-MD-5 Provider health monitoring and automatic fallback where licensed.
- FR-MD-6 No fabricated data in staging or production. Fixtures are allowed only in tests and are tagged `source = 'FIXTURE'`; the production runtime refuses to start if a FIXTURE source is enabled.

AC: 24 h soak test on 100 symbols loses < 0.1% of expected updates; WebSocket reconnect recovers within 10 s p95 and resubscribes automatically; a injected crossed quote is rejected and counted; freshness labels are correct in a table-driven test covering all five states; forcing the provider offline shows STALE within the configured threshold and blocks new market orders.

### 5.4 Trading engine (FR-TE) [MVP; see TRADING_ENGINE.md]

- FR-TE-1 Order types: market, limit, stop, stop-limit; TIF: DAY, GTC, IOC, FOK. Cancel.
- FR-TE-2 Deterministic quote-based execution with documented slippage, spread and fee model, versioned (`model_version`).
- FR-TE-3 Pre-trade checks: market session, freshness, instrument status, qty rules, buying power, duplicate id.
- FR-TE-4 Double-entry multi-currency ledger, immutable.
- FR-TE-5 FIFO lots, realised/unrealised P&L, FX P&L.
- FR-TE-6 Idempotent order create/cancel.
- FR-TE-7 Nightly and on-demand reconciliation (invariants I1–I10).

AC:
- Property test (10,000 random order/quote sequences) holds all invariants.
- 50 concurrent buy orders that together exceed cash: sum of accepted reservations never exceeds cash; rejected ones return INSUFFICIENT_BUYING_POWER.
- Cancel vs fill race (1,000 runs): exactly one outcome per order, no order is both FILLED and CANCELLED.
- Same idempotency key replayed 100 times produces exactly 1 order.
- Order accept latency p95 < 150 ms at 200 orders/s on the reference VM.
- Every execution row references a stored quote (bid, ask, ts, source) and a ledger transaction.

### 5.5 Terminal (FR-TERM) [MVP; see DESIGN_SYSTEM.md]

- Chart (Lightweight Charts): candles, line, volume, MA/EMA, RSI at MVP; MACD, Bollinger, VWAP in P2.
- Order ticket with pre-trade preview (estimated fill, fees, FX if applicable, new buying power).
- Positions, open orders, fills, activity in a bottom tab panel.
- Watchlist, instrument details, session indicator, freshness badge on every price.
- Keyboard shortcuts for search, side, submit, cancel.

AC: first meaningful paint < 2.5 s on a 4G-throttled mid laptop; chart pan/zoom at ≥ 50 fps with 5,000 candles; quote render does not re-render unrelated panels (React profiler test: ≤ 2 components re-render per tick); ticket shows disabled reason for each blocked state (stale, closed, funds, halted).

### 5.6 Portfolio (FR-PF) [MVP]

Total equity, cash, reserved, invested, unrealised/realised P&L (trading and FX), day P&L, return, allocation by class/currency/instrument, holdings with cost basis, equity curve from snapshots.

AC: equity recomputed from the ledger equals the displayed figure to the cent (or 1e-8 for crypto) in an automated check against 1,000 random accounts; equity curve has a snapshot at least hourly while markets are open.

### 5.7 Orders view (FR-ORD) [MVP]

Tabs per state; every order has a lifecycle timeline from `order_events` and the quote used per fill.

AC: timeline for 100% of orders is gap-free (event seq 1..n contiguous).

### 5.8 Journal (FR-JR) [MVP basic, P2 full]

Auto-created entry per closed trade (round trip) with entry/exit, holding time, size, P&L, FX P&L, fees; user notes, tags.

AC: closed-trade P&L equals the sum of its execution-level realised P&L rows.

### 5.9 Analytics (FR-AN) [MVP core, P2 advanced]

Win rate, avg win/loss, profit factor, expectancy, max drawdown, equity curve, performance by instrument and asset class (MVP). Sharpe/Sortino, holding-period, exposure (P2).

Rules: each metric page shows formula, window, and sample size; metrics with fewer than 30 closed trades show "insufficient data" for ratio statistics; Sharpe/Sortino need ≥ 30 daily observations.

AC: metrics match hand-computed fixtures for 5 reference portfolios; methodology text exists for every metric.

### 5.10 Watchlists and alerts (FR-WL) [MVP lists, P2 alerts]

Multiple lists, sort, reorder; price alerts evaluated server-side from validated quotes.

AC: alert fires once within 2 s of the triggering validated quote, never duplicates (idempotent).

### 5.11 Competitions (FR-CP) [P2]

Isolated competition accounts, fixed capital, identical cost model, risk-adjusted score, minimum trades, liquidity filter, admin review before prizes.

AC: two users submitting identical order sequences get identical results; a user cannot rank without meeting minimums; leaderboard recomputation is deterministic from ledger data.

### 5.12 News and calendar (FR-NW) [P2]

Only from licensed sources, shown with attribution and deep links; no scraping.

### 5.13 AI coach (FR-AI) [P2]

Reads verified data via server tools only. Cannot place, modify or cancel orders. Every number it cites comes from a tool result and is rendered from that result, not from model text. Labelled "analysis, not advice".

AC: red-team set of 50 prompts asking it to trade or to invent prices produces 0 order calls and 0 uncited numbers.

### 5.14 Admin (FR-AD) [MVP minimal]

Users, provider health, kill switches per asset class, audit log viewer, config (fee/slippage tables with versioning).

AC: every admin mutation writes an audit row with actor, before, after, IP; support role cannot access admin-only endpoints (authZ matrix test).

### 5.15 Compliance and legal surface (FR-LG)

- Persistent "virtual money — not a brokerage" disclosure at registration and in the terminal footer.
- No investment advice; AI and news carry disclaimers.
- Data-vendor attributions and entitlement labels as required by each licence.
- Privacy: DPDP Act (India), GDPR/CCPA readiness (export, delete, consent log).
- **ASSUMPTION / required before public launch:** written confirmation from each data vendor that VANTAGE's use (display to unauthenticated or retail users, non-professional) is licensed, plus review by a lawyer in India and the US on terms, marketing wording and any "investment-related" regulation (e.g. SEBI rules on advice/research claims).

## 6. Non-functional requirements

| Area | Target |
|---|---|
| Availability (MVP) | 99.5% monthly for API, measured; planned maintenance excluded |
| API latency | Reads p95 < 200 ms; order accept p95 < 150 ms |
| Quote fanout latency | Provider tick to client < 500 ms p95 (REAL_TIME entitlements) |
| Data integrity | Zero invariant violations in nightly reconciliation; any violation pages the on-call |
| Security | OWASP ASVS L2 target; dependency scan in CI; secrets never in the repo |
| Privacy | PII minimised; export and delete flows within 30 days |
| Backups | PITR, RPO ≤ 5 min, RTO ≤ 2 h; restore drill each quarter |
| Browser support | Last 2 versions Chrome, Edge, Safari, Firefox |
| Accessibility | WCAG 2.2 AA for non-chart UI; chart data available as table |

## 7. Success metrics

Activation: % of verified users who place a first order within 24 h (target ≥ 40%). Retention: W4 retained traders (target ≥ 20%). Trust: reconciliation violations = 0; support tickets about "wrong price/balance" < 1% of MAU. Data: STALE exposure minutes per day per active symbol.

## 8. Testable promises mapping

| Promise | Test |
|---|---|
| Price source + timestamp + freshness everywhere | UI test enumerates every price component; each must render a FreshnessBadge or tooltip with source and time |
| Recomputable numbers | Nightly job rebuilds balances/positions from ledger and compares |
| Learning value | Journal entry exists for 100% of closed trades; analytics methodology present |

## 9. Open assumptions (to confirm)

1. Age 18+ only at launch.
2. USD-only cash, USD-quoted crypto pairs.
3. Long-only cash account in all MVP/P2 phases.
4. FIFO cost basis.
5. Commission default $0 for equities, configurable; crypto taker-like fee 0.10% default.
6. Delayed data is acceptable for equities in MVP if real-time redistribution is not yet licensed; REAL_TIME label is used only when the licence and feed truly support it.
7. Hosting region primary: single region with India-friendly latency (e.g. Mumbai) or US-East; decide after first user cohort (see DECISIONS D-18).
