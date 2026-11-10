# VANTAGE — TRADING_ENGINE.md

Version 2.0 · Execution model `QBX-1` (quote-based execution, v1). Applies to MVP (US equities, ETFs, crypto) and P2 (NSE/BSE).

## 1. Principles

1. The engine is a **pure TypeScript package** (`packages/engine`) with no framework, DB or network imports. Inputs: order, account state, quote, FX rate, fee schedule. Outputs: decisions and ledger postings. The NestJS layer loads state, calls the engine, and persists the result in one DB transaction.
2. **Deterministic.** Same inputs give the same outputs. No randomness, no wall-clock reads inside the engine (time is an input).
3. **Server-side only.** The client sends intent (instrument, side, type, qty, prices). It never sends balances, prices for market orders, fees or FX rates.
4. **Honest about the model.** QBX-1 fills against the best bid/ask we have; it has no order book, no queue position and no market impact beyond a slippage formula. The UI shows this on every fill.
5. Decimal arithmetic only (`decimal.js`, precision 40, rounding HALF_EVEN unless stated). Database `NUMERIC`. No JS `number` for money.

## 2. Instrument and session rules per asset class

| | US equity / ETF | Crypto (USD pairs) | India equity (P2) |
|---|---|---|---|
| Quote currency | USD | USD | INR |
| Session | Regular 09:30–16:00 America/New_York, exchange holiday calendar. Extended hours **not** supported in MVP (ASSUMPTION) | 24/7 | NSE/BSE 09:15–15:30 Asia/Kolkata, holiday calendar |
| Fractional qty | Off in MVP (whole shares). On later by flag | Yes, step per instrument | Off (whole shares) |
| Tick size | From instrument master (default 0.01) | From instrument master | 0.05 |
| Long only / cash | Yes | Yes | Yes |
| DAY expiry | Session close | 00:00 UTC (daily) | Session close |
| Stop trigger price | last (fallback: mid) | last | last (fallback: mid) |
| Fee default | $0 commission | 10 bps of notional | configurable (default 0; statutory charges not modelled, disclosed) |
| Base slippage | 2 bps | 5 bps | 3 bps |

Short selling, margin, leverage, options and futures are out of scope until separately specified.

## 3. Quote eligibility

An order may be evaluated only against a quote `q` that is **eligible**:

- passed validation (MARKET_DATA.md §6);
- `freshness(q)` is `REAL_TIME` or `DELAYED`;
- instrument status `ACTIVE` (or `SELL_ONLY` for sells);
- market session open (crypto always).

Freshness thresholds (age = now − provider timestamp, adjusted for declared delay):

| State | Definition |
|---|---|
| REAL_TIME | Entitlement REAL_TIME and age ≤ threshold (equity 5 s, crypto 3 s) |
| DELAYED | Entitlement DELAYED (provider-declared delay d, e.g. 900 s) and age − d ≤ threshold(60 s) |
| STALE | Age beyond the threshold in either entitlement |
| CLOSED | Market closed per calendar (quote is last close) |
| UNAVAILABLE | No valid quote ever received, or provider disabled by kill switch |

**Delayed data and execution (decision D-09).** If an instrument's only licensed feed is delayed, the engine executes against the delayed quote ("what you see is what you fill"). This is allowed per asset class by config flag `allow_execution_on_delayed` (default true in MVP). Every execution stores `quote_entitlement`. The ticket and fill record show "Simulated against 15-min delayed data". Competitions require every participant to trade the same entitlement tier or are restricted to REAL_TIME or crypto-only (PRD §5.11).

`STALE`, `CLOSED`, `UNAVAILABLE` block new market orders and trigger evaluation. Resting limit/stop orders stay open but are **not evaluated** against stale quotes. When a quote returns from STALE, orders are evaluated against the **new** quote only (no back-filling at old prices).

## 4. Order types and execution rules

Let `bid`, `ask`, `last` be from the eligible quote; `tick` the instrument tick.

**Slippage (adverse, deterministic):**
`slip_bps = base_bps + size_coef * (order_notional_usd / adv_notional_usd) * 10000`, capped at `slip_cap_bps` (config). `adv_notional_usd` is the 20-day average daily notional from daily candles; if unknown, `size_coef` term is 0 and the base applies. Buys: `price = ask * (1 + slip_bps/10000)` rounded **up** to tick. Sells: `price = bid * (1 - slip_bps/10000)` rounded **down** to tick.

