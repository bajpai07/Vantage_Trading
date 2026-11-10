# VANTAGE — DATABASE.md

Version 2.0 · PostgreSQL 16+ · Source of truth for all money, orders and positions.

## 1. Conventions

- Primary keys: UUID (UUIDv7 generated in the application for index locality; `gen_random_uuid()` as fallback default).
- Money and quantity: `NUMERIC(28,10)` for quantities and prices (crypto needs 8+ decimals, FX rates need 8–10), `NUMERIC(24,8)` for USD report values. The ledger itself uses `NUMERIC(28,10)` in every currency. **Rounding happens only at defined points** (see TRADING_ENGINE.md §9) and the rounding rule is stored with the fill.
- Time: `timestamptz`, always UTC. Exchange-local time is derived from `exchanges.timezone`.
- Currency codes: ISO 4217 text (`USD`, `INR`). Crypto assets are **not** currencies in the ledger (see §4 note).
- Append-only tables: `ledger_transactions`, `ledger_entries`, `order_events`, `executions`, `audit_logs`, `account_events`, `fx_rates`. Updates and deletes are blocked by trigger and by missing grants for the app role.
- Application DB roles: `vantage_app` (read/write on mutable tables, INSERT/SELECT only on append-only tables), `vantage_migrator` (DDL), `vantage_readonly` (analytics replica). No superuser at runtime.

## 2. Extensions and types

```sql
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE asset_class       AS ENUM ('EQUITY','ETF','CRYPTO','INDEX','FX','COMMODITY');
CREATE TYPE instrument_status AS ENUM ('ACTIVE','HALTED','SELL_ONLY','DELISTED');
CREATE TYPE user_role         AS ENUM ('USER','SUPPORT','ADMIN','SUPERADMIN');
CREATE TYPE user_status       AS ENUM ('PENDING_VERIFICATION','ACTIVE','SUSPENDED','DELETED');
CREATE TYPE account_kind      AS ENUM ('MAIN','COMPETITION');
CREATE TYPE order_side        AS ENUM ('BUY','SELL');
CREATE TYPE order_type        AS ENUM ('MARKET','LIMIT','STOP','STOP_LIMIT');
CREATE TYPE time_in_force     AS ENUM ('DAY','GTC','IOC','FOK');
CREATE TYPE order_status      AS ENUM ('NEW','ACCEPTED','PARTIALLY_FILLED','FILLED',
                                       'CANCEL_REQUESTED','CANCELLED','REJECTED','EXPIRED');
CREATE TYPE ledger_acct_type  AS ENUM ('CAPITAL','CASH','RESERVED','POSITION_COST',
                                       'FEES','REALIZED_PNL','FX_CLEARING','ADJUSTMENT');
CREATE TYPE ledger_tx_kind    AS ENUM ('GRANT','ORDER_RESERVE','ORDER_RELEASE','FILL','FEE',
                                       'CORPORATE_ACTION','ADJUSTMENT','COMPETITION_GRANT');
CREATE TYPE quote_entitlement AS ENUM ('REAL_TIME','DELAYED');
CREATE TYPE freshness_state   AS ENUM ('REAL_TIME','DELAYED','STALE','CLOSED','UNAVAILABLE');
```

## 3. Identity and security

```sql
CREATE TABLE users (
  id               uuid PRIMARY KEY,
  email            citext NOT NULL UNIQUE,
  email_verified_at timestamptz,
  password_hash    text NOT NULL,                 -- Argon2id
  role             user_role NOT NULL DEFAULT 'USER',
  status           user_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 40),
  country_code     char(2),
  is_adult         boolean NOT NULL,              -- no DOB stored (ASSUMPTION, PRD §2)
  totp_secret_enc  bytea,                         -- P2
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE user_sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,             -- SHA-256 of the opaque token
  ip           inet, user_agent text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_exp_idx  ON user_sessions(expires_at);

CREATE TABLE audit_logs (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES users(id),
  actor_role user_role,
  action     text NOT NULL,
  target_type text, target_id text,
  before     jsonb, after jsonb,
  ip         inet, request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx  ON audit_logs(actor_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs(target_type, target_id);
```

