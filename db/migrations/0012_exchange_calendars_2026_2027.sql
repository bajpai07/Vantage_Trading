-- Up Migration
-- Exchange calendars for calendar years 2026 and 2027 (D-47). A yearly update is a NEW forward-only migration.
--
-- SOURCE (official): NYSE "Holidays and Trading Hours" page
--   https://www.nyse.com/trade/hours-calendars
-- RETRIEVED: 2026-11-11 (page text read through an automated fetch; the page lists 2026, 2027 and 2028).
-- The page says "All NYSE markets observe U.S. holidays as listed below for 2026, 2027, and 2028", which
-- includes NYSE Arca. Nasdaq follows the same schedule (stated in the M3a task); Nasdaq's own page was
-- NOT read separately, so re-check it when this calendar is next refreshed.
--
-- Full-day closures taken from the page:
--   2026: Jan 1 (New Year's Day), Jan 19 (Martin Luther King, Jr. Day), Feb 16 (Washington's Birthday),
--         Apr 3 (Good Friday), May 25 (Memorial Day), Jun 19 (Juneteenth), Jul 3 (Independence Day observed),
--         Sep 7 (Labor Day), Nov 26 (Thanksgiving Day), Dec 25 (Christmas Day)
--   2027: Jan 1 (New Year's Day), Jan 18 (Martin Luther King, Jr. Day), Feb 15 (Washington's Birthday),
--         Mar 26 (Good Friday), May 31 (Memorial Day), Jun 18 (Juneteenth observed), Jul 5 (Independence Day
--         observed), Sep 6 (Labor Day), Nov 25 (Thanksgiving Day), Dec 24 (Christmas Day observed)
-- Early closes at 1:00 p.m. ET (page footnotes): Fri 2026-11-27, Thu 2026-12-24, Fri 2027-11-26.
-- The page lists no early close for Christmas Eve 2027 because Christmas is observed on that Friday.
-- Regular session: 9:30 a.m. to 4:00 p.m. ET, Monday to Friday, extended hours not supported (TRADING_ENGINE 2).
--
-- Dates are also checked by tests against the weekday and observance rules; weekends are not listed.
-- Exchange ids are fixed UUIDv7 values generated once for this seed.

INSERT INTO exchanges (id, code, name, country, timezone, calendar)
SELECT v.id::uuid, v.code, v.name, 'US', 'America/New_York', $cal$
{
  "version": 1,
  "timezone": "America/New_York",
  "regular": { "open": "09:30", "close": "16:00", "days": [1, 2, 3, 4, 5] },
  "holidays": [
    { "date": "2026-01-01", "name": "New Year's Day" },
    { "date": "2026-01-19", "name": "Martin Luther King, Jr. Day" },
    { "date": "2026-02-16", "name": "Washington's Birthday" },
    { "date": "2026-04-03", "name": "Good Friday" },
    { "date": "2026-05-25", "name": "Memorial Day" },
    { "date": "2026-06-19", "name": "Juneteenth National Independence Day" },
    { "date": "2026-07-03", "name": "Independence Day (observed)" },
    { "date": "2026-09-07", "name": "Labor Day" },
    { "date": "2026-11-26", "name": "Thanksgiving Day" },
    { "date": "2026-12-25", "name": "Christmas Day" },
    { "date": "2027-01-01", "name": "New Year's Day" },
    { "date": "2027-01-18", "name": "Martin Luther King, Jr. Day" },
    { "date": "2027-02-15", "name": "Washington's Birthday" },
    { "date": "2027-03-26", "name": "Good Friday" },
    { "date": "2027-05-31", "name": "Memorial Day" },
    { "date": "2027-06-18", "name": "Juneteenth National Independence Day (observed)" },
    { "date": "2027-07-05", "name": "Independence Day (observed)" },
    { "date": "2027-09-06", "name": "Labor Day" },
    { "date": "2027-11-25", "name": "Thanksgiving Day" },
    { "date": "2027-12-24", "name": "Christmas Day (observed)" }
  ],
  "earlyCloses": [
    { "date": "2026-11-27", "close": "13:00", "name": "Day after Thanksgiving" },
    { "date": "2026-12-24", "close": "13:00", "name": "Christmas Eve" },
    { "date": "2027-11-26", "close": "13:00", "name": "Day after Thanksgiving" }
  ],
  "coverage": { "from": "2026-01-01", "to": "2027-12-31" }
}
$cal$::jsonb
FROM (VALUES
  ('01a1cabf-7d4f-7602-a66e-ecdd0fa53dcb', 'XNYS', 'New York Stock Exchange'),
  ('01a1cabf-7d51-702c-8627-70fd2cf5d24d', 'XNAS', 'Nasdaq Stock Market'),
  ('01a1cabf-7d51-702c-8627-76d945a39f6d', 'ARCX', 'NYSE Arca')
) AS v(id, code, name);
