# Market data (M3a)

Everything the trading engine and the UI need from "market data" except a real vendor, which arrives in M3b. Specs: MARKET_DATA, TRADING_ENGINE sections 2 and 3, DATABASE sections 4 and 9.

**Hard rule: no fabricated data is ever presented as real.** Local and test quotes are `FIXTURE` data: synthetic prices (multiples of 11.11) for real company names. They carry `source: "FIXTURE"` in the database, the API and the logs.

## The pipeline

```
provider.getSnapshot() -> normalise -> validateQuote() -> QuoteStore -> QuoteService -> API
                                  \-> per-feed counters, DEGRADED signal
```

- `MarketDataProvider` (`apps/api/src/modules/market-data/provider.ts`): `id`, `capabilities()`, `loadInstrumentMaster()`, `getSnapshot(symbols)`, `health()`. No candles or subscriptions yet.
- `QuoteIngest`: sets `receivedAt`, runs `validateQuote` from `@vantage/market-model`, updates the store (last accepted quote and any pending outlier), counts: received, accepted, rejected by reason, out of order, warnings. A feed is `DEGRADED` when more than 1% of quotes in a rolling 5-minute window were rejected.
- `QuoteStore` (D-46): an interface with an in-memory implementation (single process). A Redis implementation replaces it when real-time fan-out or several processes are needed.
- `QuoteService.getQuotes(symbols)`: one answer per requested symbol. Freshness comes **only** from the shared `freshness()` function. No valid quote means `UNAVAILABLE` and **no price**.

## Freshness (TRADING_ENGINE section 3)

Evaluated in this order by `freshness(quote, instrumentStatus, calendarState, now)`:

| State         | Rule                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| `UNAVAILABLE` | no valid quote ever, the feed is disabled (kill switch), or the instrument is `DELISTED` |
| `CLOSED`      | the calendar says the market is closed (the quote is the last close)                     |
| `REAL_TIME`   | entitlement `REAL_TIME` and age at most 5 s (equities and ETFs; 3 s for crypto later)    |
| `DELAYED`     | entitlement `DELAYED` and (age - declared delay) at most 60 s; boundaries are inclusive  |
| `STALE`       | everything else                                                                          |

The delayed fixture feed declares 900 s, so a fresh fixture quote has age 900 s and is `DELAYED`; at age 960.001 s it is `STALE`. `REAL_TIME` is not reachable with the fixture feed. `HALTED` and `SELL_ONLY` instruments keep their quote; eligibility rules that depend on status belong to the trading engine.

## Validation (MARKET_DATA section 6)

A quote is rejected (and counted by reason) when: a price is not a plain decimal (`MALFORMED`); bid or ask is zero or negative (`NON_POSITIVE_PRICE`); bid is above ask (`CROSSED`); the provider timestamp is more than 2 s in the future (`FUTURE_TIMESTAMP`); a size is negative (`NEGATIVE_SIZE`); the provider timestamp is older than the last accepted quote (`OUT_OF_ORDER`); or the mid price moved more than 10% from the last accepted quote and no second consecutive tick confirmed it (`OUTLIER_UNCONFIRMED`).

An outlier is **held**: if the very next tick is within 10% of the held tick it is accepted with `gapConfirmed`, otherwise the held tick is discarded. A price off the tick size is a warning only. Nothing is ever corrected silently.

## Calendar (D-47)

The source of truth is `exchanges.calendar` (JSONB), validated with Zod when loaded (`parseCalendar`): IANA time zone, regular session, holidays, early closes and a `coverage` range. Outside the coverage range the market state is `CLOSED` with reason `CALENDAR_NOT_COVERED`: it is never guessed. Time zones come from `Intl` (the platform's IANA database); fixed UTC offsets are never used.

**Source of the 2026 and 2027 data:** the NYSE "Holidays and Trading Hours" page, https://www.nyse.com/trade/hours-calendars, retrieved 2026-11-11 (see the comment at the top of `db/migrations/0012_exchange_calendars_2026_2027.sql`). Nasdaq and NYSE Arca use the same schedule; Nasdaq's own page was not read separately.

**Updating it each year:** read the official page again, add a NEW forward-only migration that updates `exchanges.calendar` for the new years (extend `holidays`, `earlyCloses` and `coverage.to`), record the URL and retrieval date in its header, and extend the expected data in `packages/market-model/src/testing.ts` and the calendar tests. Never edit an applied migration. Do this before `coverage.to` is reached, or the market will show as closed.

## FIXTURE policy (D-48)

- `FixtureProvider` exists for `local` and `test` only and **throws if constructed** when `APP_ENV` is `staging` or `production`.
- Its instruments carry `attrs.source = 'FIXTURE'`. At startup the app refuses to boot in staging or production if any such instrument exists, or if the quote source is `FIXTURE`.
- `MARKET_DATA_SOURCE=PROVIDER` has no adapter yet: `main.js` exits with `no provider adapter installed; M3b`.
- Hard-coded price tables are allowed only in `apps/api/src/modules/market-data/fixture/` (a test scans the source tree).

## Instrument master sync

`syncInstrumentMaster(pool, provider, deps)` reconciles a provider's master into `instruments` and `instrument_provider_map` in one transaction. It is idempotent (a second run writes nothing; `updated_at` moves only when a value changes), never deletes, and only sets `DELISTED` when the provider explicitly reports it. Instruments missing from the master are left alone and logged. It runs at startup in `local` and `test` with the fixture provider and is a plain function a scheduled job can call. Production data will come from the vendor adapter in M3b.

## What M3b adds

A real provider adapter (US delayed consolidated data under a commercial licence) behind the same `MarketDataProvider` interface, entitlement taken from the vendor contract, nightly master sync, a `provider_feeds` configuration with licence references, health monitoring, and (when needed) a Redis `QuoteStore`. M4 (trading) reads quotes through `QuoteService` and must treat `STALE`, `CLOSED` and `UNAVAILABLE` as not eligible.