## 4. Reference and instrument data

```sql
CREATE TABLE currencies (
  code char(3) PRIMARY KEY, name text NOT NULL, minor_units smallint NOT NULL
);
INSERT INTO currencies VALUES ('USD','US Dollar',2),('INR','Indian Rupee',2);

CREATE TABLE exchanges (
  id         uuid PRIMARY KEY,
  code       text NOT NULL UNIQUE,                -- XNAS, XNYS, ARCX, XNSE, XBOM, CRYPTO
  name       text NOT NULL,
  country    char(2), timezone text NOT NULL,
  calendar   jsonb NOT NULL                       -- sessions + holidays, see MARKET_DATA.md §8
);

CREATE TABLE instruments (
  id            uuid PRIMARY KEY,
  symbol        text NOT NULL,                    -- canonical VANTAGE symbol, e.g. AAPL, RELIANCE.XNSE, BTC-USD
  name          text NOT NULL,
  asset_class   asset_class NOT NULL,
  exchange_id   uuid NOT NULL REFERENCES exchanges(id),
  quote_currency char(3) NOT NULL REFERENCES currencies(code),
  base_asset    text,                             -- crypto only (BTC); NULL otherwise
  tick_size     numeric(28,10) NOT NULL CHECK (tick_size > 0),
  qty_step      numeric(28,10) NOT NULL CHECK (qty_step > 0),
  min_qty       numeric(28,10) NOT NULL CHECK (min_qty > 0),
  fractional_ok boolean NOT NULL DEFAULT false,
  status        instrument_status NOT NULL DEFAULT 'ACTIVE',
  tradable_in   text[] NOT NULL DEFAULT '{}',     -- feature gates, e.g. {'MVP'}
  attrs         jsonb NOT NULL DEFAULT '{}',      -- class-specific fields (sector, isin, lot size...)
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange_id, symbol),
  CHECK (asset_class <> 'CRYPTO' OR base_asset IS NOT NULL)
);
CREATE INDEX instruments_symbol_trgm ON instruments USING gin (symbol gin_trgm_ops);
CREATE INDEX instruments_name_trgm   ON instruments USING gin (name gin_trgm_ops);

CREATE TABLE instrument_provider_map (
  instrument_id uuid NOT NULL REFERENCES instruments(id),
  provider      text NOT NULL,
  provider_symbol text NOT NULL,
  PRIMARY KEY (instrument_id, provider),
  UNIQUE (provider, provider_symbol)
);
```

**Crypto note.** A crypto position (e.g. 0.5 BTC) is a *quantity* in `positions` and `position_lots` (via `instruments.base_asset`). The ledger carries only the **USD cost** of that position (`POSITION_COST` account in USD). Crypto assets are not ledger currencies in MVP, which keeps ledger balance rules simple (entries balance per fiat currency) and still preserves exact quantities in lots. If crypto-for-crypto trading or crypto wallets arrive (P3), add the asset to `currencies` and use it as a ledger currency; no existing row changes.

## 5. Market data

