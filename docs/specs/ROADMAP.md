# VANTAGE — ROADMAP.md

Version 2.0 · Solo developer or small team (1–3). Durations are focused-effort estimates for one strong full-stack engineer and include testing; they are estimates, not commitments, and the biggest unknown is data-vendor licensing lead time (weeks, runs in parallel).

## 0. Tracks

- **Engineering track** (phases E0–E9 below).
- **Business/legal track** (parallel, owner: founder): data-vendor questionnaires and contracts, counsel review (US + India), trademark clearance for "VANTAGE", privacy policy and terms, entity setup. **Gate:** no public launch without signed data licences and counsel sign-off.

## 1. Phases

### E0 — Foundation and spikes (1.5 weeks)
Deliverables: monorepo (pnpm + Turborepo), CI (lint, typecheck, unit, integration with Testcontainers, secret scan, import-boundary lint), Docker Compose (Postgres 16, Redis 7), ADR/decisions process, config schema validation, provider spike scripts (US delayed feed, crypto feed, record 1 trading day to a replay file tagged `FIXTURE`, test-only).
Acceptance: `docker compose up` + `pnpm test` green on a clean clone in < 10 min; CI < 8 min; spike scripts retrieve real quotes and candles for 5 symbols; replay tool reproduces a recorded day deterministically.

### E1 — Ledger and engine core, no UI (4 weeks) ← **first development task lives here**
Deliverables: `packages/money`, `packages/engine` (fill rules QBX-1, FIFO lots, P&L incl. FX, reserve/collar logic, posting recipes), SQL migrations for accounts, ledger (with triggers), orders, executions, lots, positions, idempotency, outbox, fee schedules; repository layer with row-lock discipline; reconciliation job implementing I1–I10; golden vectors A, B, C; property and concurrency test suites.
Acceptance (all automated): golden vectors exact; I1–I10 hold after 10,000 property sequences × 3 seeds; 50-parallel-buy test never overspends; 1,000 cancel/fill races have exactly one outcome; duplicate idempotency replay creates 1 order; mutation test proves removing the DB balance trigger makes tests fail (the tests actually test it); engine package has no IO imports (lint).

### E2 — Identity, accounts, grant (2 weeks)
Deliverables: registration, email verification, Argon2id, sessions, RBAC, audit log, account creation with the idempotent $10,000 grant, rate limits, minimal admin (users, audit viewer).
Acceptance: 100 concurrent verify/grant calls → 1 grant; session revocation effective next request; authZ matrix test (every endpoint × role) passes; password hashes only; account export and delete endpoints working.

### E3 — Market data: US delayed + crypto (3 weeks)
Deliverables: provider interface, adapters (US feed, crypto feed), instrument master sync, normalisation, validation, freshness function, Redis quote cache + pub/sub, 1m candle builder + history backfill, calendar service (XNYS, crypto), provider health, kill switches, WebSocket gateway with symbol subscriptions and `seq` replay, FX plumbing stubbed with a test vendor (no INR instruments enabled).
Acceptance: MARKET_DATA §13 criteria 1–9 for US + crypto; no FIXTURE in staging config; 24 h soak < 0.1% loss.

### E4 — Trading integration (2.5 weeks)
Deliverables: orders API with idempotency, execution worker (matcher), account-serial processing, order events and outbox relay, positions and portfolio endpoints, DAY expiry job, snapshot job (hourly), reconciliation nightly with freeze behaviour.
Acceptance: end-to-end API test (register → grant → quote → market order → fill → position → sell → realised P&L) passes against real Postgres/Redis; matcher 5,000 open orders < 50 ms; 24 h soak with worker crash injection: 0 duplicate fills, invariants clean; stale quote blocks orders; closed market blocks orders.

