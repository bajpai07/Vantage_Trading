-- Up Migration
-- DATABASE section 5 (fx_rates only).
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
