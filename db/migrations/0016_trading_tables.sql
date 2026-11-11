-- Up Migration
-- DATABASE sections 7 and 8, exactly as specified, for: orders, order_events, executions, position_lots,
-- lot_closures, positions, idempotency_keys (created now, used in M4b) and fee_schedules.
-- NOT created in M4a: account_events and accounts.event_seq (the outbox comes later).

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

CREATE TABLE idempotency_keys (
  account_id uuid NOT NULL, key text NOT NULL, request_hash bytea NOT NULL,
  response_code int, response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);                                      -- purge after 48 h

-- NOTE: UNIQUE (asset_class, exchange_id, version) does not stop two version-1 rows with exchange_id NULL
-- (PostgreSQL treats NULLs as distinct). A partial unique index closes that gap for the global schedules.
CREATE TABLE fee_schedules (            -- versioned config; never edited in place
  id uuid PRIMARY KEY, asset_class asset_class NOT NULL, exchange_id uuid REFERENCES exchanges(id),
  version int NOT NULL, effective_from timestamptz NOT NULL,
  commission_bps numeric(10,4) NOT NULL DEFAULT 0, commission_min_local numeric(28,10) NOT NULL DEFAULT 0,
  slippage_base_bps numeric(10,4) NOT NULL, slippage_size_coef numeric(10,4) NOT NULL DEFAULT 0,
  fx_spread_bps numeric(10,4) NOT NULL DEFAULT 0,
  model_version text NOT NULL, created_by uuid REFERENCES users(id),
  UNIQUE (asset_class, exchange_id, version)
);
CREATE UNIQUE INDEX fee_schedules_global_version ON fee_schedules(asset_class, version) WHERE exchange_id IS NULL;
