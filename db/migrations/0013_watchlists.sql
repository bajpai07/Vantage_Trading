-- Up Migration
-- DATABASE section 9 (watchlists), with the M3a hardening: a name length CHECK and database-level limits
-- (20 lists per user, 100 items per list) so a service bug cannot exceed them. The triggers take an
-- advisory transaction lock first, so two concurrent inserts cannot both pass the count.
CREATE TABLE watchlists (
  id       uuid PRIMARY KEY,
  user_id  uuid NOT NULL REFERENCES users(id),
  name     text NOT NULL,
  position int NOT NULL DEFAULT 0,
  UNIQUE (user_id, name),
  CONSTRAINT watchlists_name_length_chk CHECK (char_length(name) BETWEEN 1 AND 40)
);

CREATE TABLE watchlist_items (
  watchlist_id  uuid REFERENCES watchlists(id) ON DELETE CASCADE,
  instrument_id uuid REFERENCES instruments(id),
  position      int NOT NULL DEFAULT 0,
  PRIMARY KEY (watchlist_id, instrument_id)
);

CREATE FUNCTION enforce_watchlist_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('watchlists:' || NEW.user_id::text, 0));
  IF (SELECT count(*) FROM watchlists WHERE user_id = NEW.user_id) >= 20 THEN
    RAISE EXCEPTION 'watchlist limit reached (20 per user)'
      USING ERRCODE = '23514', CONSTRAINT = 'watchlists_per_user_limit';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enforce_watchlist_limit() FROM PUBLIC;
CREATE TRIGGER watchlists_limit BEFORE INSERT ON watchlists
  FOR EACH ROW EXECUTE FUNCTION enforce_watchlist_limit();

CREATE FUNCTION enforce_watchlist_item_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('watchlist_items:' || NEW.watchlist_id::text, 0));
  IF (SELECT count(*) FROM watchlist_items WHERE watchlist_id = NEW.watchlist_id) >= 100 THEN
    RAISE EXCEPTION 'watchlist item limit reached (100 per list)'
      USING ERRCODE = '23514', CONSTRAINT = 'watchlist_items_per_list_limit';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enforce_watchlist_item_limit() FROM PUBLIC;
CREATE TRIGGER watchlist_items_limit BEFORE INSERT ON watchlist_items
  FOR EACH ROW EXECUTE FUNCTION enforce_watchlist_item_limit();
