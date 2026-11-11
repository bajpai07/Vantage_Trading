-- Up Migration
-- Immutability (reusing forbid_mutation) and the commit-time invariants I4 and I5 (D-53).

-- ---- 1. immutability ------------------------------------------------------------------------------
-- orders are inserted once in their final state in M4a and never updated (D-49).
CREATE TRIGGER orders_immutable        BEFORE UPDATE OR DELETE ON orders       FOR EACH ROW       EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER orders_no_truncate      BEFORE TRUNCATE         ON orders       FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER order_events_immutable  BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW       EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER order_events_no_truncate BEFORE TRUNCATE        ON order_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER executions_immutable    BEFORE UPDATE OR DELETE ON executions   FOR EACH ROW       EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER executions_no_truncate  BEFORE TRUNCATE         ON executions   FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER lot_closures_immutable  BEFORE UPDATE OR DELETE ON lot_closures FOR EACH ROW       EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER lot_closures_no_truncate BEFORE TRUNCATE        ON lot_closures FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fee_schedules_immutable BEFORE UPDATE OR DELETE ON fee_schedules FOR EACH ROW      EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fee_schedules_no_truncate BEFORE TRUNCATE       ON fee_schedules FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- position_lots: rows are never deleted; only qty_open and closed_at may change.
CREATE TRIGGER position_lots_no_delete   BEFORE DELETE   ON position_lots FOR EACH ROW       EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER position_lots_no_truncate BEFORE TRUNCATE ON position_lots FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION position_lots_only_open_qty_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.account_id, NEW.instrument_id, NEW.open_execution_id, NEW.qty_initial,
      NEW.cost_local_per_unit, NEW.cost_usd_per_unit, NEW.opened_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.instrument_id, OLD.open_execution_id, OLD.qty_initial,
      OLD.cost_local_per_unit, OLD.cost_usd_per_unit, OLD.opened_at) THEN
    RAISE EXCEPTION 'position_lots: only qty_open and closed_at may change';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION position_lots_only_open_qty_changes() FROM PUBLIC;
CREATE TRIGGER position_lots_limited_update BEFORE UPDATE ON position_lots
  FOR EACH ROW EXECUTE FUNCTION position_lots_only_open_qty_changes();

-- ---- 2. I4 at commit: positions.qty = sum of lot qty_open ---------------------------------------------
-- For every (account, instrument) touched in the transaction: the positions row equals the lot sum (a missing
-- positions row is allowed only when the lot sum is 0); closed_at is set if and only if qty_open = 0.
-- (qty_open <= qty_initial is the table CHECK.)
CREATE FUNCTION assert_position_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lots_sum numeric;
  pos_qty  numeric;
BEGIN
  SELECT COALESCE(SUM(qty_open), 0) INTO lots_sum
    FROM position_lots WHERE account_id = NEW.account_id AND instrument_id = NEW.instrument_id;
  SELECT qty INTO pos_qty
    FROM positions WHERE account_id = NEW.account_id AND instrument_id = NEW.instrument_id;
  IF NOT FOUND THEN
    IF lots_sum <> 0 THEN
      RAISE EXCEPTION 'I4: open lots hold % but there is no positions row (account %, instrument %)',
        lots_sum, NEW.account_id, NEW.instrument_id;
    END IF;
  ELSIF pos_qty <> lots_sum THEN
    RAISE EXCEPTION 'I4: positions.qty % differs from the sum of open lots % (account %, instrument %)',
      pos_qty, lots_sum, NEW.account_id, NEW.instrument_id;
  END IF;
  IF EXISTS (SELECT 1 FROM position_lots
              WHERE account_id = NEW.account_id AND instrument_id = NEW.instrument_id
                AND (qty_open = 0) <> (closed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'I4: closed_at must be set if and only if qty_open = 0 (account %, instrument %)',
      NEW.account_id, NEW.instrument_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION assert_position_consistent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER position_lots_consistent AFTER INSERT OR UPDATE ON position_lots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_position_consistent();
CREATE CONSTRAINT TRIGGER positions_consistent AFTER INSERT OR UPDATE ON positions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_position_consistent();

-- ---- 3. I5 at commit: orders.filled_qty = sum of executions.qty ---------------------------------------
-- Also: FILLED means filled_qty = qty; REJECTED means filled_qty = 0 and no execution; every execution
-- matches its order's account, instrument and side, and its ledger transaction belongs to the same account.
CREATE FUNCTION assert_order_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o orders%ROWTYPE;
  oid uuid;
  exec_sum numeric;
  exec_count int;
BEGIN
  oid := CASE WHEN TG_TABLE_NAME = 'orders' THEN NEW.id ELSE NEW.order_id END;
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
REVOKE ALL ON FUNCTION assert_order_consistent() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER orders_consistent AFTER INSERT ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_order_consistent();
CREATE CONSTRAINT TRIGGER executions_order_consistent AFTER INSERT ON executions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_order_consistent();
