-- Up Migration
-- M7b, D-83: equity-curve catch-up for the simulated feed. A snapshot of a past day may now be valued from the SIM candle
-- price of THAT day (the price at that session's close), so it can be complete (valued_complete = true) even though the
-- in-memory quote store only ever holds the latest quote. The table had no field that says where its marks came from
-- (quote_asof says only when), so this adds one:
--   mark_source IS NULL      the marks (if any) are stored quotes of that trading day (the M5 rule), or there were none
--   mark_source = 'SIM_CANDLE'  every valued position was marked at the simulated candle price at that session's close
-- Existing rows keep NULL, which is what they were. The table stays append-only (the immutability triggers and the
-- SELECT, INSERT-only grant of 0023 are untouched; a new column on an existing table does not need a new grant).
ALTER TABLE equity_snapshots ADD COLUMN mark_source text;
