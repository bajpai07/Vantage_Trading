-- Up Migration
-- DATABASE section 4: exchanges, instruments, instrument_provider_map (exactly as specified,
-- including both trigram indexes). Stocks and ETFs are whole shares in the MVP (D-33): the sync
-- job writes fractional_ok = false, qty_step = 1, min_qty = 1 for them.
CREATE TABLE exchanges (
  id         uuid PRIMARY KEY,
  code       text NOT NULL UNIQUE,                -- XNAS, XNYS, ARCX, XNSE, XBOM, CRYPTO
  name       text NOT NULL,
  country    char(2), timezone text NOT NULL,
  calendar   jsonb NOT NULL                       -- sessions + holidays, see MARKET_DATA.md section 8
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
