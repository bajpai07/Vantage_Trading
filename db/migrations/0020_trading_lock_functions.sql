-- Up Migration
-- executeMarketOrder must lock the accounts row and the CASH ledger account row (DATABASE section 11, and the
-- lock order account -> CASH -> position -> lots). PostgreSQL requires the UPDATE privilege for any row-locking
-- clause (FOR UPDATE, FOR SHARE ...). vantage_app deliberately has NO UPDATE on accounts or ledger_accounts
-- (balances change only through ledger entries, M1), so granting it would weaken that rule. Instead two narrow
-- SECURITY DEFINER functions (owner: the migrator, fixed search_path, EXECUTE only for vantage_app) take exactly
-- those two locks and return what the caller needs to read under them. The app gains no table privilege.
CREATE FUNCTION lock_account_for_order(p_account uuid, OUT account_status text, OUT user_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  SELECT a.status, u.status::text INTO account_status, user_status
    FROM accounts a JOIN users u ON u.id = a.user_id
   WHERE a.id = p_account
     FOR UPDATE OF a;
END $$;

CREATE FUNCTION lock_cash_balance(p_account uuid) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b numeric;
BEGIN
  SELECT balance INTO b FROM ledger_accounts
   WHERE account_id = p_account AND type = 'CASH' AND currency = 'USD'
     FOR UPDATE;
  RETURN b;
END $$;

REVOKE ALL ON FUNCTION lock_account_for_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_cash_balance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_account_for_order(uuid) TO vantage_app;
GRANT EXECUTE ON FUNCTION lock_cash_balance(uuid) TO vantage_app;