### E5 — Design system and terminal (4 weeks)
Deliverables: tokens, component library (DESIGN_SYSTEM §6), terminal layout, chart (candles, volume, MA/EMA, RSI), instrument search, order ticket with pre-trade preview, positions/orders/fills tabs, watchlists, markets overview (lite), onboarding flow, responsive layouts (mobile reorganised), Storybook, visual regression, a11y scan.
Acceptance: DESIGN_SYSTEM §10 all pass; first-trade E2E (Playwright) under 5 min script time; usability test ≥ 4/5; performance budgets met.

### E6 — Portfolio, journal, analytics (2.5 weeks)
Deliverables: portfolio page with equity curve from snapshots, journal auto-entries, core analytics (win rate, avg win/loss, profit factor, expectancy, max drawdown, by instrument/class) with methodology popovers and sample-size guards.
Acceptance: metrics match hand-computed fixtures for 5 reference portfolios; equity displayed = recomputation (I8); every metric has methodology text; "insufficient data" gate verified.

### E7 — Closed beta (MVP launch) (2 weeks hardening + 4 weeks beta)
Deliverables: security review (OWASP ASVS L2 checklist), load test (1,000 WS clients; 200 orders/s), backup/restore drill, monitoring and alerting live, terms/privacy/disclosures, data attributions, support tooling, 20–100 invited users.
Acceptance (MVP definition of done): PRD §5 ACs for all MVP modules pass; zero invariant violations over 14 days; 99.5% uptime over beta; restore drill within RTO; ≥ 40% of verified beta users place a first order within 24 h; no critical/high security findings open.

### E8 — Phase 2 product (India delayed, competitions, advanced) (8–10 weeks)
Deliverables: licensed delayed NSE/BSE feed + USDINR service, INR instruments enabled with FX ledger paths exercised in production, bracket/OCO and modify, MACD/Bollinger/VWAP, alerts, competitions + leaderboard + scoring + anti-abuse, news and economic calendar (licensed), AI coach (read-only tools), 2FA, workspace layouts, PWA.
Acceptance: golden vector C passes against live-shaped data; I9 clean daily on INR accounts; competition determinism test (identical orders → identical results); AI red-team 50 prompts: 0 order calls, 0 uncited numbers; licence checks for every enabled feed pass in CI.

### E9 — Phase 3 expansion and scale (ongoing)
Licensed real-time India data, real-time US upgrade, FX/indices/commodities tradable, partial fills (QBX-2) where size data licensed, options/futures specifications, extra currencies/wallets, native apps if justified, institutional/education licensing.
Acceptance: per-feature specs with their own ACs; no regression in I1–I10.

## 2. Timeline summary (one engineer, focused)

| Milestone | Cumulative |
|---|---|
| E0–E4 (backend complete, tested) | ~13.5 weeks |
| + E5–E6 (UI, analytics) | ~20 weeks |
| + E7 (hardening + beta) | ~26 weeks (≈ 6 months) to closed-beta MVP |
| + E8 (Phase 2) | ~36 weeks |
A second engineer allows E5 (UI) to run parallel to E3–E4 after the API contracts freeze, saving ~4–5 weeks.

## 3. Dependencies and critical path

Critical path: licence decisions → E3 feeds; ledger correctness (E1) → everything financial. UI (E5) depends on API contracts (frozen at end of E2/E4) and market data events. India (E8) depends on a signed licence and FX vendor.

## 4. Cross-phase quality gates

Every phase ends with: tests green in CI, docs updated (affected spec + DECISIONS.md), reconciliation clean in staging for 48 h, a short demo script run in staging, and a written "known limitations" list. No phase starts feature work on top of failing invariants.

## 5. Phase-0 business tasks (start now, in parallel)

1. Send MARKET_DATA §3 questionnaire to ≥ 2 vendors per market group; log answers.
2. Counsel consultation (US + India): simulated-trading product, data redistribution, user classification, marketing claims, SEBI/other implications.
3. Name/trademark and domain check for VANTAGE; fallback names shortlist.
4. Entity formation and bank/payment plan for later monetisation (no payments in MVP).
5. Privacy policy and terms drafts (DPDP, GDPR/CCPA readiness).
