-- Up Migration
-- M5, decision D-62: one equity snapshot per account per trading day, written after the exchange close from stored
-- data. Append-only (same trigger pattern as the ledger and the trading history). An incomplete valuation
-- (a position without a usable mark) is stored with valued_complete = false: positions_value then covers the valued
-- positions only and equity = cash + positions_value, exactly as GET /v1/portfolio reports it. Nothing is invented.
CREATE TABLE equity_snapshots (
  account_id      uuid NOT NULL REFERENCES accounts(id),
  snapshot_date   date NOT NULL,                   -- the exchange-local trading day (America/New_York for XNYS)
  cash            numeric(28,10) NOT NULL,
  positions_value numeric(28,10) NOT NULL CHECK (positions_value >= 0),
  equity          numeric(28,10) NOT NULL,
  valued_complete boolean NOT NULL,
  quote_asof      timestamptz,                     -- the oldest quote timestamp used; NULL when no position was valued
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, snapshot_date),
  CHECK (equity = cash + positions_value)
);

CREATE TRIGGER equity_snapshots_immutable BEFORE UPDATE OR DELETE ON equity_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER equity_snapshots_no_truncate BEFORE TRUNCATE ON equity_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- vantage_app: SELECT and INSERT only (no UPDATE, DELETE or TRUNCATE).
GRANT SELECT, INSERT ON equity_snapshots TO vantage_app;

-- GET /v1/executions reads each sell's realised P&L from lot_closures by close execution; without this index that
-- lookup scans the table once per execution row.
CREATE INDEX lot_closures_by_close_execution ON lot_closures(close_execution_id);
