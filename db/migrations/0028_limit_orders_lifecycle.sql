-- Up Migration
-- M8b-1 (D-91 order lifecycle, D-96 reserved quantity, D-97 limit orders). Forward-only; no applied migration is edited.
--
-- Until now orders were inserted once in their final state and never updated (D-49): `orders_immutable` forbade every
-- UPDATE and the app role had no UPDATE privilege. LIMIT orders rest as ACCEPTED and then change state, so:
--
-- 1. `orders_immutable` is replaced by `orders_no_delete` (rows are still never deleted) and by a GUARDED UPDATE trigger:
--      * a terminal row (FILLED, CANCELLED, REJECTED, EXPIRED) never changes at all (MARKET orders are inserted FILLED or
--        REJECTED, so they keep the M4a behaviour: never updated);
--      * only status, filled_qty, reserved_usd, version, updated_at and triggered_at may change; every other column
--        (identity, price, tif, quantity, expiry, ...) is fixed for the life of the order;
--      * the only edges are ACCEPTED -> FILLED, ACCEPTED -> CANCELLED and ACCEPTED -> EXPIRED (so ACCEPTED -> ACCEPTED,
--        a skipped state or a revival are errors), and `version` must increase by exactly 1;
--      * there are no partial fills in the MVP: FILLED means filled_qty = qty, CANCELLED and EXPIRED mean filled_qty = 0.
--    The trigger applies to every role, so the owner cannot bypass it either.
-- 2. The app role gets a COLUMN-LIMITED UPDATE on those six columns (and still no DELETE or TRUNCATE anywhere).
-- 3. The deferred I5 trigger also runs after an UPDATE of an order and additionally checks: a terminal order has
--    reserved_usd = 0 (a reservation is always released before an order ends) and a CANCELLED or EXPIRED order has no
--    execution (I6).
-- 4. `order_events` already is append-only (no UPDATE or DELETE); a deferred trigger now also checks that `seq` is
--    contiguous (1..n, no gaps) per order at commit.
-- 5. The RESERVED USD ledger account exists for every account (createAccount has made it since M1); this backfills any
--    account that lacks one, idempotently.
-- 6. An index for the expiry job. orders_open_by_instrument (ACCEPTED, PARTIALLY_FILLED, CANCEL_REQUESTED by instrument)
--    already exists from migration 0016 and is used by the matcher; the enum values and the ORDER_RESERVE / ORDER_RELEASE
--    ledger kinds already exist (migrations 0002 and 0015).

-- ---- 1. the guarded update --------------------------------------------------------------------------------------------
DROP TRIGGER orders_immutable ON orders;
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION orders_guarded_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED') THEN
    RAISE EXCEPTION 'orders: % is a terminal state and the order never changes', OLD.status;
  END IF;
  IF (NEW.id, NEW.account_id, NEW.instrument_id, NEW.client_order_id, NEW.side, NEW.type, NEW.tif, NEW.qty,
      NEW.limit_price, NEW.stop_price, NEW.reject_code, NEW.parent_order_id, NEW.oco_group_id, NEW.expires_at,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.instrument_id, OLD.client_order_id, OLD.side, OLD.type, OLD.tif, OLD.qty,
      OLD.limit_price, OLD.stop_price, OLD.reject_code, OLD.parent_order_id, OLD.oco_group_id, OLD.expires_at,
      OLD.created_at) THEN
    RAISE EXCEPTION 'orders: only status, filled_qty, reserved_usd, version, updated_at and triggered_at may change';
  END IF;
  IF OLD.status <> 'ACCEPTED' OR NEW.status NOT IN ('FILLED', 'CANCELLED', 'EXPIRED') THEN
    RAISE EXCEPTION 'orders: the transition % -> % is not allowed (only ACCEPTED -> FILLED, CANCELLED or EXPIRED)',
      OLD.status, NEW.status;
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'orders: version must increase by exactly 1 (% -> %)', OLD.version, NEW.version;
  END IF;
  IF NEW.status = 'FILLED' AND NEW.filled_qty <> NEW.qty THEN
    RAISE EXCEPTION 'orders: a FILLED order has filled_qty = qty (no partial fills in the MVP)';
  END IF;
  IF NEW.status IN ('CANCELLED', 'EXPIRED') AND NEW.filled_qty <> 0 THEN
    RAISE EXCEPTION 'orders: a % order has filled_qty 0 (no partial fills in the MVP)', NEW.status;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION orders_guarded_update() FROM PUBLIC;
CREATE TRIGGER orders_guarded_update BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_guarded_update();

-- ---- 2. grants ------------------------------------------------------------------------------------------------------------
GRANT UPDATE (status, filled_qty, reserved_usd, version, updated_at, triggered_at) ON orders TO vantage_app;

-- ---- 3. I5 and I6 at commit, also after an UPDATE of an order -------------------------------------------------------------
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
  IF o.status IN ('FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED') AND o.reserved_usd <> 0 THEN
    RAISE EXCEPTION 'I5: terminal order % (%) still has reserved_usd %', oid, o.status, o.reserved_usd;
  END IF;
  IF o.status IN ('CANCELLED', 'EXPIRED') AND exec_count <> 0 THEN
    RAISE EXCEPTION 'I6: % order % has an execution', o.status, oid;
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

CREATE CONSTRAINT TRIGGER orders_consistent_after_update AFTER UPDATE ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_order_consistent();

-- ---- 4. order_events: contiguous seq at commit ----------------------------------------------------------------------------
CREATE FUNCTION assert_order_events_contiguous() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n int;
  hi int;
BEGIN
  SELECT COUNT(*), COALESCE(MAX(seq), 0) INTO n, hi FROM order_events WHERE order_id = NEW.order_id;
  IF n <> hi THEN
    RAISE EXCEPTION 'order_events: order % has % events but the highest seq is % (seq must be contiguous from 1)',
      NEW.order_id, n, hi;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION assert_order_events_contiguous() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER order_events_contiguous AFTER INSERT ON order_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_order_events_contiguous();

-- ---- 5. RESERVED ledger accounts for every account (idempotent) ------------------------------------------------------------
INSERT INTO ledger_accounts (id, account_id, type, currency)
SELECT gen_random_uuid(), a.id, 'RESERVED', 'USD'
  FROM accounts a
 WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts la
                    WHERE la.account_id = a.id AND la.type = 'RESERVED' AND la.currency = 'USD');

-- ---- 6. index for the expiry job ------------------------------------------------------------------------------------------
CREATE INDEX orders_open_by_expiry ON orders(expires_at) WHERE status = 'ACCEPTED' AND expires_at IS NOT NULL;
