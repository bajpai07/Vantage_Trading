-- Up Migration
-- DATABASE section 2: the enums needed by instruments and market data (not created before M3a).
CREATE TYPE asset_class       AS ENUM ('EQUITY','ETF','CRYPTO','INDEX','FX','COMMODITY');
CREATE TYPE instrument_status AS ENUM ('ACTIVE','HALTED','SELL_ONLY','DELISTED');
CREATE TYPE quote_entitlement AS ENUM ('REAL_TIME','DELAYED');
CREATE TYPE freshness_state   AS ENUM ('REAL_TIME','DELAYED','STALE','CLOSED','UNAVAILABLE');
