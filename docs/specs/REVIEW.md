# VANTAGE — Specification Review (v2.0)

Scope: PRD, DATABASE, ARCHITECTURE, TRADING_ENGINE, MARKET_DATA, DESIGN_SYSTEM, ROADMAP, DECISIONS. Method: I cross-checked each ledger recipe by hand for per-currency balance, each invariant against the schema, each acceptance criterion for measurability, and each cross-document reference.

## A. Contradictions found and resolved

| # | Issue | Resolution |
|---|---|---|
| 1 | v1 blueprint blocked market orders on DELAYED data; a delayed-data launch (D-05) could then not trade at all | D-09: execution on delayed data allowed per asset-class flag, always labelled, entitlement stored on each execution |
| 2 | Freshness naming: v1 used `LIVE`; v2 uses `REAL_TIME` | All v2 documents use REAL_TIME / DELAYED / STALE / CLOSED / UNAVAILABLE |
| 3 | DATABASE lot cost comment said "incl. entry fee" but the ledger expenses fees separately (FEES account) | Lot cost excludes fees (D-12); comment fixed; net P&L = gross − fees |
| 4 | Long-only sells had no reservation mechanism (two sells could oversell the same shares) | Added `positions.qty_reserved` + CHECK; invariant I4 extended |
| 5 | I10 (conservation) was stated for USD only and ignored FX_CLEARING | Restated per currency (sum of ledger balances in each currency = 0) |
| 6 | `lot_closures` was not covered by the append-only trigger list | Added |
| 7 | "Day P&L" was required in PRD and designs but never defined | Defined in TRADING_ENGINE §5.2 |
| 8 | Markets overview promised index levels and movers without a licensed source | MARKET_DATA §2.5: ETF proxies labelled as ETFs; bulk-snapshot universe; sector data to P2 |

## B. Accounting checks (verified by hand)

- Golden vector A: −1,919.00 + 1,900.40 + 18.60 = 0 ✓.
- Golden vector B: −3,063.06 + 3,001.50 + 3.0015 + 58.5585 = 0 ✓.
- INR buy: USD legs (−R, +X, +(R−X)) = 0; INR legs (−(Y+f), +Y, +f) = 0 ✓. INR sell: INR legs (−B, +(P−f), +f, −(P−B)) = 0; USD legs (−U, +U) = 0 ✓.
- Golden vector C: trading 11.7622 + FX 0.7122 = 12.4745 = total ✓ (identity holds algebraically: `(P−B)/r_out + B/r_out − B/r_in = P/r_out − B/r_in`).
- Because the DB enforces balance per currency at commit and CASH ≥ 0, an engine bug can fail a transaction but cannot corrupt the books.

## C. Open risks (not resolvable by documentation alone)

| Risk | Severity | What closes it |
|---|---|---|
| **Data licensing**: vendor facts in MARKET_DATA are from general knowledge, unverified; delayed US display rights, crypto venue terms and NSE/BSE redistribution are all unconfirmed | **High (launch blocker)** | Written vendor answers (MARKET_DATA §3) + counsel review |
| Regulatory framing of a trading simulator in India/US, marketing claims, minors | High | Counsel; D-22 age policy |
| Fee/slippage defaults are placeholders, not calibrated to real markets | Medium | Calibrate with historical spreads once data exists; versioned in `fee_schedules` |
| Collar rejects (PRICE_MOVED) may annoy users in volatile crypto | Medium | Tune per class; measure reject rate in beta |
| Delayed-data execution gives users hindsight about price moves (they see a 15-min-old price, real price already differs) | Medium | Labelled; consider adding a "hindsight gap" guard for competitions; competitions only on equal-entitlement data |
| Account-row lock serialisation under bursty users | Low–Medium | Short transactions; per-account queue; load test in E4 |
| Solo-developer capacity vs ~26 weeks to beta | Medium | Strict MVP boundary; consider a second engineer for UI after contract freeze |
| FX modelled spread (D-23) may be criticised as not a tradable rate | Low | Always labelled; replace with vendor bid/ask when licensed |
| Universe-wide movers need REST snapshot budget | Low | Curated universe fallback |

## D. Not yet written (intentionally deferred)

`API_SPEC.md` (generated from Zod contracts in E2–E4), `SECURITY.md`, `TESTING.md` (summaries exist in ARCHITECTURE §7 and TRADING_ENGINE §11; full docs in E0/E2). These were not in the eight requested documents.

## E. Verdict

The specifications are internally consistent after the fixes above and are sufficient to start engineering the ledger and engine immediately. They are **not** sufficient to launch publicly: that requires signed data licences and legal sign-off, which run in parallel (ROADMAP §5).
