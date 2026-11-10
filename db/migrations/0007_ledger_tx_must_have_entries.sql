-- Up Migration
-- D-44(b): a ledger transaction must have at least one entry at commit.
-- (A balanced transaction of non-zero entries then necessarily has at least two.)
CREATE FUNCTION assert_tx_has_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = NEW.id) THEN
    RAISE EXCEPTION 'ledger transaction % has no entries', NEW.id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION assert_tx_has_entries() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER ledger_tx_has_entries AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_tx_has_entries();
