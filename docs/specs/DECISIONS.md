# VANTAGE — DECISIONS.md

Format: ID · Decision · Why · Alternatives · Trade-off/risk · Status. Revisit rule: a decision changes only via a new entry that supersedes it (never silent edits).

| ID | Decision | Why | Alternatives | Trade-off / risk |
|---|---|---|---|---|
| D-01 | **Modular monolith**, one repo, 4 processes (api, execution-worker, market-data-worker, jobs-worker) | Fits 1–3 engineers; process isolation without distributed-systems cost | Microservices; single process | Needs discipline: boundary lint, no cross-module table access. Extraction triggers listed in ARCHITECTURE §10 |
| D-02 | **PostgreSQL as the only source of truth** for money; Redis for ephemeral quotes/fanout/queues | ACID, constraints, row locks, mature | Event store + projections; NoSQL | Hot-account lock contention (mitigated by serial per-account processing) |
| D-03 | **Double-entry, append-only ledger with DB-level triggers** (balance per currency at commit; non-negative cash via CHECK) | Defence in depth: bugs in code cannot silently corrupt books | App-only checks; single-entry balance column | More SQL to maintain (hand-written migrations), slightly slower writes |
| D-04 | **USD base account; cash held in USD only**; INR purchases convert USD→INR inside the trade via FX_CLEARING with the rate id stored | One buying-power number; simple UX; correct FX P&L | Multi-currency wallets now; INR-based accounts | Users cannot "hold INR cash". Wallets are a P3 option needing no schema change |
| D-05 | **US equities launch on licensed DELAYED data** (≈15 min), labelled; REAL_TIME is an upgrade | Cost and licensing simplicity; honest labelling | Free IEX-only real-time (not consolidated; terms unclear for redistribution); full SIP at launch | Less "live" feel; mitigated by crypto being real-time and clear UX copy |
| D-06 | **Crypto from one USD-pair exchange feed with written display terms + a commercial aggregator as fallback**; USD-quoted pairs only | Avoids stablecoin FX assumption; clear terms; 24/7 | Binance USDT pairs; aggregator only | Venue terms/regional restrictions need verification; fewer pairs |
| D-07 | **NSE/BSE only via an authorised vendor under written licence**; broker APIs and scraping forbidden for users | Redistribution rights | Broker API quick start; scraping | Cost and lead time; INR markets gated behind `tradable_in` until licensed |
| D-08 | **Execution model QBX-1: quote-based, deterministic, no order book, no partial fills in MVP**, slippage = base + size term | Honest, testable, implementable on quote data | Simulated order book; random slippage | Less realistic for large orders/illiquid names; limitations displayed |
| D-09 | **Execution on DELAYED data allowed** per asset-class flag, always labelled and stored with `entitlement`; STALE/CLOSED/UNAVAILABLE block | Without it a delayed-data launch cannot trade; "what you see is what you fill" | Block all delayed execution; fill at "estimated live" price (fabrication) | Competitions need equal-entitlement rules (PRD §5.11) |
| D-10 | **Long-only cash account** (no shorting, margin, leverage) in MVP and P2 | Removes liabilities/margin calls from the accounting model | Margin simulation | Narrower strategy range; revisit with a separate spec |
| D-11 | **FIFO lot accounting**; average cost is derived display | Deterministic, tax-style familiar, enables exact P&L and FX P&L per lot | Average cost; specific-lot | FIFO only; no user choice |
| D-12 | **Fees expensed separately** (FEES account), not capitalised into lot cost; net P&L = gross − fees | Clear reporting; simple ledger recipes | Capitalise buy fees | Slightly different from some tax treatments; not tax software |
| D-13 | **Collar-based reservation**: BUY reserves `qty×ref×(1+collar)×fxbuf+fee`; fill beyond reserve → `PRICE_MOVED` reject | Guarantees no overspend without margin; deterministic | Allow negative cash; re-reserve at fill | Occasional rejects in fast markets (collars tunable) |
| D-14 | **Crypto quantities live in lots/positions; ledger holds only USD cost** | Keeps ledger balanced in fiat currencies; avoids crypto-as-currency complexity | Crypto ledger accounts per asset | Needs migration if crypto-for-crypto or wallets are added (P3), designed as additive |
| D-15 | **Prisma for CRUD, raw SQL for ledger/locking/triggers; hand-written SQL migrations alongside** | Productivity where safe, control where it matters | Drizzle/Kysely everywhere; TypeORM | Two access styles; schema-drift CI check required |
| D-16 | **NestJS** | Module system maps to bounded contexts; DI for testability | Fastify + own structure; Go | Heavier; engine kept framework-free so it can be extracted/ported |
| D-17 | **Hosting: managed containers + managed Postgres/Redis in one region; closed beta may use one VM with Compose** | Low ops burden; PITR/backups from the provider | Kubernetes; serverless | Provider lock-in is modest; region choice per first cohort |
| D-18 | **Single write region**; region chosen after first cohort (India-heavy → Mumbai, US-heavy → US-East) | Simplicity; avoids multi-master | Multi-region active-active | Cross-ocean latency for some users; acceptable for simulation |
| D-19 | **Opaque server-side sessions (cookies) with Argon2id** | Revocation, no token theft via JS | JWT access tokens | Needs session store lookups (cheap with Redis cache) |
| D-20 | **WebSocket gateway inside the api process initially, with `account_events` outbox + per-account `seq`** | Fewer moving parts; reliable replay | Separate gateway now; SSE | Extract at ~5k connections/node |
| D-21 | **Stop trigger uses last (fallback mid); gap-through fills at gap price** | Realistic, deterministic | Trigger on bid/ask | Illiquid names have noisy last; configurable per class |
| D-22 | **Age 18+ only; store `is_adult` + country, not date of birth** | Minimise PII and regulatory exposure | Collect DOB; allow minors with guardian | Verify with counsel before launch |
| D-23 | **FX for INR: vendor bid/ask where licensed, else reference mid ± disclosed modelled spread (labelled)** | Honest label; works without a pricey FX feed | Mid only; hard-coded rate (rejected) | Modelled spread is not a tradable quote; disclosed |
| D-24 | **No raw ticks in Postgres; candles with retention tiers; quote snapshots 30 d** | Cost and performance | Store all ticks | Cannot replay tick-level history beyond recorded test files |
| D-25 | **AI coach is read-only, tool-fed, numbers rendered from tool results** | Prevents fabricated prices; no trading authority | Free-form LLM answers | More engineering; safer |
| D-26 | **Feature gating by `instruments.tradable_in` and `provider_feeds` config with licence refs** | Phased market launch without code forks | Separate branches | Config must be audited (CI test) |
| D-27 | **Nightly reconciliation freezes accounts on violation** | Prevents compounding corruption | Alert only | A bug could freeze many accounts; alert-first thresholds and an admin unfreeze flow |
| D-28 | **Mobile = responsive web (reorganised panels) in MVP; PWA in P2** | Solo capacity | Native apps | Less native polish |

## Open assumptions to confirm (owner: founder)

1. Counsel confirms simulated trading with real market data is permitted in both US and India and what disclaimers are needed (D-05, D-07, D-22).
2. Vendor answers to MARKET_DATA §3 (D-05, D-06, D-07).
3. Whether "VANTAGE" can be cleared as a name (DESIGN_SYSTEM §9).
4. Default fee/slippage numbers in TRADING_ENGINE §2 are **starting values for tuning**, not research-backed constants; they live in `fee_schedules` (versioned) and can be changed without code.