```sql
CREATE TABLE fx_rates (
  id          bigserial PRIMARY KEY,
  base        char(3) NOT NULL REFERENCES currencies(code),   -- e.g. USD
  quote       char(3) NOT NULL REFERENCES currencies(code),   -- e.g. INR  (1 base = rate quote)
  bid         numeric(28,10) NOT NULL, ask numeric(28,10) NOT NULL, mid numeric(28,10) NOT NULL,
  source      text NOT NULL,
  as_of       timestamptz NOT NULL,                           -- provider timestamp
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bid > 0 AND ask >= bid)
);
CREATE INDEX fx_rates_pair_time_idx ON fx_rates(base, quote, as_of DESC);

-- Candles. Partitioned monthly. 1m kept 90 days (hot), rolled up to coarser frames; 1d kept forever.
CREATE TABLE historical_candles (
  instrument_id uuid NOT NULL,
  timeframe     text NOT NULL CHECK (timeframe IN ('1m','5m','15m','1h','1d')),
  ts_open       timestamptz NOT NULL,
  open numeric(28,10) NOT NULL, high numeric(28,10) NOT NULL,
  low  numeric(28,10) NOT NULL, close numeric(28,10) NOT NULL,
  volume numeric(28,10) NOT NULL DEFAULT 0,
  source        text NOT NULL,
  adjusted      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (instrument_id, timeframe, ts_open),
  CHECK (high >= low AND high >= open AND high >= close AND low <= open AND low <= close)
) PARTITION BY RANGE (ts_open);
-- A scheduled job creates next month's partition 7 days ahead and drops expired 1m/5m partitions' rows by timeframe via DELETE+VACUUM or sub-partitioning (see §10).

CREATE TABLE corporate_actions (
  id uuid PRIMARY KEY,
  instrument_id uuid NOT NULL REFERENCES instruments(id),
  kind text NOT NULL CHECK (kind IN ('SPLIT','REVERSE_SPLIT','CASH_DIVIDEND','SYMBOL_CHANGE','DELISTING')),
  ex_date date NOT NULL, pay_date date,
  ratio_num numeric(28,10), ratio_den numeric(28,10),
  cash_per_share numeric(28,10), currency char(3),
  source text NOT NULL, applied_at timestamptz,
  UNIQUE (instrument_id, kind, ex_date)
);
```

Latest quotes live in Redis (`q:{instrument_id}` hash). A periodic job (every 60 s) writes a `quote_snapshots` row per actively-held instrument for equity-curve marking and post-incident audit:

```sql
CREATE TABLE quote_snapshots (
  id bigserial PRIMARY KEY, instrument_id uuid NOT NULL REFERENCES instruments(id),
  bid numeric(28,10), ask numeric(28,10), last numeric(28,10),
  entitlement quote_entitlement NOT NULL, delay_seconds int NOT NULL DEFAULT 0,
  source text NOT NULL, provider_ts timestamptz NOT NULL, received_at timestamptz NOT NULL
);
CREATE INDEX quote_snapshots_inst_time ON quote_snapshots(instrument_id, provider_ts DESC);
```
Retention: 30 days, then deleted (daily candles remain).

## 6. Accounts and the ledger

```sql
CREATE TABLE accounts (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id),
  kind             account_kind NOT NULL,
  competition_id   uuid,
  base_currency    char(3) NOT NULL DEFAULT 'USD' CHECK (base_currency = 'USD'),
  initial_capital  numeric(28,10) NOT NULL CHECK (initial_capital > 0),
  status           text NOT NULL DEFAULT 'ACTIVE',
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- exactly one MAIN account per user => the $10,000 grant can happen once
CREATE UNIQUE INDEX accounts_one_main ON accounts(user_id) WHERE kind = 'MAIN';

CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id),
  type        ledger_acct_type NOT NULL,
  currency    char(3) NOT NULL REFERENCES currencies(code),
  balance     numeric(28,10) NOT NULL DEFAULT 0,      -- maintained by trigger from entries
  UNIQUE (account_id, type, currency),
  -- no overdraft: free cash and reservations can never go negative
  CHECK (type NOT IN ('CASH','RESERVED','POSITION_COST') OR balance >= 0)
);

CREATE TABLE ledger_transactions (
  id              uuid PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id),
  kind            ledger_tx_kind NOT NULL,
  idempotency_key text NOT NULL,
  order_id        uuid, execution_id uuid,
  description     text,
  effective_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE ledger_entries (
  id                bigserial PRIMARY KEY,
  transaction_id    uuid NOT NULL REFERENCES ledger_transactions(id),
  ledger_account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  currency          char(3) NOT NULL REFERENCES currencies(code),
  amount            numeric(28,10) NOT NULL CHECK (amount <> 0),  -- signed; +increase, -decrease of the account balance
  fx_rate_id        bigint REFERENCES fx_rates(id),               -- present on cross-currency legs
  amount_usd        numeric(28,10) NOT NULL,                      -- USD value at the transaction's rate (reporting only)
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_tx_idx   ON ledger_entries(transaction_id);
CREATE INDEX ledger_entries_acct_idx ON ledger_entries(ledger_account_id, id);
```

