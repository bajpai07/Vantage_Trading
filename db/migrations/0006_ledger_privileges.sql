-- Up Migration
-- Explicit, minimal grants for the application role. No UPDATE, DELETE or TRUNCATE on anything:
-- balances change only through ledger entries (apply_entry is SECURITY DEFINER).
GRANT SELECT ON accounts, ledger_accounts, ledger_transactions, ledger_entries, fx_rates, currencies TO vantage_app;
GRANT INSERT ON accounts, ledger_accounts, ledger_transactions, ledger_entries TO vantage_app;
GRANT USAGE ON SEQUENCE ledger_entries_id_seq TO vantage_app;
