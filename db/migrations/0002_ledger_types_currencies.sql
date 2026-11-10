-- Up Migration
-- DATABASE section 2 (enums needed by the ledger) and section 4 (currencies).
CREATE TYPE account_kind     AS ENUM ('MAIN','COMPETITION');
CREATE TYPE ledger_acct_type AS ENUM ('CAPITAL','CASH','RESERVED','POSITION_COST',
                                      'FEES','REALIZED_PNL','FX_CLEARING','ADJUSTMENT');
CREATE TYPE ledger_tx_kind   AS ENUM ('GRANT','ORDER_RESERVE','ORDER_RELEASE','FILL','FEE',
                                      'CORPORATE_ACTION','ADJUSTMENT','COMPETITION_GRANT');

CREATE TABLE currencies (
  code char(3) PRIMARY KEY, name text NOT NULL, minor_units smallint NOT NULL
);
INSERT INTO currencies VALUES ('USD','US Dollar',2),('INR','Indian Rupee',2);
