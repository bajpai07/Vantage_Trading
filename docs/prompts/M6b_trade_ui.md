# VANTAGE · Claude Code Prompt · M6b — SEARCH, INSTRUMENT PAGE, ORDER TICKET (+ trusted proxy, order preview)

Same standing rules as M0–M6a: native Windows, PowerShell, repo `C:\dev\vantage`, Node 22.19.0, exact dependency versions (verify each on npm, patch at least 2 weeks old), LF endings, no secrets in git or on command lines, specs are the source of truth, stop-and-report on ambiguity, never mark PASS unless you ran it, no push.

## 1. Goal
A user can find a US stock/ETF, see its quote with honest freshness, and place a market BUY/SELL from the web app, safely and clearly. Also fix two blockers found in M6a: shared per-IP rate limits behind the web proxy, and the missing server-side order preview (the browser must do no money arithmetic).

Honesty/safety rules (non-negotiable): all numbers shown come from the API as strings (no browser money math); every quote shows source, freshness badge and as-of time; the FIXTURE banner stays; a disabled Buy/Sell button always says why; the user always sees what they are about to do (side, qty, estimated price, estimated cost/proceeds, fee) before confirming; double-click or retry can never create two orders.

Read first: `docs/phase-reports/M6a-report.md`, `docs/web.md`, `docs/api.md`, `docs/trading.md`, `docs/market-data.md`, DESIGN_SYSTEM (ticket, search, quote components, states), PRD order-ticket/search copy. If specs conflict with this prompt, stop and report.

## 2. Step 0
Ensure `main` contains M6a (if `origin` exists, fetch; diverged → STOP). Branch `phase/m6b-trade-ui`. `pnpm install --frozen-lockfile`, `pnpm db:up`, `pnpm db:migrate`, `pnpm verify` green before changes (stale DB: `pnpm db:reset`).

## 3. Decisions (record as D-69… `APPROVED by founder (M6b)` unless you object with a reason)
- **D-69** Trusted proxy: new API config `TRUSTED_PROXY_CIDRS` (default empty = trust nobody, use the socket address). Only when the socket address is inside the list does the API read the client IP from `X-Forwarded-For` (rightmost untrusted entry). The web proxy route sets the header. Rate limits (login, register, orders) then key on the real client IP (orders stay per user). Never trust the header from other sources. Staging/prod must set it explicitly.
- **D-70** `POST /v1/orders/preview` (auth + CSRF like orders). Same validated body as the order **without** an Idempotency-Key. It runs the same pure `decideMarketOrder` against the current quote, fee schedule, position and cash (one read-only `REPEATABLE READ` transaction, no locks, no writes, nothing stored, not audit-logged as an order). Response: `{ wouldFill, estimatedPrice, estimatedNotional, estimatedFee, estimatedCashAfter | estimatedProceeds, slippageBps, rejectCode?, quote:{bid,ask,asOf,source,freshness}, disclaimer }` as strings. It is advisory only: the real order re-decides. Own rate limit (per user, 60/min).
- **D-71** `referencePrice` sent with an order = the ask (BUY) or bid (SELL) from the **quote shown in the ticket when the user pressed confirm**, taken from the last preview/quote response, never typed by the user. If the order is rejected `PRICE_MOVED`, the ticket shows the new price and asks the user to confirm again (no auto-resubmit).
- **D-72** Idempotency in the UI: one key per ticket attempt, generated with `crypto.randomUUID()` when the user opens the confirm step, kept in memory, **reused on any retry of the same attempt** (network error/timeout/5xx), discarded after a definitive response or when the user edits side/qty/symbol. Submit button is disabled while in flight.
- **D-73** Quote refresh: poll `GET /v1/quotes` for the open instrument every 5 s while visible (config, paused when the tab is hidden, backoff on errors). A quote older than the API's freshness says is shown as STALE and Buy/Sell are disabled with the reason; CLOSED and UNAVAILABLE likewise (reasons from the API's states and reject copy). Nothing is computed from timestamps in the browser except the displayed "x s ago" text.

## 4. Tasks (in order; verify each; commit after each)

**T1 · API: trusted proxy (D-69).** Config + validation (CIDR parsing, startup guard in staging/prod), IP resolution helper (pure, unit-tested incl. spoofed-header cases), wire into the existing limiters, web proxy forwards the client IP. Tests: spoofed `X-Forwarded-For` from an untrusted source is ignored (must fail) / honoured from a trusted proxy (control); two different client IPs behind the proxy don't share a login limit; a lockout of one doesn't affect the other. Update `docs/api.md`, `.env.example`.

**T2 · API: order preview (D-70).** Contract in `@vantage/contracts`, endpoint, tests: preview of the four M4a golden vectors equals what the real order then produces (same price/fee/notional); every reject code is previewed correctly; preview writes nothing (row counts and ledger unchanged, proved by test); another user's data never influences it; preview rate limit; auth/CSRF enforced; concurrent preview + real orders never deadlock or block orders (no locks taken).

**T3 · Web: search and instrument page.**
- Header search box (debounced, keyboard friendly `/` to focus, up/down/enter, escape), calls `/v1/instruments/search`, shows symbol, name, exchange, type, status badges; empty/no-result/error states; zero results never looks like an error.
- `/instruments/[symbol]`: name, symbol, exchange, status (HALTED/SELL_ONLY/DELISTED clearly explained), quote panel (bid, ask, last, spread shown as strings from the API, freshness badge, source, as-of "x s ago", market open/closed + next open from `/v1/market/status`), your position in this symbol (from `/v1/positions`), recent orders for the symbol. Unknown symbol → 404 page.

