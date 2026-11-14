-- Up Migration
-- M7a: a version 1 fee schedule for CRYPTO (D-54). Crypto is display-only until M8, so no order is ever filled with it,
-- but the order path loads the fee schedule of an instrument's asset class before it decides (and rejects with
-- INSTRUMENT_NOT_TRADABLE), so without a row every crypto order would be an internal error instead of that reject.
-- Placeholder values like the stock schedule: commission 0 bps, base slippage 2 bps, size coefficient 0. They are
-- illustrative and must be reviewed in M8, when crypto trading is designed: that is a NEW version row, never an edit.
-- exchange_id NULL means "every exchange". The id is a fixed UUID generated once for this seed.
INSERT INTO fee_schedules (id, asset_class, exchange_id, version, effective_from, commission_bps,
                           commission_min_local, slippage_base_bps, slippage_size_coef, fx_spread_bps, model_version)
VALUES
  ('85f59cc7-7860-45a3-b32f-8229106b7ee6', 'CRYPTO', NULL, 1, '2026-01-01T00:00:00Z', 0, 0, 2, 0, 0, 'QBX-1/r8he');
