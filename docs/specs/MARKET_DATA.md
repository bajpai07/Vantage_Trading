# VANTAGE — MARKET_DATA.md

Version 2.0 · Provider strategy, licensing, normalisation, fallback. **All vendor facts below are from general knowledge and must be verified in writing with each vendor before launch (see §3 questionnaire). Nothing here is a licence.**

## 1. Principles

1. Licensing comes before integration. A technically working feed we are not licensed to show to users is a launch blocker, not a detail.
2. Never fabricate prices. Production and staging refuse to start with a `FIXTURE` source enabled (config guard + startup assertion + CI test).
3. Every quote carries: `source`, `provider_ts`, `received_at`, `entitlement` (REAL_TIME | DELAYED + delay seconds), and a computed `freshness`.
4. Never label delayed data real-time. The entitlement comes from the vendor contract/feed definition, stored per provider-feed in config, not guessed from timestamps.
5. Providers are replaceable behind one interface; the core app never imports a vendor SDK.
6. Fallback never mixes sources silently: the quote shows its source; switching sources inside one order's lifetime is logged.

## 2. Provider strategy by market group

### 2.1 US equities and ETFs (MVP)

| Option | What it gives | Concerns to verify |
|---|---|---|
| Alpaca Market Data | Free tier is IEX-only real-time (one exchange, not consolidated tape); paid plans give SIP (consolidated). History, WebSocket | Whether showing the data inside a third-party app to end users is permitted on the plan, and attribution rules. Alpaca's terms are written around its own brokerage customers; a separate data-redistribution arrangement may be required |
| Massive (ex-Polygon) | Consolidated tape, delayed tiers, deep history, WebSocket, snapshots | Redistribution/"display to end users" plan tiers; professional vs non-professional status and exchange fees |
| Finnhub / Twelve Data | Cheap broad coverage, delayed or limited real-time | Free tiers are usually for personal use; real-time US data to third parties usually needs a commercial plan. VERIFY |
| IEX Cloud-like direct feeds | Not recommended: product availability has shifted historically | |

**Recommendation (D-05):**
- **Launch default = DELAYED (typically 15 min) consolidated US data under a commercial display licence**, labelled DELAYED everywhere. It is cheaper, avoids per-user exchange fees, and is legally simplest. REAL_TIME US data is a P2/P3 upgrade once revenue justifies it.
- Primary vendor: Massive or an equivalent commercial plan, chosen **after** vendor Q&A (§3). Alpaca remains a technical fallback and development source (sandbox/dev use, not user-facing until its redistribution terms are confirmed).
- Exchange agreements: US exchanges (NYSE/Nasdaq via UTP/CTA) charge display fees depending on user type (professional/non-professional) and whether data is real-time. Delayed display (≥ 15 min) is generally exempt from real-time fees, but the vendor decides how that is exposed. VERIFY.

### 2.2 Cryptocurrency (MVP)

| Option | Notes |
|---|---|
| Coinbase Exchange / Advanced Trade public market data | USD-quoted pairs, public WebSocket feeds, history. Terms of use for displaying data in third-party products must be read. VERIFY |
| Kraken public API | USD pairs, WebSocket. Terms and rate limits to verify |
| Binance public streams | Deep liquidity, but largely USDT-quoted, and availability/terms vary by jurisdiction (restrictions for US and some regions). Not recommended as the only source |
| Aggregators (CoinGecko, CoinMarketCap, CryptoCompare/CCData) | Licensed commercial APIs with clear redistribution terms; typically delayed or aggregated prices, fewer microstructure details |

**Recommendation (D-06):** primary = one exchange feed with USD pairs and clear display terms (Coinbase or Kraken, confirmed in writing); fallback = a commercial aggregator. Crypto has no exchange-licence tier problem but **venue terms and regional access still apply**, and India-based users and entity location matter. Quote currency is USD, so no stablecoin FX assumption is needed in MVP.

### 2.3 India: NSE/BSE (P2 delayed, P3 real-time)

Facts: NSE and BSE license market data through the exchanges and authorised data vendors. Redistribution to end users requires a vendor licence and normally exchange agreements; real-time display carries fees; delayed data (commonly 15 min, vendor-defined) is cheaper. Broker APIs (Kite Connect, Upstox, Angel One SmartAPI, etc.) license data for the **account holder's own use** and generally prohibit redistribution to other users.

| Option | Use | Verdict |
|---|---|---|
| Authorised data vendors (e.g. Global Datafeeds, TrueData, Accelpix, Truedata-class vendors; Twelve Data / Finnhub for delayed) | Commercial redistribution possible under agreement | **Preferred path.** Request: delayed display licence for retail non-professional users, redistribution terms, fee schedule |
| NSE/BSE direct (data product/vendor-empanelment) | Highest cost and compliance overhead | P3 only |
| Broker APIs | Personal prototyping only | **Never user-facing** |
| Unofficial scrapers (Yahoo/Google/NSE site scraping) | Prohibited | **Forbidden** in staging/production |

