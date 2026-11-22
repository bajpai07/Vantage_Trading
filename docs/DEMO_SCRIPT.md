# Demo script

A talk track for showing VANTAGE to an interviewer. Every claim here is the same as in [FACTS.md](FACTS.md); if you are unsure of a number, read it from there rather than from memory. The one rule: say plainly that the money is virtual and the prices are simulated, before anyone has to ask.

## Before you start

- Start the stack (compose is the quickest): `pnpm compose:setup` once, then `docker compose --env-file .env.compose up --build`, and open http://localhost:3000 ([DOCKER.md](DOCKER.md)). The "Try the demo" button is on in that stack.
- Or use the developer stack: `pnpm db:up`, `pnpm db:migrate`, `pnpm build`, the API with `MARKET_DATA_SOURCE=SIM`, `CRYPTO_FEED=sim`, `DEMO_MODE=true`, `SIM_SESSION=ALWAYS_OPEN`, `MATCHER=on`, and the web app with `DEMO_ACCOUNTS=on` (`pnpm --filter web dev`).
- Wake a hosted demo once before the call (free hosts sleep; see [DEPLOY.md](DEPLOY.md)).
- To film it: `pnpm demo:record` (see the last section). To give a second account some history: `DEMO_SEED_PASSWORD=... pnpm demo:seed you@example.com`.

## The 3-minute version

| Time | Click                                         | Say                                                                                                                                                                                                |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Open **/about**, scroll once                  | "This is a trading simulator. The money is virtual and the prices are simulated, and the app says so on every page. This page explains the execution model and what I deliberately did not build." |
| 0:30 | **Login**, press **Try the demo**             | "A temporary account with a random password I never see. It starts with $10,000 of virtual cash, shown here as a string the server computed."                                                      |
| 0:50 | Open the **watchlist**, then **BTC-USD**      | "Prices come from a seeded generator, labelled SIM. The same seed gives the same prices."                                                                                                          |
| 1:10 | Switch the candle interval                    | "Candles are a deterministic function of the seed. Closed candles never change."                                                                                                                   |
| 1:25 | Point at the **depth book**                   | "The book is synthetic and says so. It is informational: fills use the execution model, not the book."                                                                                             |
| 1:45 | **Buy 0.0025 BTC**, review, confirm           | "A fractional market buy. The review shows the exact fill, the fee and my cash after. All of these are exact decimals; there are no floats anywhere in the money path."                            |
| 2:15 | Place a **limit buy** about 3 % below the bid | "It does not fill, so it rests. The cash is reserved, it shows in the book as my order and under Open orders."                                                                                     |
| 2:35 | **Cancel** it                                 | "Cancel releases exactly what was reserved."                                                                                                                                                       |
| 2:50 | Open **Portfolio**, then **Orders**           | "Cash, reserved, cost basis, fees and equity add up exactly, and every order is in the history."                                                                                                   |

## The 7-minute version

Use the 3-minute path, and add these, in this order, where they fit:

1. **After the buy, open Portfolio and expand "Exact amounts".** "Cash plus reserved plus cost basis plus fees minus realised profit equals the starting $10,000, to the last digit. That identity is checked by a test on every run."
2. **Double-click Confirm on a limit order** (use a fresh one). "One order, not two. Every order has an idempotency key; a retry or a double click returns the stored result."
3. **Show the second limit lifecycle.** Place a limit BUY slightly below the bid, wait, and cancel. "While it rests, the cash is reserved and the equity does not change."
4. **Open the shortcuts (`?`).** "Keyboard-first on the terminal: `b` and `s` switch side, `[` and `]` move the interval."
5. **Show the phone layout** (resize to 390 px or use the recording). "Same app and same numbers, with a bottom-sheet ticket."
6. **Open the repository.** README, then [ARCHITECTURE_DIAGRAMS.md](ARCHITECTURE_DIAGRAMS.md) (the limit buy sequence), then [FACTS.md](FACTS.md) (the numbers and the bugs the tests found).

## If asked X, show Y

| If they ask about                    | Show                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "How do you know the books balance?" | **Portfolio**, "Exact amounts" and the identity line. Then the ledger diagram in [ARCHITECTURE_DIAGRAMS.md](ARCHITECTURE_DIAGRAMS.md): every transaction sums to zero and rows are append-only (database triggers). `reconcileAccount` checks invariants I1 to I7 and I10 (FACTS section 2.4).                                           |
| "What stops a double order?"         | Double-click **Confirm** on a limit order and open **Orders**: one row. FACTS section 2.3: 50 parallel identical requests give 1 order and 1 execution; 100 duplicate accepts give one order and one reserve.                                                                                                                            |
| "What about concurrency?"            | The lock-order diagram (every path locks the account row first). FACTS section 2.3: 50 parallel buys on one account gave exactly 24 fills and 26 rejects; the cancel-versus-fill race ran 1,000 iterations per run with exactly one outcome each time. Test names: `trading-concurrency`, `orders-concurrency`, `portfolio-consistency`. |
| "Are the prices real?"               | The banner ("Simulated market data, not real prices") and the **/about** page. Say it first; do not wait to be asked.                                                                                                                                                                                                                    |
| "How fast is it?"                    | FACTS section 2.2, with its caveats: a fractional market order measured p50 33.4 ms and p95 38.5 ms over real HTTP and Postgres on a noisy Windows laptop; not a production benchmark.                                                                                                                                                   |
| "What did the tests catch?"          | FACTS section 4 (a migration that failed only with existing rows, a CSP violation from a schema library, accessibility defects found by axe).                                                                                                                                                                                            |
| "What is not built?"                 | **/about**, "What is deliberately not built", and FACTS section 5: no real money, no margin or shorting, no stop orders, no partial fills, one API instance, nothing verified on real phones.                                                                                                                                            |
| "Could this go live?"                | No: it is a simulator. [DEPLOY.md](DEPLOY.md) lists what a hosted demo needs and what is unverified. Email verification, multi-factor sign-in and legal pages do not exist (FACTS section 6).                                                                                                                                            |

## Do not say

- Do not call the prices "market data" without "simulated".
- Do not quote latency or test counts that are not in FACTS.
- Do not say it handles real users or real money. Do not say "production-ready".

## Recording the walkthrough (`pnpm demo:record`)

`pnpm demo:record` films the walkthrough above against a stack that is **already running** (it starts nothing). It records two `.webm` videos, desktop (1440 by 900) and phone (390 by 844), into `demo-videos/` at the repository root, which git ignores. Only the script is committed.

```powershell
# against the compose stack on http://localhost:3000 (the default)
pnpm demo:record

# against another address, with a slower pace (milliseconds between steps)
$env:DEMO_BASE_URL = "http://localhost:3000"; $env:DEMO_PACE_MS = "1800"; pnpm demo:record
```

Against the local developer stack, start the API and the web app first (see "Before you start") with `DEMO_ACCOUNTS=on`. The recording creates a fresh demo account each time, and those accounts are never deleted. The steps are in `apps/web/demo/record.spec.ts`; the project names (`demo-desktop`, `demo-phone`) are separate from the normal end-to-end projects, and `pnpm --filter web test:e2e` never runs them.
