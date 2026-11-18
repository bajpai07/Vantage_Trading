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

## The simulated feed (M7a: SIM, stocks and crypto)

The demo runs on **simulated data for both stocks and crypto** (D-74): no exchange, no vendor, no network. Every simulated quote is labelled `SIM` end to end (quote responses, `/v1/market/feed`, the banner, and `quote_source` on every execution row). Nothing about it is real: it must never be presented as real market data.

### Sources and labels (D-75)

| Source                    | Where                                                      | Mode in `/v1/market/feed` | Entitlement                                                                        |
| ------------------------- | ---------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `SIM`                     | simulated stocks, ETFs and (with `CRYPTO_FEED=sim`) crypto | `SIMULATED`               | `REAL_TIME` (so the shared freshness function works unchanged), label always `SIM` |
| `FIXTURE`                 | local development and tests only (D-48)                    | `FIXTURE`                 | `DELAYED`, 900 s                                                                   |
| a live exchange or vendor | **not built** (see "Future: live crypto feed")             | `LIVE`                    | from the contract                                                                  |

### Configuration and guards (D-76, D-77)

| Variable             | Values                            | Rule                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARKET_DATA_SOURCE` | `FIXTURE`, `SIM`, `PROVIDER`      | stocks and ETFs. `FIXTURE` is refused in staging and production; `PROVIDER` has no adapter yet (M3b)                                                                                                                                                                |
| `CRYPTO_FEED`        | `off` (default), `sim`            | `sim` needs `MARKET_DATA_SOURCE=SIM` (one provider per process). Off: crypto instruments exist but are `UNAVAILABLE`                                                                                                                                                |
| `SIM_SESSION`        | `NYSE` (default), `ALWAYS_OPEN`   | `ALWAYS_OPEN` is **only valid with `MARKET_DATA_SOURCE=SIM`**: it makes the simulated stocks' exchanges report `OPEN` at every instant (note "Simulated 24/7 session") and drops the overnight gap. It never applies to fixture or real data. Crypto is always 24/7 |
| `DEMO_MODE`          | `true`, `false` (default)         | **required `true` in staging and production when the source is `SIM`** (startup refuses otherwise). With it the web banner and footer say it is a demo with virtual money                                                                                           |
| `SIM_SEED`           | 1 to 64 characters `A-Za-z0-9._-` | the prices are a pure function of this seed and the time                                                                                                                                                                                                            |
| `SIM_TICK_MS`        | 200 to 60000 (default 1000)       | how often the runner publishes                                                                                                                                                                                                                                      |

How to run each mode:

```powershell
# local, fixture (the default; slow 30 s refresh)
MARKET_DATA_SOURCE=FIXTURE

# local, simulated stocks and crypto, around the clock (a demo that works on weekends and at night)
MARKET_DATA_SOURCE=SIM  CRYPTO_FEED=sim  SIM_SESSION=ALWAYS_OPEN  DEMO_MODE=true

