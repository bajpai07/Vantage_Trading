-- Up Migration
-- Fixes assert_order_consistent() from migration 0018 (found while writing the M4a integration tests).
-- The original picked the order id with a CASE expression that referenced NEW.order_id even when the trigger
-- fired on `orders` (which has no such column), so PL/pgSQL failed with: record "new" has no field "order_id".
-- Migration 0018 is not edited (migrations are forward-only); this replaces the function body.
CREATE OR REPLACE FUNCTION assert_order_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o orders%ROWTYPE;
  oid uuid;
  exec_sum numeric;
  exec_count int;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    oid := NEW.id;
  ELSE
    oid := NEW.order_id;
  END IF;
  SELECT * INTO o FROM orders WHERE id = oid;
  SELECT COALESCE(SUM(qty), 0), COUNT(*) INTO exec_sum, exec_count FROM executions WHERE order_id = oid;
  IF o.filled_qty <> exec_sum THEN
    RAISE EXCEPTION 'I5: order % has filled_qty % but its executions sum to %', oid, o.filled_qty, exec_sum;
  END IF;
  IF o.status = 'FILLED' AND o.filled_qty <> o.qty THEN
    RAISE EXCEPTION 'I5: FILLED order % has filled_qty % of %', oid, o.filled_qty, o.qty;
  END IF;
  IF o.status = 'REJECTED' AND (o.filled_qty <> 0 OR exec_count <> 0) THEN
    RAISE EXCEPTION 'I5: REJECTED order % must have no fills and no executions', oid;
  END IF;
  IF EXISTS (SELECT 1
               FROM executions e JOIN ledger_transactions t ON t.id = e.ledger_tx_id
              WHERE e.order_id = oid
                AND (e.account_id <> o.account_id OR e.instrument_id <> o.instrument_id
                     OR e.side <> o.side OR t.account_id <> o.account_id)) THEN
    RAISE EXCEPTION 'I5: an execution of order % does not match its order or its ledger transaction account', oid;
  END IF;
  RETURN NULL;
END $$;
