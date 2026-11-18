-- Up Migration
-- M8 (D-85 exact cost basis, D-88 crypto fee schedule v2, D-89 tradability). Forward-only; no applied migration is edited.
--
-- 1. position_lots.cost_remaining: the total cost basis of the REMAINING quantity of a lot, 8 decimal places. From now on
--    the ledger POSITION_COST balance equals the sum of cost_remaining over the open lots EXACTLY (reconcile checks it with
--    zero tolerance). cost_local_per_unit stays as the informational per-unit price at purchase.
--    Backfill: qty_open x cost_local_per_unit, which is exact for the whole-share lots that exist today. The DO block
--    below PROVES that: it raises (and the migration fails) if any product needs more than 8 decimal places.
-- 2. The position_lots UPDATE trigger now lets qty_open, cost_remaining and closed_at change, and nothing else. The
--    column grant is widened the same way, so the app role cannot update any other column.
-- 3. The deferred I4 trigger also checks, at commit, that cost_remaining = 0 if and only if qty_open = 0.
-- 4. A NEW crypto fee schedule version (the immutable v1 placeholder of migration 0025 stays in the table): taker commission
--    10 bps, no minimum fee, base slippage 5 bps, size coefficient 0, model QBX-1/r8he. ILLUSTRATIVE values, not a research
--    result (the table has no notes column; this comment and docs/trading.md say so).
-- 5. The seeded crypto instruments get the MVP gate in tradable_in, so the engine accepts them.

-- ---- 1. cost_remaining ---------------------------------------------------------------------------------------
ALTER TABLE position_lots ADD COLUMN cost_remaining numeric(38,8);

UPDATE position_lots SET cost_remaining = qty_open * cost_local_per_unit;

DO $$
DECLARE
  inexact bigint;
BEGIN
  SELECT count(*) INTO inexact FROM position_lots
   WHERE cost_remaining IS DISTINCT FROM (qty_open * cost_local_per_unit);
  IF inexact <> 0 THEN
    RAISE EXCEPTION 'backfill of cost_remaining is not exact for % lot(s)', inexact;
  END IF;
END $$;

-- The backfill UPDATE queued the deferred I4 constraint triggers for every lot it touched; ALTER TABLE refuses to run
-- with pending trigger events (found by the migration test on a database that already holds lots). Running them now
-- also checks, before anything else changes, that the existing data is consistent.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE position_lots ALTER COLUMN cost_remaining SET NOT NULL;
ALTER TABLE position_lots ADD CONSTRAINT position_lots_cost_remaining_nonneg CHECK (cost_remaining >= 0);

-- ---- 2. the column-limited update ----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION position_lots_only_open_qty_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.account_id, NEW.instrument_id, NEW.open_execution_id, NEW.qty_initial,
      NEW.cost_local_per_unit, NEW.cost_usd_per_unit, NEW.opened_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.instrument_id, OLD.open_execution_id, OLD.qty_initial,
      OLD.cost_local_per_unit, OLD.cost_usd_per_unit, OLD.opened_at) THEN
    RAISE EXCEPTION 'position_lots: only qty_open, cost_remaining and closed_at may change';
  END IF;
  RETURN NEW;
END $$;

GRANT UPDATE (cost_remaining) ON position_lots TO vantage_app;

-- ---- 3. I4 at commit, with the cost check ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_position_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lots_sum numeric;
  pos_qty  numeric;
BEGIN
  SELECT COALESCE(SUM(qty_open), 0) INTO lots_sum
    FROM position_lots WHERE account_id = NEW.account_id AND instrument_id = NEW.instrument_id;
  SELECT qty INTO pos_qty
    FROM positions WHERE account_id = NEW.account_id AND instrument_id = NEW.instrument_id;
  IF NOT FOUND THEN
    IF lots_sum <> 0 THEN
      RAISE EXCEPTION 'I4: open lots hold % but there is no positions row (account %, instrument %)',
        lots_sum, NEW.account_id, NEW.instrument_id;
    END IF;
  ELSIF pos_qty <> lots_sum THEN
    RAISE EXCEPTION 'I4: positions.qty % differs from the sum of open lots % (account %, instrument %)',
      pos_qty, lots_sum, NEW.account_id, NEW.instrument_id;
  END IF;
  IF EXISTS (SELECT 1 FROM position_lots
              WHERE account_id = NEW.account_id AND instrument_id = NEW.instrument_id
                AND (qty_open = 0) <> (closed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'I4: closed_at must be set if and only if qty_open = 0 (account %, instrument %)',
      NEW.account_id, NEW.instrument_id;
  END IF;
  IF EXISTS (SELECT 1 FROM position_lots
              WHERE account_id = NEW.account_id AND instrument_id = NEW.instrument_id
                AND (cost_remaining < 0 OR (cost_remaining = 0) <> (qty_open = 0))) THEN
    RAISE EXCEPTION 'I4: cost_remaining must be non-negative and zero if and only if qty_open = 0 (account %, instrument %)',
      NEW.account_id, NEW.instrument_id;
  END IF;
  RETURN NULL;
END $$;

-- ---- 4. crypto fee schedule v2 -------------------------------------------------------------------------------------------
-- Illustrative parameters (D-88): 10 bps taker commission, no minimum, 5 bps base slippage, no size term.
INSERT INTO fee_schedules (id, asset_class, exchange_id, version, effective_from, commission_bps,
                           commission_min_local, slippage_base_bps, slippage_size_coef, fx_spread_bps, model_version)
VALUES
  ('0f6d7a53-3d0a-4c0e-9a57-6b0f0b1d2c11', 'CRYPTO', NULL, 2, '2026-01-01T00:00:00Z', 10, 0, 5, 0, 0, 'QBX-1/r8he');

-- ---- 5. crypto instruments become tradable --------------------------------------------------------------------------------
UPDATE instruments
   SET tradable_in = array_append(tradable_in, 'MVP')
 WHERE asset_class = 'CRYPTO' AND NOT ('MVP' = ANY (tradable_in));
