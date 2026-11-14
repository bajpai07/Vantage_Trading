# Portfolio, P&L and history (M5, read side)

What a user owns and how they are doing: cash, positions valued at current marks (always labelled), unrealised and realised P&L, equity, order and execution history, ledger activity, and a daily equity snapshot for a future equity curve. **Read only: no trading logic changed, and the only table written is `equity_snapshots`.** Endpoints and examples: [api.md](api.md). Decisions D-60 to D-63: specs/DECISIONS.md. The pure formulas live in `@vantage/engine` (`valuePosition`, `summarisePortfolio`, `capitalIdentity`, `roundDisplay`); no float, clock or IO.

## Honesty rules (non-negotiable)

1. **Never show a number as real time if its quote is not.** Every valued position carries its quote's `freshness` (`REAL_TIME`, `DELAYED`, `STALE`, `CLOSED`) from the shared market-model `freshness()` function, its provider timestamp (`quote.asOf`) and its `source`. A STALE quote is valued but labelled `STALE`; a closed market uses the last bid labelled `CLOSED`.
2. **No usable quote means no valuation.** The position is `valuation: UNAVAILABLE` (`NO_QUOTE`: no accepted quote or freshness UNAVAILABLE; `NO_USABLE_PRICE`: the quote has no positive bid or last), its `mark`, `marketValue` and `unrealisedPnl` are `null`, and it is **excluded from the totals with an explicit flag**: `incomplete: true`, `unvaluedCount`, and `totalReturn: null`. It is never valued at zero and never silently at cost. Its cost stays in the total `costBasis` so the books still reconcile.
3. **Stored marks only for history.** A snapshot never uses a price from another day (see the snapshot job).
4. **Rounding only at the edge.** Everything is computed in exact decimals (8 dp internally, market value rounded once HALF_EVEN); the API rounds money to 2 dp HALF_EVEN as strings and ships the full-precision value beside it in `exact`. Prices are never rounded.
5. Day change is **not reported** (it needs prior-close data, M3b); nothing fakes it.

## Definitions (D-60, D-61; USD)

| Quantity      | Definition                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mark          | **The bid** for a long position (what you could sell at); the last price only when there is no positive bid, labelled `markBasis: LAST`; never the ask |
| marketValue   | `qty x mark` (valued positions only)                                                                                                                   |
| costBasis     | `sum over open lots of qty_open x cost` (fees are not part of cost)                                                                                    |
| unrealisedPnl | `marketValue - costBasis` (valued positions only)                                                                                                      |
| realisedPnl   | `-(REALIZED_PNL ledger balance)`, which equals the sum of the lot closures' `trading_pnl_usd` (gross of fees)                                          |
| fees          | the `FEES` ledger balance                                                                                                                              |
| equity        | `cash + sum of marketValue` over the **valued** positions                                                                                              |
| totalReturn   | `equity - initialCapital`, **only when every position is valued**, otherwise `null`                                                                    |
| asOf          | the oldest quote timestamp used for a valuation (`null` when nothing was valued)                                                                       |

Reservations do not exist yet (market orders only), so `RESERVED` is 0 and is not part of equity here; when limit orders arrive, equity will add it as TRADING_ENGINE section 3 defines.

## Identity checks

Every read satisfies, with exact decimals (this is invariant I10 restated for the read side):

```
cash + costBasis + fees - realisedPnl = initialCapital        (10,000 for every account today)
equity = cash + positionsValue          positionsValue = sum of the valued positions' marketValue
costBasis (total) = sum of the positions' costBasis = POSITION_COST ledger balance = sum of qty_open x cost over the lots
realisedPnl = sum of lot-closure trading P&L = sum of the SELL executions' realisedPnl
```

They are tested after random order sequences against the independent M4a BigInt reference model, and 100 times in a row while 60 orders are placed in parallel (100 of 100 held).

## One consistent read (D-63)

`GET /v1/portfolio` reads cash, the FEES and REALIZED_PNL balances, the positions and the lot cost bases inside **one `REPEATABLE READ`, read-only transaction** (a test observes the `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY ... COMMIT` and that only SELECTs run inside), so a concurrent order can never make cash and lots disagree inside one response. Marks are read after the snapshot from the in-memory quote store with the injected clock; a quote can only be as old or newer than the books, and it is always labelled with its own timestamp. The query count is constant in the number of positions (no per-position query): 1 session lookup, `BEGIN`, 2 reads, `COMMIT`.

