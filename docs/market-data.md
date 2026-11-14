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

## Future: live crypto feed (M7a T1 evidence; NOT built)

**Decision (founder, M7a): the demo uses simulated data for both stocks and crypto (D-74).** No live exchange adapter was built. This section records what was checked so a later phase does not have to start from zero, and what was **not** verified.

### Connectivity (measured on this Windows machine, 2026-11-14, `scripts/probe-crypto-feeds.mjs`, 30 s each, no API key)

| Stream                                                                                           | Connected  | Messages      | Notes                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | ---------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `wss://data-stream.binance.vision` (`btcusdt@bookTicker`, `ethusdt@bookTicker`, `btcusdt@trade`) | yes, 1.5 s | 7,398 (245/s) | `bookTicker` has best bid/ask but no provider timestamp; `trade` has `E` and `T` (ms). Symbols look like `BTCUSDT` (quoted in USDT, not USD). |
| `wss://stream.binance.com:9443` (same streams)                                                   | yes, 0.6 s | 6,282 (209/s) | same formats                                                                                                                                  |
| `wss://ws-feed.exchange.coinbase.com` (`ticker`, `heartbeat`, BTC-USD, ETH-USD)                  | yes, 1.3 s | 426 (14/s)    | `ticker` has `best_bid`, `best_ask`, `price`, ISO `time`; products look like `BTC-USD`; a `heartbeat` channel exists                          |

Latency against the local clock was about 600 ms at the median on all three; that is probably clock skew on this machine, not network delay (not investigated).

### Terms: what was and was not read

Read on 2026-11-14 by automated fetch. **Nothing below is a conclusion that the terms permit a demo or public display.**

- **Binance.** The market-data-only FAQ, https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md, says: "These URLs do not require any authentication (i.e. The API key is not necessary) and serve only public market data." It says nothing about permitted uses, redistribution or display. The Terms of Use page, https://www.binance.com/en/terms, returned only navigation and footer text (the body did not load), and the guessed API-terms and market-data-terms pages returned HTTP 404. **Binance's terms were therefore not read.**
- **Coinbase.** The Exchange docs overview, https://docs.cdp.coinbase.com/exchange/docs/websocket-overview, says: "Market Data APIs provide market data and are public." and "By accessing the Exchange Market Data API, you agree to be bound by the Market Data Terms of Use". That document, https://www.coinbase.com/legal/market_data, returned HTTP 403 to the automated fetch (the developer terms page too). **Coinbase's Market Data Terms of Use were therefore not read.** A fetch with a browser-style identity was considered and not done: it would have been getting around a block.
- **Forum and community answers** about whether a portfolio demo is allowed (as relayed by the founder) are not authoritative and are not relied on.

### What a future phase needs before showing live prices

1. **Written confirmation of the terms**, for the use intended (a portfolio demo at first, a public product later): either the exchange's market-data terms read in full and quoted with URL and date, or a written answer from the exchange. A public launch needs this in writing; a hobby demo should not assume it.
2. **Or a licensed data provider** behind the existing `MarketDataProvider` interface (this is also what M3b plans for US stocks).
3. The adapter would implement `MarketDataProvider` and publish through the existing ingest and validator; the engine, the quote store and the API contracts do not change (`mode: LIVE` and a new `source` label are already part of the `/v1/market/feed` contract). It would need reconnect with backoff and jitter, a heartbeat watchdog (a connected but silent socket is not healthy), a symbol map (`BTCUSDT` or `BTC-USD` to `BTC-USD`), bounded queues, a kill switch, and a local fake WebSocket server for tests (no test may use the internet).
4. Notes from the probe for that adapter: Binance quotes in USDT (a USD display would need a stated assumption or a USD pair), `bookTicker` has no timestamp (freshness would come from receive time), Coinbase `ticker` carries `time`.
