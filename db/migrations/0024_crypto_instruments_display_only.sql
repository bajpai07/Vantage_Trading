-- Up Migration
-- M7a (D-74, D-75): the simulated crypto market and its instruments, DISPLAY-ONLY until M8.
--
-- * Exchange code CRYPTO (named in DATABASE section 4) with an always-open calendar: crypto never closes.
-- * Six crypto pairs quoted in USD. `tradable_in` is EMPTY, so the trading engine rejects every order on them with
--   INSTRUMENT_NOT_TRADABLE. Crypto trading needs fractional quantities and arrives in M8; until then the pages
--   show quotes and say they cannot be traded yet.
-- * qty_step and min_qty are 0.00000001 (8 decimal places) and fractional_ok is true: recorded now for M8, unused until then.
-- * Tick sizes are the usual ones for each pair on public venues (illustrative; the simulated feed uses the same).
-- * attrs.source = 'SIM': these instruments exist for the simulated feed. No real identifier is invented: a symbol and a
--   base asset only.
-- Ids are fixed UUIDs generated once for this seed. Forward-only; an applied migration is never edited.

INSERT INTO exchanges (id, code, name, country, timezone, calendar)
VALUES (
  '48cd389d-623e-4bbb-88f0-8a03f76eee2f',
  'CRYPTO',
  'Crypto (simulated, 24/7)',
  NULL,
  'UTC',
  $cal$
{
  "version": 1,
  "timezone": "UTC",
  "regular": { "open": "00:00", "close": "23:59", "days": [0, 1, 2, 3, 4, 5, 6] },
  "alwaysOpen": true,
  "holidays": [],
  "earlyCloses": [],
  "coverage": { "from": "2026-01-01", "to": "2026-01-02" }
}
$cal$::jsonb
);

INSERT INTO instruments (id, symbol, name, asset_class, exchange_id, quote_currency, base_asset, tick_size,
                         qty_step, min_qty, fractional_ok, status, tradable_in, attrs)
SELECT v.id::uuid, v.symbol, v.name, 'CRYPTO'::asset_class, e.id, 'USD', v.base_asset, v.tick_size::numeric,
       0.00000001, 0.00000001, true, 'ACTIVE'::instrument_status, '{}'::text[],
       '{"source": "SIM", "simulated": true}'::jsonb
FROM exchanges e,
     (VALUES
       ('36b712b9-b4b4-44bd-95c1-4364e6078ce8', 'BTC-USD',  'Bitcoin',  'BTC',  '0.01'),
       ('b2f3eee8-6994-4bf8-ae38-78bbac6e7e4e', 'ETH-USD',  'Ethereum', 'ETH',  '0.01'),
       ('41955e5b-4d04-44ed-a4b7-76b662f6ca94', 'SOL-USD',  'Solana',   'SOL',  '0.01'),
       ('ed9a5b46-5827-4ba3-a1d5-51c3163cee84', 'XRP-USD',  'XRP',      'XRP',  '0.0001'),
       ('48c91ddc-b0e3-408b-9244-3a068cf590e5', 'DOGE-USD', 'Dogecoin', 'DOGE', '0.00001'),
       ('56aac077-c970-4356-9bd5-b8fde8524405', 'BNB-USD',  'BNB',      'BNB',  '0.01')
     ) AS v(id, symbol, name, base_asset, tick_size)
WHERE e.code = 'CRYPTO';
