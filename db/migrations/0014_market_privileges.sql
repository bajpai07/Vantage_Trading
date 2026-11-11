-- Up Migration
-- Explicit, minimal grants for the application role. Instruments are never deleted (delisting is a
-- status change), so there is no DELETE on them; exchanges (the calendars) are read-only to the app.
GRANT SELECT ON exchanges TO vantage_app;
GRANT SELECT, INSERT, UPDATE ON instruments TO vantage_app;
GRANT SELECT, INSERT, UPDATE ON instrument_provider_map TO vantage_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON watchlists TO vantage_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON watchlist_items TO vantage_app;
