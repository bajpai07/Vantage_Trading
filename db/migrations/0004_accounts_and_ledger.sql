-- Up Migration
-- DATABASE section 6, tables only. Deviation D-38: accounts.user_id has NO foreign key to users yet;
-- the M2 migration that creates `users` adds it.
CREATE TABLE accounts (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL,
  kind             account_kind NOT NULL,
  competition_id   uuid,
  base_currency    char(3) NOT NULL DEFAULT 'USD' CHECK (base_currency = 'USD'),
  initial_capital  numeric(28,10) NOT NULL CHECK (initial_capital > 0),
  status           text NOT NULL DEFAULT 'ACTIVE',
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- exactly one MAIN account per user => the $10,000 grant can happen once
CREATE UNIQUE INDEX accounts_one_main ON accounts(user_id) WHERE kind = 'MAIN';

CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id),
  type        ledger_acct_type NOT NULL,
  currency    char(3) NOT NULL REFERENCES currencies(code),
  balance     numeric(28,10) NOT NULL DEFAULT 0,      -- maintained by trigger from entries
  UNIQUE (account_id, type, currency),
  -- no overdraft: free cash and reservations can never go negative
  CONSTRAINT ledger_accounts_nonneg_chk
    CHECK (type NOT IN ('CASH','RESERVED','POSITION_COST') OR balance >= 0)
);

-- A new ledger account always starts at balance 0: balances change only through entries.
CREATE FUNCTION ledger_account_starts_at_zero() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance <> 0 THEN
    RAISE EXCEPTION 'a new ledger account must start with balance 0';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_account_starts_at_zero() FROM PUBLIC;
CREATE TRIGGER ledger_account_zero_start BEFORE INSERT ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_account_starts_at_zero();

CREATE TABLE ledger_transactions (
  id              uuid PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id),
  kind            ledger_tx_kind NOT NULL,
  idempotency_key text NOT NULL,
  order_id        uuid, execution_id uuid,
  description     text,
  effective_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);

CREATE TABLE ledger_entries (
  id                bigserial PRIMARY KEY,
  transaction_id    uuid NOT NULL REFERENCES ledger_transactions(id),
  ledger_account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  currency          char(3) NOT NULL REFERENCES currencies(code),
  amount            numeric(28,10) NOT NULL CHECK (amount <> 0),  -- signed; +increase, -decrease of the account balance
  fx_rate_id        bigint REFERENCES fx_rates(id),               -- present on cross-currency legs
  amount_usd        numeric(28,10) NOT NULL,                      -- USD value at the transaction rate (reporting only)
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_tx_idx   ON ledger_entries(transaction_id);
CREATE INDEX ledger_entries_acct_idx ON ledger_entries(ledger_account_id, id);
