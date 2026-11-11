-- Up Migration
-- DATABASE section 2: the order enums (not created before M4a).
CREATE TYPE order_side    AS ENUM ('BUY','SELL');
CREATE TYPE order_type    AS ENUM ('MARKET','LIMIT','STOP','STOP_LIMIT');
CREATE TYPE time_in_force AS ENUM ('DAY','GTC','IOC','FOK');
CREATE TYPE order_status  AS ENUM ('NEW','ACCEPTED','PARTIALLY_FILLED','FILLED',
                                   'CANCEL_REQUESTED','CANCELLED','REJECTED','EXPIRED');