**T4 · Web: order ticket.**
- Side toggle (Buy/Sell), integer quantity field (digits only, max from contracts, no decimals/exponents/negatives), market order only.
- Live preview via D-70 (debounced on qty/side change; shows loading/stale state; estimated price, notional/proceeds, fee, cash after; labelled "Estimate — final price is decided when the order executes").
- Review → Confirm step, then result card: FILLED (price, qty, fee, cash after, link to order) or REJECTED (plain-language reason from `reject-copy.ts`, nothing changed). Network error/timeout: "We couldn't confirm — retry safely" using the same key (D-72), and a link to check `/orders`. 401 → login with return-to; 429 → retry hint.
- Disabled states with reason: no qty, qty too large for cash (from preview `rejectCode`), SELL with no position, market closed/stale/unavailable, halted/sell-only/not tradable, trading paused, submit in flight.
- After a fill: portfolio, orders and position panels refresh without a full reload.
- Responsive to 375 px, keyboard-operable (Enter on confirm, focus management on dialog open/close, `aria-live` for results), reduced motion respected, colour never the only signal.

**T5 · Tests.**
Unit: ticket state machine (idle → previewing → review → submitting → filled/rejected/error; key lifecycle per D-72: new key per attempt, reuse on retry, discard on edit), quantity input sanitising, disabled-reason mapping covers every API state/reject code (exhaustive against contracts), no money arithmetic in new web files (existing lint ban applies), quote polling pauses when hidden. Also add the missing **loading, load-error and error-boundary tests** from M6a (turns criterion 10 into PASS).
E2E (Playwright, real API + Postgres + FIXTURE):
1. Search "AAPL" → open → buy 10 → estimate then fill; cash 8,099.60 and the position are shown exactly (vector A), reconcile clean via a test helper.
2. Sell part then all → realised P&L matches the API/ledger strings.
3. Double-click Confirm, and 50 rapid clicks → exactly one order.
4. Network failure injected (route abort after request is sent) → retry reuses the key → exactly one order exists.
5. Edit quantity during review → new key (a different order is possible), no stale estimate is submitted.
6. STALE / CLOSED / UNAVAILABLE / HALTED / SELL_ONLY: buttons disabled with the right reason; control: ACTIVE open instrument enabled.
7. Insufficient funds and sell-more-than-held: disabled reason shown; forced via API they are REJECTED with the right copy and no money moves.
8. `PRICE_MOVED`: quote moved between preview and confirm → rejected message + new price + re-confirm required.
9. Two users: B can't see or affect A's orders; shared-IP login limits don't cross users (T1) through the real proxy.
10. axe on search, instrument page, ticket (all steps); keyboard-only buy from search to filled.
11. Security: CSP unchanged and violation-free, no tokens in storage, no console errors.
- Done when: `pnpm verify` green; `pnpm test:integration` green twice; e2e green locally; no leftover `t_*` DBs.

**T6 · Docs.** `docs/web.md` (screens, ticket flow, D-72 key lifecycle), `docs/api.md` (preview endpoint, trusted proxy), `docs/trading.md` (preview is advisory), append D-69..D-73 to `docs/specs/DECISIONS.md` (zero deletions).

## 5. Out of scope
Watchlist UI, limit/stop orders, fractional shares, price charts/candles (need M3b data), WebSocket/streaming, left rail/terminal grid redesign, terms/legal pages and email flows (M8), CI/GitHub push, real provider (M3b), mobile cards for tables.

## 6. Common mistakes
Computing price/cost/fees in the browser; letting the user type `referencePrice`; a new idempotency key on every click or retry; auto-resubmitting after `PRICE_MOVED`; enabling Confirm during an in-flight request; trusting `X-Forwarded-For` from any source; preview that takes locks or writes; a preview that uses different rules from the real order; swallowing a network error as "success"; disabled button with no reason; showing a fill as certain before the API answers; stale quote shown as live.

## 7. Verification (clean clone of the branch)
```powershell
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate ; pnpm db:migrate ; pnpm db:status
pnpm verify
pnpm test:integration          # second consecutive run
pnpm --filter web build
pnpm --filter web test:e2e
node apps/api/dist/main.js --check
pnpm db:down
```

## 8. Acceptance criteria (PASS / FAIL / UNVERIFIED, each run)
1. Step 0 baseline green. 2. Trusted proxy: spoof ignored, trusted honoured, per-client limits independent (through the real web proxy). 3. Preview equals real execution for all golden vectors and every reject code; writes nothing; takes no locks. 4. Search and instrument page with honest quote states. 5. Ticket flow end to end; vector A through the UI exact. 6. Double-click/50-click and network-retry produce exactly one order. 7. Edit-after-review issues a fresh key and fresh estimate. 8. All disabled states show their reason; controls enabled. 9. PRICE_MOVED handled without auto-resubmit. 10. No browser money arithmetic (lint + tests). 11. axe clean and keyboard-only purchase works; 375 px layout checked. 12. M6a's loading/error/boundary tests added (criterion 10 of M6a now PASS). 13. `pnpm verify` green, integration green twice, e2e green, no leftover DBs. 14. Docs and D-69..D-73 appended, zero deletions.

## 9. Final report (`docs/phase-reports/M6b-report.md`, print the FULL report in the reply)
1. Status: READY / READY WITH CAVEATS / NOT READY for M6c or M7 (≤ 5 lines). 2. Dependency changes (exact versions, why). 3. Task status T1–T6. 4. Files created/modified. 5. Commands with exit codes; failing output verbatim. 6. Acceptance table with evidence (screenshots under `docs/phase-reports/m6b/`). 7. Test list with controls. 8. Deviations, spec questions. 9. Known limitations and what comes next (watchlists, charts, M3b, M8 checklist).

Do not start the next phase. Stop after the report.
