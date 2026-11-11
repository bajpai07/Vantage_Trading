-- Up Migration
-- D-54: fee and slippage parameters live in a versioned, immutable table. Version 1 for stocks and ETFs:
-- commission 0 bps, base slippage 2 bps, size coefficient 0 (there is no ADV data yet), model QBX-1/r8he.
-- exchange_id NULL means "every exchange". effective_from is a fixed past date. A later version is a NEW row.
-- Ids are fixed UUIDv7 values generated once for this seed.
INSERT INTO fee_schedules (id, asset_class, exchange_id, version, effective_from, commission_bps,
                           commission_min_local, slippage_base_bps, slippage_size_coef, fx_spread_bps, model_version)
VALUES
  ('01a1caee-b2bb-7580-abef-cd8d38ca0b29', 'EQUITY', NULL, 1, '2026-01-01T00:00:00Z', 0, 0, 2, 0, 0, 'QBX-1/r8he'),
  ('01a1caee-b2bd-75a3-aa96-c012b34c19cf', 'ETF',    NULL, 1, '2026-01-01T00:00:00Z', 0, 0, 2, 0, 0, 'QBX-1/r8he');