# staging or production demo
APP_ENV=staging  MARKET_DATA_SOURCE=SIM  CRYPTO_FEED=sim  DEMO_MODE=true  (TRUSTED_PROXY_CIDRS and the other staging settings as usual)
```

### The price model (D-78)

`packages/market-model/src/sim.ts` is **pure**: the price of a symbol at a given second is a function of `(seed, symbol, time)` only, so a restart, another machine or a test always agrees, without the feed having to run continuously. No clock, no randomness, no IO and no floating point: only integer arithmetic (a 32-bit hash, safe integers, BigInt for the exponential). The lint rules for time-handling pure code enforce that.

- **Path.** The log-price offset is a sum of 23 "value noise" octaves with knots every 1, 2, 4 ... 2^22 seconds (about 48 days); each knot is a hash of (seed, symbol, octave, knot index) and is interpolated linearly. Octave amplitudes grow with the square root of the knot spacing, so the wandering scales like a random walk, but is bounded over weeks. `price = base x exp(offset)`, rounded to the tick.
- **Volatility** is a per-symbol daily figure in basis points, a **scale parameter** (illustration), not a calibrated market estimate. Observed: about 0.003 to 0.02 percent per second and a few percent per day (see the tests).
- **Spread** is 1 to 3 ticks: the symbol's usual spread, one tick wider on about one second in four. Bid is below ask, both are tick multiples, `last` is the mid.
- **Gaps (NYSE session only).** On about one day in three a small overnight jump (at most `gapBps` either way, 30 or 60 bp) happens at 14:30 UTC (the NYSE open in winter; not DST-aware on purpose). No gap in `ALWAYS_OPEN` mode and none for crypto.
- **Universe** (`sim-universe.ts`, versioned, "as of" 2026-11-14, the base prices are **illustrative round numbers, not market data**): AAPL, MSFT, NVDA, TSLA, AMZN, GOOGL, META, SPY, QQQ, VOO, JPM, KO; and BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD, BNB-USD (tick 0.01, 0.01, 0.01, 0.0001, 0.00001, 0.01; the usual ticks, illustrative).
- **Runner.** `SimProvider` (`apps/api/src/modules/market-data/sim/`) is an ordinary `MarketDataProvider`. The existing refresher publishes its snapshot every `SIM_TICK_MS` (not in `APP_ENV=test`, where a test calls `refresh()` with its own clock) through the **existing ingest and validator** (a second validation path is deliberately not built). The clock is injected. Crypto uses the 3-second real-time freshness window, stocks 5 seconds.
- **Validation.** Over a simulated 24 hours (one quote per second, six symbols, through `validateQuote`) nothing is rejected, warned about or held as an outlier (a unit test; a control proves the validator does reject a crossed quote and a 12 percent jump).

### Crypto: display-only in M7a, tradable since M8

Migration 0024 added the exchange `CRYPTO` (always open) and six crypto instruments with an empty `tradable_in` (display-only in M7a: every order was rejected with `INSTRUMENT_NOT_TRADABLE`). `qty_step` and `min_qty` are `0.00000001` (8 decimal places) and `fractional_ok` is true. Migration 0025 added a version 1 fee schedule for `CRYPTO` (a placeholder). **Since M8** (migration 0027, D-88 and D-89) the seeded crypto instruments carry the `MVP` gate in `tradable_in`, so market orders with fractional quantities are accepted (the instrument API reports `tradable: true`), and the new immutable fee schedule version 2 applies: 10 bps commission, 5 bps slippage, a 2% price collar. Trading rules and the exact cost basis: [trading.md](trading.md). The prices stay simulated and labelled `SIM`.

## Candles, prior close and day change (M7b: D-79 to D-82)

Candles are **computed on demand** from the pure SIM price function (D-79): no table, no stored ticks. Everything is deterministic for `(seed, symbol, interval, time range)`, labelled `source: "SIM"` and `synthetic: true`, and never presented as market data. The pure model is `packages/market-model/src/candles.ts` (no clock, no randomness, no IO, no floats); the API serves it behind a `CandleProvider` interface.

### The model (D-80)

- **Intervals:** `1m`, `5m`, `15m`, `1h`, `4h`, `1d`. A candle covers [t, t + interval) in UTC, aligned to the interval (`t` is epoch-aligned: 14:00Z is an hour, 12:00Z a 4h candle). The `1d` candle is aligned to the **UTC day** for crypto and the simulated 24/7 stock session, and is the **whole regular session** for stocks on the real calendar (`t` = the session open).
- **Prices.** Let _s_ and _e_ be the first and last instants of the candle (after clipping to a session): _e_ = _t_ + interval, or the session close. `open` = P(_s_) and `close` = P(_e_), where P is the SIM price of that second. The close of one candle is therefore **exactly** the open of the next (the next candle's first instant is _e_): `open(n+1) = close(n)`, with no rounding anywhere (prices are integer numbers of ticks). Between two sessions there is a gap by design.
- **High and low** are the max and min of P over the **sample grid**: the instants _s_, _e_ and every multiple of the grid step strictly between them. Grid step: **60 s** for intervals up to `1h`, **300 s** for `4h` and `1d`.
- **Volume** is **synthetic**: per minute, an hourly level (60 to 140 percent of the symbol's base, from a hash of seed, symbol and hour) plus a small periodic ripple; the volume of any range of whole minutes is the exact sum, computed in O(hours). Integer shares for stocks, 8 decimal places for crypto. It is a pure function of seed, symbol and time and says so (`synthetic: true`).
- **Forming candle:** the candle that contains `now` (the injected clock) is included with `closed: false`; its close is P(now), its high, low and volume cover the grid instants and whole minutes up to now. Every earlier candle is `closed: true` and **immutable**: it depends on nothing but its own inputs, so the same request at any later `now` returns the same bytes (tested, and the API serves such answers with an ETag).
- **History:** none before **2026-01-01T00:00:00Z** (`SIM_HISTORY_START_SECONDS`, the start of the calendar data). No candle starts before it and no prior close is defined for a time before it (null, never 0).

### Invariants (all tested)

| Invariant                                                                                                                                      | Guarantee                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `low <= min(open, close) <= max(open, close) <= high`, prices positive tick multiples                                                          | always                                                                                                                                                                                                                                                                                              |
| contiguity: `open(n+1) = close(n)` for consecutive candles of the same interval (not across a session gap, and not for the session-sized `1d`) | always                                                                                                                                                                                                                                                                                              |
| aggregation 1m to 5m to 15m to 1h: open and close of the first and last smaller candle, max high, min low, **exact** volume sum                | **exact**, including candles clipped at a session edge                                                                                                                                                                                                                                              |
| 4h and 1d against the finer candles that cover them                                                                                            | open, close and volume **exact**; `high <=` the finer high and `low >=` the finer low (the 300 s grid is a subset of the 60 s grid: a coarse candle can miss an extreme between two grid points, never invent one). A test shows it is sometimes strictly narrower, so the weaker statement is real |
| determinism: same inputs, same output, any order of requests; a different seed gives different candles                                         | always                                                                                                                                                                                                                                                                                              |

### Sessions (D-81)

Crypto and the simulated 24/7 stock session (`SIM_SESSION=ALWAYS_OPEN`) are continuous. With `SIM_SESSION=NYSE` stocks have candles only inside regular sessions of their exchange calendar: none on weekends or holidays, early closes respected (2026-11-27 closes at 18:00Z), daylight saving handled by the calendar (open 14:30Z in winter, 13:30Z in summer; tested on Friday 2026-03-06 against Monday 2026-03-09 and on 2026-10-30 against 2026-11-02). A candle that straddles a session edge is **clipped**: it keeps its aligned open time `t` (a 1h candle at 14:00Z), but its prices are read at the clipped first and last instants (14:30Z). Candles are **selected by their reported open time** `t` within `from` and `to` (inclusive), and only if they have begun by `now`.

### Prior close and day change (D-82)

One server function (`QuoteService.changeFor`) serves `/v1/quotes` and the order preview, so they cannot disagree. `change = last - prevClose` and `changePct = change / prevClose x 100`, exact decimals with `@vantage/money`, rounded **once** to 2 decimal places HALF_EVEN (a change of 0.005 percent shows as 0.00, 0.015 as 0.02). `last` falls back to the mid of bid and ask only when there is no last, and `changeOf` says which was used.

| Instrument                                                                                                                                                    | `prevClose`                                                                                                                                                                                                       | `changeBasis`        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| stock, `SIM_SESSION=NYSE`                                                                                                                                     | the **close of the previous regular session**: the session before the latest one that has opened at `now` (on a weekend the latest is Friday, so the reference is Thursday's close; across a holiday it skips it) | `PREV_SESSION_CLOSE` |
| crypto, and stock with `ALWAYS_OPEN`                                                                                                                          | the price **24 hours ago** on the 60 s grid (`floor((now - 24 h) / 60 s) x 60 s`)                                                                                                                                 | `ROLLING_24H`        |
| anything without a candle source (the fixture feed), or no history that far back (before 2026-01-01, the first NYSE session of 2026), or an UNAVAILABLE quote | every field **null** (absent on an UNAVAILABLE quote): never 0                                                                                                                                                    | null                 |

### Cost bound and measurements

A request makes at most `limit x (interval / grid + 1)` price evaluations (shared boundary instants are evaluated once, so the real count for a continuous market is `limit x interval / grid + 1`). Per interval for 500 candles (24/7 market, all closed): 1m 501 (bound 1,000), 5m 2,501 (3,000), 15m 7,501 (8,000), 1h 30,001 (30,500), 4h 24,001 (24,500), **1d 144,001 (144,500)**. Measured on the development machine (Windows, Node 22.19, one process): cold 7 ms, 16 ms, 41 ms, 153 ms, 126 ms and **791 ms** respectively; the same answer from the cache about 2 ms. The protections (the cost is bounded by construction): a bounded in-memory cache of immutable answers (at most 60,000 candles), a per-user allowance in **cost points** (`CANDLES_RATE_LIMIT_PER_MINUTE`, default 120; a request costs `ceil(bound / 20,000)`: 1 for 1m, 5m and 15m, 2 for 1h and 4h, 8 for a maximum daily request), and the existing session requirement. 100 parallel identical maximum daily requests took 1.1 s in total (one computation, 99 cache hits); 24 distinct cold maximum daily requests took p50 819 ms, p95 944 ms, max 1,010 ms each. A cold maximum daily request blocks the event loop for most of a second: with the allowance above one user can still cost the process several seconds of work per minute, which is acceptable for a demo and would need a worker thread or a shared cache before a public launch.

### How a real provider plugs in

`CandleProvider` (`apps/api/src/modules/market-data/candles/candle.provider.ts`) has four members: `supports(instrument)`, `getCandles({ instrument, interval, from, to, limit, now })`, `referencePrice(instrument, now)` and `priceAt(instrument, instant)`. `SimCandleProvider` is the only implementation. A vendor adapter implements the same interface (and may then need a stored candle table, which is not built: stored candle tables are out of scope), returns its own `source` label and `synthetic: false`, and is chosen in the provider factory; the endpoint, the contracts, the quote fields and the equity-curve catch-up do not change.

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