**Sign convention.** Every ledger account holds a non-negative-by-nature balance except `CAPITAL`, `REALIZED_PNL`, `FEES` and `FX_CLEARING`, which are contra/equity-style accounts and may move either way. An entry's signed `amount` is added to the account balance. A transaction is **balanced** when, for each currency, entries across all its accounts sum to zero **under the sign convention in TRADING_ENGINE.md §5 (assets are `+`, offsets are `-`)**. This is the balance rule enforced below.

```sql
-- Immutability
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER ledger_tx_immutable    BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entry_immutable BEFORE UPDATE OR DELETE ON ledger_entries      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- same trigger on order_events, executions, lot_closures, audit_logs, account_events, fx_rates

-- Keep account balance consistent with entries, in the same transaction
CREATE FUNCTION apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ledger_accounts SET balance = balance + NEW.amount WHERE id = NEW.ledger_account_id;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_entry_apply AFTER INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION apply_entry();

-- Every transaction must balance per currency at COMMIT
CREATE FUNCTION assert_tx_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad record;
BEGIN
  SELECT currency, SUM(amount) AS s INTO bad
  FROM ledger_entries WHERE transaction_id = NEW.transaction_id
  GROUP BY currency HAVING SUM(amount) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % unbalanced in % by %', NEW.transaction_id, bad.currency, bad.s;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_tx_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_tx_balanced();
```

Because the `CHECK (balance >= 0)` lives on `ledger_accounts`, a concurrent overspend fails at the database even if application logic has a bug. The engine additionally takes `SELECT ... FOR UPDATE` on the CASH ledger account for deterministic ordering and clean error messages.

## 7. Orders, executions, positions