## Equity snapshots (D-62)

Table `equity_snapshots(account_id, snapshot_date, cash, positions_value, equity, valued_complete, quote_asof, created_at)`: primary key `(account_id, snapshot_date)`, `CHECK equity = cash + positions_value`, append-only (row triggers for UPDATE and DELETE, a statement trigger for TRUNCATE, and the app role has only `SELECT, INSERT`). `valued_complete = false` means at least one position had no mark that day; `positions_value` and `equity` then exclude it, exactly as the portfolio does. `GET /v1/portfolio/history` returns at most 366 rows.

The job (`SnapshotService.runDue(now)`, driven by `SnapshotScheduler`, one tick a minute inside the API process; it does not start when `APP_ENV=test`, tests call `runDue` with their own clock):

- **When:** a snapshot is due for each NYSE (`XNYS`) trading session whose close is not after `now`. Sessions come from the M3a calendar (`sessionsBetween`), including early closes (Fri 2026-11-27 closes 13:00 New York = 18:00Z) and skipping holidays and weekends; outside the calendar's coverage there is no session (never guessed).
- **Which accounts:** active accounts of active users, and only for days on or after the account existed at the close.
- **What is stored (stored data only):** cash and quantities are rebuilt from the account's stored `executions` up to the close (cash = initial capital + sells - buys - fees). A mark counts only if it is a **stored quote of that trading day**: its provider timestamp is on that exchange-local date and not after the close. Anything else is "no mark" and the day is `valued_complete = false`. **A later quote is never used for an earlier day**, and a day with no open positions is complete (equity = cash).
- **Idempotent:** the insert is `ON CONFLICT DO NOTHING`; running twice, or two runs at once, adds nothing.
- **After downtime:** each missed session after the account's last snapshot is written (at most 366 per account per run); an account with no snapshot yet gets only the latest closed session (history before the first run is not invented).
- **Limitation (important):** the quote store keeps only the last accepted quote per symbol, in memory. So a mark for a day exists only if the job runs while that day's last quote is still the stored one; after downtime, earlier days are honestly incomplete. A quote that arrives after the close and replaces the last one (a real-time after-hours tick) makes that day incomplete too. Persisting daily closes (daily candles, M3b) will fix both. **M7b fixes it for the simulated source** (see "Equity-curve catch-up from SIM candles" below).

## Equity-curve catch-up from SIM candles (M7b, D-83)

With `MARKET_DATA_SOURCE=SIM` the "stored marks" limitation above no longer applies. A snapshot of a past day is valued from the **simulated candle price at that session's close** (`CandleProvider.priceAt`: the pure price function at the close instant: 21:00Z, 20:00Z in summer time, 18:00Z on an early close), marked as LAST. That price belongs to that date and instant, so it can never be a later price, and the day is **complete** (`valued_complete = true`) even after downtime. The snapshot records where its marks came from: `quote_asof` is the close instant and the new column `equity_snapshots.mark_source` (migration 0026; NULL for older rows) is `SIM_CANDLE` when every valued position was marked from a candle, else NULL; `GET /v1/portfolio/history` exposes it as `markSource`.

- **Other sources keep the M5 rule.** With the fixture feed, or when the candle source cannot price an instrument (the crypto feed is off), a day without a stored quote of that date is `valued_complete = false` and the position is excluded, exactly as before.
- **The snapshot day is still the NYSE trading day (D-62).** Weekends and holidays have no snapshot, for stocks and for crypto alike; a crypto position is valued at the price at the NYSE session close instant of each trading day (so a crypto-only account around a weekend has a Friday and a Monday snapshot, each at its own close, and none for Saturday or Sunday). Crypto cannot be traded until M8; the tests open one instrument for the purpose.
- A run after five missed sessions (a holiday and an early close among them) writes five complete snapshots, one per session; running again writes nothing.

## What M6 can use

See the endpoint list in the M5 report; every read is documented in [api.md](api.md).
