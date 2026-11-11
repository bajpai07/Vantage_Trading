-- Up Migration
-- Explicit, minimal grants for the application role. No DELETE or TRUNCATE anywhere.
-- orders get no UPDATE in M4a (D-49): rows are inserted once in their final state.
GRANT SELECT, INSERT ON orders, order_events, executions, lot_closures, idempotency_keys TO vantage_app;
GRANT SELECT, INSERT ON position_lots TO vantage_app;
GRANT UPDATE (qty_open, closed_at) ON position_lots TO vantage_app;
GRANT SELECT, INSERT, UPDATE ON positions TO vantage_app;
GRANT SELECT ON fee_schedules TO vantage_app;
GRANT USAGE ON SEQUENCE order_events_id_seq, lot_closures_id_seq TO vantage_app;
