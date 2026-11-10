-- Up Migration
-- DATABASE section 6 triggers, with the M1 hardening (TRUNCATE triggers, SECURITY DEFINER apply_entry).

-- Immutability. TRUNCATE skips row triggers, so it gets its own statement-level triggers.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
REVOKE ALL ON FUNCTION forbid_mutation() FROM PUBLIC;

CREATE TRIGGER ledger_tx_immutable    BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entry_immutable BEFORE UPDATE OR DELETE ON ledger_entries      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fx_rate_immutable      BEFORE UPDATE OR DELETE ON fx_rates            FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_tx_no_truncate    BEFORE TRUNCATE ON ledger_transactions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entry_no_truncate BEFORE TRUNCATE ON ledger_entries      FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fx_rate_no_truncate      BEFORE TRUNCATE ON fx_rates            FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Keep the account balance consistent with entries, in the same transaction.
-- SECURITY DEFINER: vantage_app has no UPDATE privilege on ledger_accounts, so balances move only
-- through entries. The entry currency must match the ledger account currency (guard added in M1).
CREATE FUNCTION apply_entry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE ledger_accounts SET balance = balance + NEW.amount
   WHERE id = NEW.ledger_account_id AND currency = NEW.currency;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger entry currency % does not match ledger account %', NEW.currency, NEW.ledger_account_id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION apply_entry() FROM PUBLIC;
CREATE TRIGGER ledger_entry_apply AFTER INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION apply_entry();

-- Every transaction must balance per currency at COMMIT.
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
REVOKE ALL ON FUNCTION assert_tx_balanced() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER ledger_tx_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_tx_balanced();
