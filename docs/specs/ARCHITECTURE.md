# VANTAGE — ARCHITECTURE.md

Version 2.0 · Modular monolith, one repo, four deployable processes.

## 1. Shape of the system

```
                       Browser (Next.js / React / Lightweight Charts)
                          │ HTTPS REST (cookies)        │ WSS (same cookie)
                          ▼                             ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ api process (NestJS)                                             │
   │  identity │ accounts │ instruments │ orders │ portfolio │ analytics│
   │  competitions │ notifications │ admin │ ai │ realtime-gateway     │
   └───────┬───────────────────────────────┬──────────────────────────┘
           │ SQL (transactions)            │ pub/sub, keys, queues
           ▼                               ▼
     PostgreSQL 16  ◄──────────────►   Redis 7
     (ledger, orders, candles, audit)  (latest quotes, fanout, sessions cache,
           ▲        ▲                    rate limits, BullMQ)
           │        │                        ▲            ▲
   ┌───────┴──┐  ┌──┴────────────┐   ┌───────┴──────┐ ┌───┴──────────┐
   │execution │  │ jobs-worker    │   │market-data   │ │ (future)      │
   │ worker   │  │ snapshots,     │   │ worker       │ │ analytics     │
   │(matcher) │  │ alerts, expiry,│   │ provider     │ │ replica       │
   │          │  │ recon, comps   │   │ adapters, FX │ │               │
   └──────────┘  └────────────────┘   └──────┬───────┘ └───────────────┘
                                             ▼
                          US vendor · Crypto vendor · India vendor · FX
```

**Four processes, one codebase** (`apps/api`, `apps/execution-worker`, `apps/market-data-worker`, `apps/jobs-worker`, `apps/web`; shared `packages/*`). Splitting by process isolates provider reconnect storms and CPU-heavy jobs from request latency without microservice overhead. No service-to-service HTTP; communication is through Postgres and Redis.

## 2. Module boundaries

Each module is a NestJS module with a public service interface. Rule: **a module reads another module's data only through that module's service**, never its tables. Enforced by an import-boundary lint rule (eslint-plugin-boundaries) in CI.

| # | Module | Owns (tables) | Depends on |
|---|---|---|---|
| 1 | identity | users, user_sessions | audit |
| 2 | accounts | accounts, ledger_accounts, ledger_transactions, ledger_entries | engine package |
| 3 | instruments | currencies, exchanges, instruments, instrument_provider_map, corporate_actions | market-data |
| 4 | market-data | fx_rates, historical_candles, quote_snapshots, provider_feeds | instruments |
| 5 | trading (orders + execution) | orders, order_events, executions, position_lots, lot_closures, positions, idempotency_keys, account_events, fee_schedules | accounts, market-data, engine |
| 6 | portfolio | portfolio_snapshots | trading, market-data |
| 7 | analytics | journal_entries (+ derived views) | trading, portfolio |
| 8 | notifications | notifications, alerts, watchlists, watchlist_items | market-data |
| 9 | competitions | competitions, competition_participants | accounts, trading |
| 10 | admin | (reads via services), audit_logs | all, audit |
| 11 | ai | none (read-only tools) | portfolio, analytics, instruments |
| 12 | realtime-gateway | none | all publishers |

Pure packages (no IO): `packages/engine` (execution, ledger postings, lots, P&L), `packages/money` (decimal helpers), `packages/market-model` (quote validation, freshness, calendars), `packages/contracts` (Zod schemas shared by web and api).

## 3. Multi-market, multi-currency flow