**Recommendation (D-07):** P2 launches with a licensed **delayed** vendor feed. P3 moves to licensed real-time after (a) a vendor agreement, (b) exchange compliance steps the vendor requires (user classification, terms, audits), (c) price per user estimated against revenue. Until the licence is signed in writing, NSE/BSE instruments are not enabled (`tradable_in` does not include `P2`).

### 2.4 FX (for INR conversion)

Need USDINR with bid, ask, timestamp, source. Candidates: the same vendor as NSE/BSE data, a commercial FX data API, central-bank reference rates (RBI reference rate is daily and not tradable). **Recommendation:** vendor bid/ask where licensed; otherwise mid ± a configured spread (`fx_spread_bps`, disclosed) with the **source labelled "reference mid + modelled spread"**. This is a model, not a fabricated price, and is stated as such. FX data must be fresh to the same freshness rules; stale FX ⇒ `FX_UNAVAILABLE` rejection of INR orders.

### 2.5 Indices, movers and reference quotes (MVP-lite)

- **Index levels** (S&P 500, Nasdaq-100, Dow; later Nifty 50, Sensex) are separately licensed by index providers; many vendors expose them only as ETF proxies (SPY, QQQ, DIA) or as paid index products. **MVP decision (ASSUMPTION):** the Markets page shows ETF proxies (SPY/QQQ/DIA/IWM) **labelled as ETFs, not as index levels**, until an index licence is confirmed. Never present an ETF price as the index value.
- **Movers / most active** need a market-wide snapshot. MVP scope: a fixed universe (US large-cap list of about 500 symbols + top-30 crypto) refreshed via the vendor's bulk snapshot endpoint every 60 s (delayed data) and computed from stored quotes only. This is a REST budget item, not a WebSocket subscription. If the vendor plan lacks bulk snapshots, shrink the universe to a curated ~100 and say so in the UI.
- Sector performance and heatmaps depend on a sector classification licence; P2.

## 3. Vendor questionnaire (send before signing anything)

1. Does the plan permit displaying data to end users of a third-party web app (non-professional retail users)? In which countries?
2. Is redistribution/derived display (charts, candles, indicators, leaderboards using prices) permitted? Is storing history permitted, and for how long?
3. Exact entitlement and delay (e.g. 15 min), per exchange. Which exchanges/MICs are included?
4. Professional vs non-professional user definitions; who is responsible for classification; per-user fees?
5. Attribution/disclaimer requirements; trademark rules.
6. Rate limits, WebSocket symbol caps, concurrent connection caps, SLA, support tiers.
7. Audit rights and usage reporting obligations (exchange audits).
8. Is the use "simulated trading, no real execution" restricted or does it need a different licence?
9. Price at 100, 1,000 and 10,000 monthly users; contract term; termination terms; data retention after termination.
10. Corporate actions, instrument master and calendar data included?
Store answers (and the contract) in the repo's `/legal/data-licences/` as the authority for the `provider_feeds` config.

## 4. Provider abstraction

```
interface MarketDataProvider {
  id: string
  capabilities(): { assetClasses, entitlement, maxSymbols, supportsWs, supportsHistory }
  searchInstruments(q): Instrument[]            // or loadInstrumentMaster()
  getSnapshot(symbols): RawQuote[]
  getCandles(symbol, timeframe, from, to): RawCandle[]
  subscribe(symbols, onQuote, onStatus): Subscription
  health(): ProviderHealth
}
```

Per-feed config (`provider_feeds`, versioned, admin-audited):

| Field | Example |
|---|---|
| feed_id | `massive-us-delayed` |
| provider, asset_classes, exchanges | massive, [EQUITY, ETF], [XNAS, XNYS, ARCX] |
| entitlement, delay_seconds | DELAYED, 900 |
| licence_ref | `legal/data-licences/massive-2026-xx.pdf` |
| display_allowed, redistribution_allowed | true, true |
| priority, enabled | 1, true |
| stale_after_s, max_symbols | 60, 100 |

The adapter layer maps provider payloads to internal `Quote`/`Candle`, applying exchange-timestamp normalisation to UTC. Instrument master is loaded nightly from the provider (or a reference vendor) and reconciled into `instruments` (never edited by quotes).

## 5. Pipeline

```
Provider WS/REST ─► adapter ─► normalise ─► validate ─► (dedupe, coalesce)
   ├─► Redis HSET q:{instrument}  +  PUBLISH q:{instrument}
   ├─► candle builder (1m in-progress in Redis; closed bars → Postgres)
   ├─► alert evaluator, execution matcher (via Redis streams / pub-sub)
   └─► health counters (lag, gaps, reject count)
```

Subscription manager: one authoritative set of symbols to subscribe = union of {symbols held in open positions or open orders, symbols on any active watchlist, symbols viewed in the last N minutes, index/benchmark set}. On-demand symbols beyond provider caps are served via REST snapshot polling at a lower rate with `DELAYED/STALE` labelling. Symbol caps and rate limits per provider are enforced centrally with a token-bucket and back-pressure.