| Type | Becomes eligible | Fill price |
|---|---|---|
| MARKET buy/sell | immediately on accept (if quote eligible, else REJECT `NO_ELIGIBLE_QUOTE`) | slippage-adjusted ask/bid |
| LIMIT buy | when `ask ≤ limit` | `min(limit, slippage-adjusted ask)`. Never worse than limit |
| LIMIT sell | when `bid ≥ limit` | `max(limit, slippage-adjusted bid)` |
| STOP sell | when trigger price `≤ stop` | becomes MARKET sell; fills at slippage-adjusted bid **at trigger time** (gap-through fills at the gap price, not the stop) |
| STOP buy | when trigger price `≥ stop` | becomes MARKET buy |
| STOP_LIMIT | on trigger, becomes a LIMIT with the stated limit | per LIMIT rules; may never fill |
| Marketable limit at accept | evaluated immediately | per LIMIT rules |

Time in force: **DAY** expires at session close (job + lazy check); **GTC** expires after 90 days (config) with notification; **IOC** fills now or cancels, **FOK** all-or-nothing now (since MVP has no partial fills, IOC and FOK behave the same: fill entire qty or cancel). P2 adds bracket/OCO and modify (cancel/replace with new `version`).

**Partial fills:** MVP off. QBX-2 (P2): per quote update, fillable qty = `participation_rate * displayed_size`, only when size data is licensed; otherwise stays off. Documented limitation.

**Triggering and ordering.** The execution worker evaluates open orders for an instrument on every validated quote event for that instrument, in `created_at, id` order. At most one fill per order per quote event.

## 5. Ledger model (multi-currency double entry)

Each account has ledger accounts per `(type, currency)`:

| Type | Currency | Meaning | Normal sign | Constraint |
|---|---|---|---|---|
| CAPITAL | USD | Source of virtual money | negative (credit) | none |
| CASH | USD | Free cash = buying power | positive | ≥ 0 |
| RESERVED | USD | Cash committed to open BUY orders | positive | ≥ 0 |
| POSITION_COST | USD or INR | Cost basis of open lots in the instrument's currency | positive | ≥ 0 |
| FEES | USD or INR | Fees paid | positive (expense) | none |
| REALIZED_PNL | USD or INR | Gross realised P&L in instrument currency | negative when profit (credit) | none |
| FX_CLEARING | USD and INR | Counterpart for currency conversion | either | none |
| ADJUSTMENT | any | Corporate actions, admin corrections (audited) | either | none |

**Rule:** every ledger transaction's entries sum to zero **per currency**. A USD↔INR conversion posts a USD pair and an INR pair, both via FX_CLEARING, each balanced; the FX rate id is on the legs. Entries also carry `amount_usd` (value at that transaction's rate) for reporting only; it is not used in balance checks.

**Equity** = `CASH_USD + RESERVED_USD + Σ over open lots (qty_open × mark_local ÷ fx_mid_usd_local)` where mark is the bid for long positions (conservative, shown as "mark = bid"). `FX_CLEARING`, `REALIZED_PNL`, `FEES`, `CAPITAL` are not part of equity; they exist so the books balance and for reporting.

### 5.1 Posting recipes

All amounts 8 dp. Compute once, derive the rest by subtraction so each leg is exact.

**GRANT** (once): `CASH_USD +10000`, `CAPITAL_USD −10000`. Idempotency key `grant:{accountId}`.

**ORDER_RESERVE** (BUY accepted): `CASH_USD −R`, `RESERVED_USD +R`. `R` = reserve formula §6. For SELL orders no cash moves; `positions.qty_reserved += qty`.

**ORDER_RELEASE** (cancel/expire/reject-after-accept): `RESERVED_USD −R`, `CASH_USD +R` (and `qty_reserved −= remaining` for sells).

**FILL, BUY, USD instrument** with cost `C = qty × price`, fee `f`, reserved `R` (must satisfy `C + f ≤ R`):
`RESERVED_USD −R`, `POSITION_COST_USD +C`, `FEES_USD +f`, `CASH_USD +(R − C − f)`.

