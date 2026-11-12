-- Up Migration
-- D-55 (M4b): the two SECURITY DEFINER lock functions from 0020 are accepted on three conditions:
-- they only take a lock and return nothing, EXECUTE is revoked from PUBLIC and granted only to vantage_app,
-- and the search_path is fixed. 0020's lock_account_for_order also returned the account and user status and
-- lock_cash_balance returned the balance. They now return nothing; the caller reads the status and the balance
-- with an ordinary SELECT after the lock (a new statement, so it sees the latest committed state).
-- 0020 is already applied and is not edited: this migration replaces both functions.
DROP FUNCTION lock_account_for_order(uuid);
DROP FUNCTION lock_cash_balance(uuid);

CREATE FUNCTION lock_account_for_order(p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM accounts WHERE id = p_account FOR UPDATE;
END $$;

CREATE FUNCTION lock_cash_balance(p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM ledger_accounts
   WHERE account_id = p_account AND type = 'CASH' AND currency = 'USD'
     FOR UPDATE;
END $$;

REVOKE ALL ON FUNCTION lock_account_for_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_cash_balance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_account_for_order(uuid) TO vantage_app;
GRANT EXECUTE ON FUNCTION lock_cash_balance(uuid) TO vantage_app;