```sql
CREATE TABLE orders (
  id               uuid PRIMARY KEY,
  account_id       uuid NOT NULL REFERENCES accounts(id),
  instrument_id    uuid NOT NULL REFERENCES instruments(id),
  client_order_id  text NOT NULL,
  side             order_side NOT NULL,
  type             order_type NOT NULL,
  tif              time_in_force NOT NULL DEFAULT 'DAY',
  qty              numeric(28,10) NOT NULL CHECK (qty > 0),
  filled_qty       numeric(28,10) NOT NULL DEFAULT 0 CHECK (filled_qty >= 0 AND filled_qty <= qty),
  limit_price      numeric(28,10) CHECK (limit_price > 0),
  stop_price       numeric(28,10) CHECK (stop_price > 0),
  triggered_at     timestamptz,
  status           order_status NOT NULL,
  reject_code      text,
  reserved_usd     numeric(28,10) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  parent_order_id  uuid REFERENCES orders(id),
  oco_group_id     uuid,                                -- P2 brackets
  expires_at       timestamptz,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, client_order_id),
  CHECK (type <> 'LIMIT'      OR limit_price IS NOT NULL),
  CHECK (type <> 'STOP'       OR stop_price  IS NOT NULL),
  CHECK (type <> 'STOP_LIMIT' OR (stop_price IS NOT NULL AND limit_price IS NOT NULL))
);
CREATE INDEX orders_open_by_instrument ON orders(instrument_id)
  WHERE status IN ('ACCEPTED','PARTIALLY_FILLED','CANCEL_REQUESTED');
CREATE INDEX orders_account_time ON orders(account_id, created_at DESC);

CREATE TABLE order_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  seq int NOT NULL,
  type text NOT NULL,                         -- CREATED, ACCEPTED, REJECTED, TRIGGERED, FILLED, CANCEL_REQUESTED, CANCELLED, EXPIRED ...
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seq)
);

CREATE TABLE executions (
  id              uuid PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES orders(id),
  account_id      uuid NOT NULL REFERENCES accounts(id),
  instrument_id   uuid NOT NULL REFERENCES instruments(id),
  seq             int NOT NULL,
  side            order_side NOT NULL,
  qty             numeric(28,10) NOT NULL CHECK (qty > 0),
  price           numeric(28,10) NOT NULL CHECK (price > 0),   -- in instrument quote currency
  currency        char(3) NOT NULL REFERENCES currencies(code),
  fee_local       numeric(28,10) NOT NULL DEFAULT 0,
  fx_rate_id      bigint REFERENCES fx_rates(id),              -- NULL iff currency = 'USD'
  gross_usd       numeric(28,10) NOT NULL,
  fee_usd         numeric(28,10) NOT NULL DEFAULT 0,
  slippage_bps    numeric(12,4) NOT NULL,
  quote_bid       numeric(28,10), quote_ask numeric(28,10), quote_last numeric(28,10),
  quote_ts        timestamptz NOT NULL,
  quote_source    text NOT NULL,
  quote_entitlement quote_entitlement NOT NULL,
  model_version   text NOT NULL,
  ledger_tx_id    uuid NOT NULL REFERENCES ledger_transactions(id),
  executed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seq),
  UNIQUE (ledger_tx_id),
  CHECK ((currency = 'USD') = (fx_rate_id IS NULL))
);
CREATE INDEX executions_account_time ON executions(account_id, executed_at DESC);

CREATE TABLE position_lots (            -- FIFO lots; mutable only in qty_open/closed_at
  id              uuid PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id),
  instrument_id   uuid NOT NULL REFERENCES instruments(id),
  open_execution_id uuid NOT NULL REFERENCES executions(id),
  qty_initial     numeric(28,10) NOT NULL CHECK (qty_initial > 0),
  qty_open        numeric(28,10) NOT NULL CHECK (qty_open >= 0 AND qty_open <= qty_initial),
  cost_local_per_unit numeric(28,10) NOT NULL,       -- execution price, EXCLUDING fees (fees are expensed via the FEES account and kept on executions)
  cost_usd_per_unit   numeric(28,10) NOT NULL,       -- USD value of that cost at the entry FX rate
  opened_at       timestamptz NOT NULL,
  closed_at       timestamptz
);
CREATE INDEX lots_open_fifo ON position_lots(account_id, instrument_id, opened_at) WHERE qty_open > 0;

CREATE TABLE lot_closures (            -- append-only: how each sell consumed lots
  id bigserial PRIMARY KEY,
  lot_id uuid NOT NULL REFERENCES position_lots(id),
  close_execution_id uuid NOT NULL REFERENCES executions(id),
  qty numeric(28,10) NOT NULL CHECK (qty > 0),
  proceeds_local numeric(28,10) NOT NULL, cost_local numeric(28,10) NOT NULL,
  proceeds_usd   numeric(28,10) NOT NULL, cost_usd   numeric(28,10) NOT NULL,
  trading_pnl_usd numeric(28,10) NOT NULL, fx_pnl_usd numeric(28,10) NOT NULL
);

CREATE TABLE positions (                -- derived cache; must equal sums over lots (invariant I4)
  account_id    uuid NOT NULL REFERENCES accounts(id),
  instrument_id uuid NOT NULL REFERENCES instruments(id),
  qty           numeric(28,10) NOT NULL CHECK (qty >= 0),
  qty_reserved  numeric(28,10) NOT NULL DEFAULT 0,   -- quantity committed to open SELL orders (long-only: sells cannot exceed qty - qty_reserved)
  avg_cost_local numeric(28,10) NOT NULL,
  realized_trading_pnl_usd numeric(28,10) NOT NULL DEFAULT 0,
  realized_fx_pnl_usd      numeric(28,10) NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, instrument_id),
  CHECK (qty_reserved >= 0 AND qty_reserved <= qty)
);
```

## 8. Idempotency, events, config