- **Instrument** carries `exchange` (calendar + timezone) and `quote_currency`. Market group (US, India, crypto) is derived from the exchange and gates features via `tradable_in`.
- **Order placement** loads: account (locked), instrument, eligible quote (Redis), freshness, session status, fee schedule version, and if `quote_currency ≠ USD` the latest valid FX rate (`fx_rates` row, id recorded). The engine returns reserve amount and decision.
- **FX service** (inside market-data worker): maintains `USDINR` bid/ask from the licensed vendor or reference+spread; publishes `fx:USDINR` to Redis; writes a row to `fx_rates` at least every 60 s while INR markets are open and on each material change (> 1 bp). Every INR execution references the specific `fx_rates.id` it used.
- **Portfolio valuation** converts local marks to USD with the latest FX mid; snapshots store the FX rate ids and quote snapshot ids used, so historical equity is reproducible.
- **Feature gating** keeps MVP lean: India instruments exist in the schema and FX plumbing is built early (it affects the ledger), but INR instruments are disabled by `tradable_in` until P2.

## 4. Real-time architecture

1. Market worker validates a quote → `HSET q:{id}` + `PUBLISH q:{id}`.
2. Execution worker subscribes to `q:*` for instruments that have open orders (in-memory index rebuilt from DB at start and updated from order events) and evaluates them.
3. Realtime gateway (inside the `api` process) holds WebSocket connections; clients `subscribe` to symbol channels and a private user channel. The gateway keeps `symbol → connections`, coalesces quotes to ≤ 5 Hz per symbol per connection, and never broadcasts all symbols to everyone.
4. Private events come from the **transactional outbox** (`account_events`), published after commit by a relay. Each event has a per-account `seq`; clients detect gaps and refetch/replay (`lastSeq`). Reconnect: resubscribe, send `lastSeq`, server replays from `account_events` (7 days) or instructs a full REST resync.
5. Auth: the WebSocket upgrade validates the session cookie; subscriptions are authorised (symbol entitlement, user channel = own user only). Limits: 100 symbols per connection, 5 connections per user.

Event names: `market.quote.updated`, `market.candle.updated`, `market.status.changed`, `order.created|accepted|rejected|partially_filled|filled|cancelled|expired`, `position.updated`, `portfolio.updated`, `notification.created`.

## 5. Order and fill flow (single account row lock discipline)

```
POST /orders ─► idempotency lookup ─► BEGIN
   lock accounts row ─► validate (engine) ─► insert order/events
   ─► ledger reserve ─► outbox event ─► COMMIT ─► 202 {order}
quote event ─► execution worker ─► for each open order on instrument:
   BEGIN ─► lock accounts row ─► lock order row ─► re-validate open + quote still eligible
   ─► engine.evaluateOpenOrder ─► insert execution + ledger + lots + positions
   ─► update order (version guard) ─► outbox ─► COMMIT
```

The execution worker processes orders of a given account serially (BullMQ queue keyed by `accountId` or Postgres advisory lock `pg_advisory_xact_lock(hash(account_id))`) to avoid lock thrash. Cross-account fills run in parallel.

## 6. API surface

`/api/v1/{auth,users,accounts,instruments,markets,orders,positions,portfolio,watchlists,analytics,competitions,notifications,admin}`. JSON, camelCase, decimals as strings, cursor pagination, `Idempotency-Key` on mutating order endpoints, Zod validation at the boundary, uniform error body `{error:{code,message,details,requestId}}`, OpenAPI generated from the contracts package and published to `API_SPEC.md` (to be generated in Phase 3). Rate limits (Redis token bucket): auth 5/min/IP, orders 30/min/account, reads 300/min/user, admin 60/min.

## 7. Security architecture (summary; full SECURITY.md in Phase 3)

- Argon2id; opaque session tokens (hashed in DB), httpOnly+Secure+SameSite=Lax cookies; CSRF via Origin check + token on mutations; session rotation on login and privilege change.
- RBAC (USER, SUPPORT, ADMIN, SUPERADMIN); object-level checks (`account.user_id = session.user`) in the service layer, covered by an authZ matrix test.
- Admin actions require re-authentication, are rate-limited, and write `audit_logs`.
- DB role separation; append-only tables protected by triggers and grants; no UPDATE/DELETE grants for the app role.
- Secrets in a secrets manager or sealed environment, never in git; provider keys never reach the browser; CSP, HSTS, dependency scanning, SAST in CI.
- Abuse: signup throttling, email verification, disposable-domain blocking, per-account order rate limits, multi-account signals for competitions (device + IP clustering, flagged for review, not auto-banned).
- Privacy: PII minimised (`is_adult`, country only), export + delete flows, consent log, audit of data access by staff.