**FILL, SELL, USD instrument** with proceeds `P = qty × price`, fee `f`, FIFO basis `B` (sum of consumed lots' cost):
`POSITION_COST_USD −B`, `CASH_USD +(P − f)`, `FEES_USD +f`, `REALIZED_PNL_USD −(P − B)`.

**FILL, BUY, INR instrument** with `Y = qty × price` (INR), fee `f_inr`, user pays USD at the **bid** USDINR rate `r_in` (INR per USD; the worse rate for the user), `X = (Y + f_inr) / r_in` USD total:
- USD legs: `RESERVED_USD −R`, `FX_CLEARING_USD +X`, `CASH_USD +(R − X)`
- INR legs: `FX_CLEARING_INR −(Y + f_inr)`, `POSITION_COST_INR +Y`, `FEES_INR +f_inr`
Each currency sums to zero. The lot stores `cost_local = price`, `cost_usd_per_unit = (Y/r_in)/qty` (fee is expensed, so excluded from lot cost; its USD part is `f_inr/r_in`).

**FILL, SELL, INR instrument** with proceeds `P` (INR), fee `f_inr`, basis `B_inr`, USD received at the **ask** USDINR rate `r_out` (the worse rate for the user), `U = (P − f_inr) / r_out`:
- INR legs: `POSITION_COST_INR −B_inr`, `FX_CLEARING_INR +(P − f_inr)`, `FEES_INR +f_inr`, `REALIZED_PNL_INR −(P − B_inr)`
- USD legs: `FX_CLEARING_USD −U`, `CASH_USD +U`
(INR legs sum: −B + P − f + f − P + B = 0.)

**Crypto** uses the USD recipes; the base asset quantity lives in lots, not in the ledger (DATABASE.md §4 note).

### 5.2 P&L definitions

For each lot closure, with entry rate `r_in` and exit rate `r_out` (INR per USD; USD instruments have rate 1):

- `proceeds_usd = P_lot / r_out`, `cost_usd = B_lot / r_in` (already stored on the lot)
- **Total realised (gross, USD)** = `proceeds_usd − cost_usd`
- **Trading P&L (USD)** = `(P_lot − B_lot) / r_out`: the instrument-currency result converted at the exit rate
- **FX P&L (USD)** = `B_lot / r_out − B_lot / r_in`: the effect of the currency moving on the cost basis
- Identity: `Trading + FX = Total` (tested to 1e-8)
- **Net P&L** = Total − fees (USD value of entry and exit fees)

**Unrealised P&L (USD)** = `Σ qty_open × mark_local / fx_mid − Σ qty_open × cost_usd_per_unit`. FX effect inside unrealised is reported as a separate line using current mid rate vs entry rate.

**Day P&L (USD)** = `Σ qty_held_at_prev_close × (mark_now − prev_close_mark) / fx_now` for positions held at the previous session close, plus `Σ (mark_now − fill_price) × qty / fx_now` for quantity bought today, plus realised P&L booked today. `prev_close` comes from the stored daily candle (unadjusted close) of the instrument's own exchange session; for crypto the "day" starts 00:00 UTC. FX effect on day P&L uses the previous snapshot's FX rate vs now and is shown as a separate line for INR positions.

Cost basis method: FIFO (decision D-11). Average cost is a derived display.

### 5.3 Worked examples (these become golden test vectors)

**A. US equity.** Account cash 10,000.00. Buy 10 AAPL. Quote bid 189.95, ask 190.00. Slippage 2 bps: 190.00 × 1.0002 = 190.038 → round up to 0.01 → 190.04. `C = 1,900.40`, `f = 0`. Reserve band 1%: `R = 10 × 190.00 × 1.01 = 1,919.00`.
- Reserve: `CASH −1,919.00`, `RESERVED +1,919.00` → cash 8,081.00.
- Fill: `RESERVED −1,919.00`, `POSITION_COST +1,900.40`, `FEES +0`, `CASH +18.60` → cash 8,099.60.
- Check: 10,000.00 − 1,900.40 = 8,099.60 ✓; entries sum 0 ✓.

**B. Crypto with fee.** Buy 0.05 BTC. Ask 60,000.00. Slippage 5 bps → 60,030.00. `C = 3,001.50`, fee 10 bps = `3.0015`. Reserve (2% band + est. fee): `3,000 × 1.02 = 3,060.00`; fee est. `3.06`; `R = 3,063.06`.
- Fill entries: `RESERVED −3,063.06`, `POSITION_COST +3,001.50`, `FEES +3.0015`, `CASH +58.5585`. Sum: −3,063.06 + 3,001.50 + 3.0015 + 58.5585 = 0 ✓.
- Lot: qty 0.05, cost_usd_per_unit 60,030.00.

**C. INR equity round trip with FX P&L** (P2). Buy 10 RELIANCE.XNSE: ask 2,500.00 INR, slippage 3 bps → 2,500.75 INR, `Y = 25,007.50`, fee 0. USDINR entry bid `r_in = 83.90`. `X = 25,007.50 / 83.90 = 298.06317044 USD`.
Later sell 10 at bid 2,600.00, slippage 3 bps → 2,599.22 → round down to 0.05 → 2,599.20, `P = 25,992.00`. Exit ask `r_out = 83.70`. `U = 25,992.00 / 83.70 = 310.53763441 USD`.
- Total realised = 310.53763441 − 298.06317044 = **12.47446397**
- Trading P&L = (25,992.00 − 25,007.50) / 83.70 = 984.50 / 83.70 = **11.76224…**
- FX P&L = 25,007.50 / 83.70 − 298.06317044 = 298.77538… − 298.06317… = **0.71221…**
- 11.76224 + 0.71221 ≈ 12.47445 ✓ (equality tested at 1e-8 with full precision).

## 6. Buying power, reservations and collars

- **BUY reserve** `R = ceil8( qty × ref_price × (1 + collar) × fxbuf + est_fee )`, where `ref_price` is the limit price for limit orders, else the current ask; `collar` is the max adverse move allowed between accept and fill (config: 1% equity, 2% crypto, 1.5% INR); `fxbuf` = `1 + fx_spread_buffer` for INR instruments (default 1%), else 1.
- At fill, if `C + f > R` (price/FX moved beyond the collar), the order is **rejected as PRICE_MOVED** and the reservation is released; the engine never overspends.
- Limit buys use `limit` as `ref_price`, so their reserve is exact and cannot be exceeded.
- **SELL** requires `qty ≤ positions.qty − positions.qty_reserved`.
- Buying power shown = `CASH_USD` (reservations already removed). This is exactly the DB constraint `CASH ≥ 0`.
- Reserve is released at fill (difference), cancel, expiry or reject.

## 7. Order state machine

```
NEW ─ validate ─┬─ reject ───────────────► REJECTED
                └─ accept (+reserve) ────► ACCEPTED ──fill──► FILLED
                                              │  ├─cancel_req──► CANCEL_REQUESTED ─► CANCELLED
                                              │  └─expire──────► EXPIRED
                                              └─(PARTIALLY_FILLED: QBX-2 only)
```

Rules:
- Terminal states: FILLED, CANCELLED, REJECTED, EXPIRED. No transitions out.
- Each transition is guarded: `UPDATE orders SET status=$new, version=version+1 WHERE id=$id AND version=$v AND status = ANY($allowed_from)`. Zero rows updated ⇒ lost race ⇒ the loser aborts with `ORDER_NOT_OPEN` (cancel) or skips (matcher).
- **Cancel vs fill race:** both paths lock the account row first, then the order row, then re-check status inside the lock. Whichever acquires the lock first wins; the second sees a terminal state. A fill never produces a cancelled order and vice versa (tested, §11).
- `order_events` has a contiguous `seq` per order; `account_events.seq` is contiguous per account.
- Reject codes: `MARKET_CLOSED`, `NO_ELIGIBLE_QUOTE`, `STALE_QUOTE`, `INSTRUMENT_HALTED`, `INSTRUMENT_NOT_TRADABLE`, `QTY_BELOW_MIN`, `QTY_STEP_VIOLATION`, `TICK_VIOLATION`, `INSUFFICIENT_BUYING_POWER`, `INSUFFICIENT_POSITION`, `DUPLICATE_CLIENT_ORDER_ID`, `PRICE_MOVED`, `FX_UNAVAILABLE`, `ACCOUNT_NOT_ACTIVE`, `TRADING_PAUSED` (admin kill switch).

## 8. Idempotency and duplicates

- `POST /orders`, cancel and modify require `Idempotency-Key`. Table `idempotency_keys(account_id, key, request_hash, response)`; same key + same body returns the stored response, same key + different body returns 422 `IDEMPOTENCY_MISMATCH`.
- `orders (account_id, client_order_id)` unique as a second guard; `ledger_transactions (account_id, idempotency_key)` unique; `executions (order_id, seq)` and `(ledger_tx_id)` unique. Matcher fill idempotency key: `fill:{orderId}:{seq}`.
- A fill replay (worker crash/retry) violates a unique constraint inside the transaction and is treated as success-already-done.

## 9. Rounding and precision

- Prices rounded to tick (buys up, sells down). Quantities to `qty_step`.
- Cash and ledger legs: computed at 8 dp HALF_EVEN **once per quantity**, remaining legs derived by subtraction so legs always sum to zero exactly.
- FX conversions: divide at full precision, round the result to 8 dp, store the rate id and the rounded amounts. The rounding rule name is stored in `model_version` (`QBX-1/r8he`).
- Display rounding to currency minor units happens only in the UI formatter, never in storage.

## 10. Corporate actions (v1.1)

- **Splits/reverse splits:** adjust `position_lots.qty_*` and per-unit costs by the ratio; adjust open order qty and prices; post an `ADJUSTMENT` ledger transaction with zero value effect (cost basis unchanged, so no ledger entries are needed; only an audit event). Fractional shares from reverse splits: cash-in-lieu at the first eligible price, posted as a SELL-like transaction.
- **Cash dividends:** credit `CASH` (`CASH_USD +d`, `ADJUSTMENT_USD −d`) on pay date for lots held on ex-date. Tax not modelled.
- **Delisting:** instrument → `SELL_ONLY`; positions force-closed at last valid price on a stated date, with notice.
- Candle `adjusted` flag distinguishes split-adjusted series; the chart uses adjusted bars by default.

## 11. Reconciliation and invariants

Run on every CI integration run (against a seeded DB) and **nightly in production for every account**; any violation raises an alert and sets `accounts.status='FROZEN_RECON'` (trading disabled for that account) until resolved.

| ID | Invariant |
|---|---|
| I1 | Every ledger transaction balances to zero per currency |
| I2 | `ledger_accounts.balance` = Σ its entries |
| I3 | CASH, RESERVED, POSITION_COST ≥ 0 |
| I4 | `positions.qty` = Σ `position_lots.qty_open`; `qty_reserved` = Σ remaining qty of open SELL orders |
| I5 | `orders.filled_qty` = Σ `executions.qty` for the order; never > `qty`; terminal orders have `reserved_usd = 0` |
| I6 | Each execution has exactly one ledger transaction; no `(order_id, seq)` duplicates; no execution on an order cancelled before the execution's quote time |
| I7 | `RESERVED_USD` balance = Σ `reserved_usd` of open orders |
| I8 | Equity from the ledger+lots+recorded marks equals the stored portfolio snapshot (tolerance 1e-8 USD) |
| I9 | `FX_CLEARING_USD` balance = Σ open lots' `cost_usd` (INR lots) − Σ realised total USD P&L on INR lots |
| I10 | Exactly one GRANT per MAIN account = `initial_capital`; `CAPITAL` balance = −Σ grants. Conservation per currency: the sum of all ledger-account balances of one currency is 0 (e.g. in USD: `CASH + RESERVED + POSITION_COST + FEES + FX_CLEARING + REALIZED_PNL + CAPITAL + ADJUSTMENT = 0`), which makes `CASH + RESERVED + POSITION_COST + FX_CLEARING = initial_capital + gross realised − fees + dividends` in USD |

Test layers:
- Unit: golden vectors §5.3 (A, B, C) with exact expected entries.
- Property-based (fast-check): random sequences of accept/fill/cancel/expire across USD, crypto and INR instruments with random quotes and FX; after every step assert I1–I10.
- Concurrency (real Postgres, Testcontainers): 50 parallel buys exceeding cash; 100 duplicate idempotency keys; 1,000 cancel-vs-fill races; parallel fills for the same account on different instruments (no deadlocks, no lost updates).
- Simulation: gaps through stops, stale quote return, market close mid-order, provider drop, crossed quote, FX unavailable.

## 12. Engine interfaces (contract, not code)

- `evaluateNewOrder(order, accountState, quote, fx, schedule) → {decision: ACCEPT|REJECT, reserve?, events}`
- `evaluateOpenOrder(order, quote, fx, schedule) → {decision: NONE|TRIGGER|FILL|EXPIRE, fill?}`
- `buildPostings(kind, context) → LedgerPosting[]` (pure; asserts balance before returning)
- `consumeLotsFIFO(lots, qty) → LotConsumption[]`
All return value objects; none touch IO.

## 13. Acceptance criteria (module-level)

1. All golden vectors reproduce to the stored digit.
2. Invariants I1–I10 hold after 10,000 property-test sequences (3 seeds) and after the concurrency suite.
3. Order accept p95 < 150 ms and sustained fills ≥ 200 fills/s on the reference VM (4 vCPU, 8 GB, local Postgres).
4. Matcher evaluates 5,000 open orders against one quote event in < 50 ms.
5. 0 duplicate fills over a 24 h soak with injected worker crashes/restarts every 5 minutes.
6. Every execution displays its quote (bid, ask, time, source, entitlement) and `model_version` in the UI.