```sql
CREATE TABLE idempotency_keys (
  account_id uuid NOT NULL, key text NOT NULL, request_hash bytea NOT NULL,
  response_code int, response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);                                      -- purge after 48 h

CREATE TABLE account_events (           -- transactional outbox; per-account ordered event stream for WebSocket + replay
  account_id uuid NOT NULL REFERENCES accounts(id),
  seq        bigint NOT NULL,
  type       text NOT NULL,             -- order.accepted, order.filled, position.updated, ...
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, seq)
);                                      -- seq allocated from accounts.event_seq under the same row lock as the write
ALTER TABLE accounts ADD COLUMN event_seq bigint NOT NULL DEFAULT 0;

CREATE TABLE fee_schedules (            -- versioned config; never edited in place
  id uuid PRIMARY KEY, asset_class asset_class NOT NULL, exchange_id uuid REFERENCES exchanges(id),
  version int NOT NULL, effective_from timestamptz NOT NULL,
  commission_bps numeric(10,4) NOT NULL DEFAULT 0, commission_min_local numeric(28,10) NOT NULL DEFAULT 0,
  slippage_base_bps numeric(10,4) NOT NULL, slippage_size_coef numeric(10,4) NOT NULL DEFAULT 0,
  fx_spread_bps numeric(10,4) NOT NULL DEFAULT 0,
  model_version text NOT NULL, created_by uuid REFERENCES users(id),
  UNIQUE (asset_class, exchange_id, version)
);
```

## 9. Portfolio, social, analytics

```sql
CREATE TABLE portfolio_snapshots (
  account_id uuid NOT NULL REFERENCES accounts(id), ts timestamptz NOT NULL,
  cash_usd numeric(28,10) NOT NULL, reserved_usd numeric(28,10) NOT NULL,
  positions_value_usd numeric(28,10) NOT NULL, equity_usd numeric(28,10) NOT NULL,
  fx_rate_ids jsonb NOT NULL DEFAULT '{}', quote_snapshot_ids jsonb NOT NULL DEFAULT '{}',
  freshness freshness_state NOT NULL,
  PRIMARY KEY (account_id, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE watchlists (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, position int NOT NULL DEFAULT 0, UNIQUE (user_id, name));
CREATE TABLE watchlist_items (watchlist_id uuid REFERENCES watchlists(id) ON DELETE CASCADE, instrument_id uuid REFERENCES instruments(id), position int NOT NULL DEFAULT 0, PRIMARY KEY (watchlist_id, instrument_id));

CREATE TABLE alerts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), instrument_id uuid NOT NULL REFERENCES instruments(id),
  condition text NOT NULL CHECK (condition IN ('ABOVE','BELOW')), price numeric(28,10) NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE', triggered_at timestamptz
);
CREATE INDEX alerts_active ON alerts(instrument_id) WHERE status = 'ACTIVE';

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), instrument_id uuid NOT NULL REFERENCES instruments(id),
  opened_at timestamptz NOT NULL, closed_at timestamptz NOT NULL,
  qty numeric(28,10) NOT NULL, avg_entry_local numeric(28,10) NOT NULL, avg_exit_local numeric(28,10) NOT NULL,
  trading_pnl_usd numeric(28,10) NOT NULL, fx_pnl_usd numeric(28,10) NOT NULL, fees_usd numeric(28,10) NOT NULL,
  notes text, tags text[] NOT NULL DEFAULT '{}', rating smallint CHECK (rating BETWEEN 1 AND 5)
);

CREATE TABLE competitions (
  id uuid PRIMARY KEY, name text NOT NULL, visibility text NOT NULL CHECK (visibility IN ('PUBLIC','PRIVATE')),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, starting_capital_usd numeric(28,10) NOT NULL,
  rules jsonb NOT NULL, status text NOT NULL DEFAULT 'SCHEDULED'
);
CREATE TABLE competition_participants (
  competition_id uuid REFERENCES competitions(id), user_id uuid REFERENCES users(id),
  account_id uuid NOT NULL REFERENCES accounts(id), score numeric(20,8), rank int, disqualified boolean NOT NULL DEFAULT false,
  PRIMARY KEY (competition_id, user_id)
);
ALTER TABLE accounts ADD CONSTRAINT accounts_comp_fk FOREIGN KEY (competition_id) REFERENCES competitions(id);

CREATE TABLE notifications (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), type text NOT NULL, payload jsonb NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
```

## 10. Partitioning, retention, performance