Reconnection: exponential backoff with jitter (1 s → 30 s cap), full resubscribe, a gap-fill REST snapshot for all subscribed symbols after reconnect, and a candle backfill for the missed interval. Provider status transitions (CONNECTED, DEGRADED, DOWN) emit `market.status.changed`.

## 6. Quote validation (reject and count; never "fix" silently)

Reject when: `bid ≤ 0 or ask ≤ 0`; `bid > ask` (crossed) unless the provider flags an auction/locked state we support; `provider_ts` in the future by more than 2 s; `provider_ts` older than the last accepted quote for the symbol; price changes by more than the outlier threshold (default 10% for equities within one tick event, 15% crypto, 5% FX) from the last accepted quote **unless confirmed by a second consecutive tick** (then accepted and flagged `gap_confirmed`); price not a multiple of tick (warn only); size/volume negative.

Counters per feed: accepted, rejected-by-reason, out-of-order. Rejection rate above 1% for 5 minutes marks the feed DEGRADED and alerts.

## 7. Freshness and display

States: `REAL_TIME`, `DELAYED`, `STALE`, `CLOSED`, `UNAVAILABLE` (definitions in TRADING_ENGINE.md §3). Rules for the UI: every price shows a small badge (colour + text, never colour alone); DELAYED shows "15m"; STALE shows age ("stale 2m 10s"); CLOSED shows "last close"; the order ticket disables submit for STALE/UNAVAILABLE and explains why.

The server computes freshness on read and on publish, using one function shared by REST, WebSocket and the engine (single source of truth).

## 8. Calendars and sessions

`exchanges.calendar` stores regular sessions and holidays per MIC. Sources: provider calendar endpoint where licensed, plus a maintained open-source holiday library cross-checked yearly. Early closes and special sessions are explicit entries. Daylight-saving transitions are handled by IANA timezones, never fixed offsets. Crypto is always open. Market status transitions publish `market.status.changed`.

## 9. History, candles and corporate actions

- Ingest 1m from the provider for held/watched symbols; build 5m/15m/1h from 1m; ingest 1d separately (more reliable for long history).
- Stored with `source` and `adjusted`. Charts request adjusted by default; the executions always use unadjusted live quotes.
- Splits/dividends from the provider's corporate-actions feed; applied by the corporate-action job (TRADING_ENGINE.md §10).
- Gaps (halts, outages) are left as gaps; the chart shows breaks, not interpolated bars.
- Retention: see DATABASE.md §10.

## 10. Fallback architecture

Per instrument class, an ordered list of feeds by priority:

1. Primary feed healthy → use it.
2. Primary DEGRADED/DOWN, secondary licensed for the same class and entitlement → switch; quote `source` changes and an `order_events` note is added if an open order is evaluated against the new source.
3. No licensed fallback → quote ages into STALE; execution blocked; UI shows the last valid quote with the stale badge. **We never fill from an unlicensed or unlabelled source and never interpolate.**
4. A fallback with a *different entitlement* (e.g. primary REAL_TIME, fallback DELAYED) is allowed only for display with the lower label; execution continues only if the asset class allows delayed execution (`allow_execution_on_delayed`).

Kill switches (admin, audited): disable a feed, disable trading per asset class, force STALE.

## 11. Provider health monitoring

Metrics: connection state, last message age, messages/s, reject rate, REST error rate and 429 count, reconnects per hour, clock skew (provider_ts vs receive time), symbol cap usage. Alerts: no message for > 30 s in market hours (equity) or > 10 s (crypto); reject rate > 1%; 429 spike; clock skew > 5 s. Admin console page per feed shows these plus last 100 events.

## 12. Rate limits and cost control

Centralised limiter per provider (token bucket with burst); batching of snapshot requests; caching of search results (1 h) and instrument master; WebSocket subscription budget allocated by priority (positions/open orders > watchlists > viewed). Daily budget dashboard: calls, symbols subscribed, estimated cost.

## 13. Acceptance criteria

| # | Criterion | Measure |
|---|---|---|
| 1 | No unlicensed feed enabled for users | Config test: every enabled feed has a `licence_ref` and `display_allowed=true`; CI fails otherwise |
| 2 | Entitlement labelling correct | Table-driven test: all five freshness states; contract test per adapter on entitlement mapping |
| 3 | Validation | Fuzz test with 100k malformed/crossed/outlier quotes: 0 accepted, all counted by reason |
| 4 | Reconnect | Kill the WS 100 times in a soak: recovery < 10 s p95, no duplicate or out-of-order publishes |
| 5 | Fallback | Disable primary in staging: switch ≤ 15 s, quotes labelled with the new source; with no fallback: STALE within threshold and orders blocked |
| 6 | Candle integrity | Candle OHLC constraint holds; 1m→1h aggregation equals provider 1h within tolerance on 20 symbols × 5 days |
| 7 | Throughput | 500 symbols at 5 updates/s ingest with CPU < 60% on 2 vCPU; tick→client p95 < 500 ms |
| 8 | No fabricated data | Startup refuses to run with `FIXTURE`; grep-based CI check for hard-coded price tables outside `/test` |
| 9 | Calendars | DST and holiday test cases for XNYS, XNSE, crypto produce correct session open/close |