## 8. Observability

Structured JSON logs (Pino) with `requestId`, `accountId`, `orderId`; Sentry for errors; metrics (Prometheus format) and dashboards for: quote age per feed, WS connections, tick→client latency, order accept latency, matcher lag, queue depth, reconciliation results, DB pool saturation. Alerts page for: any invariant violation, feed down, matcher lag > 5 s, error rate > 2%, replication/backup failure.

## 9. Environments and deployment

| Env | Purpose | Data |
|---|---|---|
| local | Docker Compose (Postgres, Redis, workers, web) | Test fixtures tagged `FIXTURE`; **never real user data**; sandbox provider keys |
| staging | Production-shaped, with real (licensed or sandbox) feeds | Synthetic users; no production data copied in |
| production | Users | Real |

Hosting (D-17): start on **managed containers + managed Postgres + managed Redis** from one provider in one region (a single small VM with Docker Compose is acceptable for the first closed beta, but not for public launch because of backup/HA). Web on a CDN-fronted host. Pick region by the first user cohort (India-heavy → Mumbai; US-heavy → US-East) and keep latency-sensitive components (api, workers, DB, Redis) co-located. CI/CD: GitHub Actions → build images → run lint, typecheck, unit, integration (Testcontainers), schema-drift check → deploy staging → smoke → manual promote → production with automatic rollback to the previous image; expand/contract migrations.

Backups: PITR (WAL) + daily snapshot, RPO ≤ 5 min, RTO ≤ 2 h; quarterly restore drill followed by the invariant suite.

## 10. Scaling triggers (when to change the architecture, not before)

| Signal | Action |
|---|---|
| API p95 > 200 ms with CPU > 70% | Horizontal scale API (stateless); add read replica for analytics |
| Market worker CPU > 60% or provider symbol cap | Shard market worker by asset class/exchange |
| Matcher lag > 2 s p95 | Shard execution workers by `hash(account_id)` |
| `ledger_entries` > ~100M rows | Hash-partition by account; archive old events |
| Realtime connections > ~5k per node | Extract the gateway into its own process behind sticky routing; Redis pub/sub → Redis Streams or NATS |
| Multi-region users | Read replicas + edge caching for reads; **single write region** until a real need exists |

## 11. Risks and mitigations (architectural)

| Risk | Mitigation |
|---|---|
| Ledger bug erodes trust | Pure engine + golden vectors + property tests + DB-level balance/non-negative constraints + nightly reconciliation freezing affected accounts |
| Data licence blocks launch | Licence-first process (MARKET_DATA §3); delayed-data launch default; feature gating of markets |
| Lock contention on hot accounts | Account-serial processing, short transactions, no external calls inside transactions |
| WebSocket fan-out cost | Symbol subscriptions, coalescing, caps, gateway extraction trigger |
| Prisma limits (locks, triggers) | Raw SQL for ledger/locking via a thin repository layer; hand-written SQL migrations |
| Solo-dev overload | Strict MVP scope; modular monolith; generated contracts; automated invariants |
| Time/DST/holiday errors | IANA zones, calendar tests per exchange |
| Clock skew | Use provider timestamps for freshness; NTP-synced hosts; skew metric and alert |

## 12. Acceptance criteria

1. Import-boundary lint passes; a deliberate cross-module table access fails CI.
2. `docker compose up` yields a working local stack in < 5 min on a fresh machine (documented, tested in CI).
3. Process isolation test: killing the market worker does not increase API p95 by > 10% and the UI shows STALE within threshold.
4. WebSocket: 1,000 clients × 20 symbols, tick→client p95 < 500 ms; no client receives events for another user's account (security test).
5. Restore drill: restore latest backup, run invariants I1–I10 with zero violations, within the RTO.
6. Zero secrets in repo (secret-scan in CI) and zero provider keys in the web bundle (bundle scan).