| Data | Strategy | Retention |
|---|---|---|
| `historical_candles` | Monthly range partitions; PK includes `ts_open`. 1m/5m rows deleted by a nightly job once past their window | 1m: 90 d, 5m/15m: 2 y, 1h/1d: forever |
| `quote_snapshots` | Plain table, daily purge | 30 d |
| `portfolio_snapshots` | Monthly partitions; hourly snapshots while any market is open, daily thereafter (older hourly rows compacted to daily after 90 d) | forever (daily) |
| `ledger_entries`, `executions`, `order_events` | Not partitioned at MVP (volume modest); revisit past ~100M rows (hash by account_id) | forever |
| `account_events` | Keep 7 d hot for WS replay; archive to cold storage | 7 d hot |
| `idempotency_keys` | purge | 48 h |

Raw ticks are **not** stored in Postgres. Latest quote is in Redis; candles aggregate in the market-data worker (flushed every closed bar plus a rolling in-progress bar in Redis).

Hot queries and their indexes: open orders by instrument for the matcher (`orders_open_by_instrument`), account order history (`orders_account_time`), FIFO lot consumption (`lots_open_fifo`), instrument search (trigram), latest FX (`fx_rates_pair_time_idx`).

## 11. Transaction boundaries

1. **Place order:** one transaction: lock account row (`SELECT ... FROM accounts WHERE id=$1 FOR UPDATE`), check idempotency, validate, insert `orders` + `order_events`, post ORDER_RESERVE ledger transaction, bump `accounts.event_seq` and insert `account_events`.
2. **Fill:** one transaction: lock account row then order row, re-validate order is still open and version matches, insert `executions`, post FILL ledger transaction (and FEE if separate), update lots/positions, update order, insert events.
3. **Cancel:** one transaction: lock account, update order with `WHERE status IN (open) AND version=$v`, post ORDER_RELEASE, events.

Lock order is always **account row, then order row**, to avoid deadlocks. Serialisable isolation is not used; row locks plus constraints are sufficient and cheaper.

## 12. Migration considerations

- Migrations via Prisma Migrate for tables, but the immutability/balance triggers, partial indexes, partition setup and CHECKs live in **hand-written SQL migrations** checked in beside the Prisma ones (Prisma cannot express them). CI fails if the live schema differs from the checked-in expected schema.
- Expand → migrate → contract only. No destructive change in the same release as the code that stops using the column.
- Ledger tables never get column type changes without a data-verified shadow-table migration and a reconciliation run before and after.
- Seed data: `currencies`, `exchanges`, `fee_schedules` v1 are migrations, not fixtures.
- Backups: PITR with WAL archiving; restore tested to a scratch instance quarterly, followed by the full invariant suite.
- Adding multi-currency cash wallets or crypto ledger currencies (P3) needs: new rows in `currencies`, new `CASH` ledger accounts per currency; **no change to existing tables**.
- **Note (M1):** the first bullet above is superseded by D-35 (plain SQL migrations via node-pg-migrate; Prisma is a client for non-ledger tables only, schema by introspection, no `prisma migrate`).

## 13. Reconciliation queries (used by the nightly job; see TRADING_ENGINE.md §10)

```sql
-- I1: unbalanced transactions (must return 0 rows)
SELECT transaction_id, currency, SUM(amount) FROM ledger_entries GROUP BY 1,2 HAVING SUM(amount) <> 0;

-- I2: stored balance equals sum of entries (must return 0 rows)
SELECT la.id FROM ledger_accounts la
LEFT JOIN (SELECT ledger_account_id, SUM(amount) s FROM ledger_entries GROUP BY 1) e ON e.ledger_account_id = la.id
WHERE la.balance <> COALESCE(e.s, 0);

-- I4: position qty equals open lots (must return 0 rows)
SELECT p.account_id, p.instrument_id FROM positions p
LEFT JOIN (SELECT account_id, instrument_id, SUM(qty_open) q FROM position_lots GROUP BY 1,2) l USING (account_id, instrument_id)
WHERE p.qty <> COALESCE(l.q, 0);
```
